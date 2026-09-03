import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { sql } from '../db/pool.js';
import { ServerPersistenceError } from '../errors.js';

/**
 * Hatırlatma uçlarının yetkilendirmesi.
 *
 * Üç ayrı karar vardır ve hiçbiri istemciye bırakılmaz:
 *  1. **Elle gönderim** — kullanıcı görevi GÖRÜYORSA hatırlatma gönderebilir.
 *     Görünürlük kuralı anlık görüntüyle birebir aynıdır (tam proje yetkisi,
 *     kendi görevi ya da astına atanmış görev).
 *  2. **Yapılandırma** — yalnızca `MR_UserRoles` üzerinden SYSTEM_ADMIN.
 *  3. **Zamanlayıcı** — sunucu tarafı gizli anahtar ya da SYSTEM_ADMIN oturumu.
 */

/**
 * Kullanıcı bu görevi görüyor mu?
 *
 * Sorgu, anlık görüntüdeki görev görünürlüğüyle AYNI kuralı uygular:
 *  - kurumsal proje erişimi (FULL) — `MR_V_CorporateProjectAccess` YALNIZCA
 *    `SourceType = 'CORPORATE'` projelerde geçerlidir: iki görünüm farklı
 *    kurumsal kaynaklardan beslendiği için, kodu HR09'da bulunan bir MANUEL
 *    proje aksi hâlde göremeyen kişilere hatırlatma yetkisi verirdi,
 *  - etkin manuel projenin sorumlusu olmak (FULL),
 *  - elle verilmiş `MR_ProjectAccess` yetkisi YALNIZCA `FULL`/`READ` ise
 *    proje geneli görev görünürlüğü sayılır — `PARTIAL` yetki anlık görüntüde
 *    görev kapsamlıdır ve tek başına başkasının görevine posta göndermeye
 *    yetmemelidir,
 *  - görevi oluşturmuş olmak,
 *  - görevin kendisine ya da yöneticinin kapsamındaki bir çalışana atanmış
 *    olması.
 *
 * Görev atama kapsamı burada YETKİ VERMEZ: yönetici, göremediği bir görevin
 * sorumlularına posta gönderemez.
 *
 * Sistem yöneticisi kullanıcı bazlı yetki denetimlerini atlar ama proje ETKİN
 * olmalıdır: etkin olmayan projeler anlık görüntülerin tamamından dışlanır ve
 * yöneticinin etkin FULL yetkileri de yalnızca etkin projelerden kurulur.
 */
export async function assertTaskReminderAccess(executor, actor, taskId) {
  const request = executor.request();
  request.input('taskId', sql.UniqueIdentifier, taskId);
  request.input('sicil', sql.Int, actor.sicil);
  request.input('isAdmin', sql.Bit, Boolean(actor?.isSystemAdmin));
  const result = await request.query(`
    SELECT TOP (1) t.TaskId
    FROM dbo.MR_Tasks t
    JOIN dbo.MR_Projects p ON p.ProjectId = t.ProjectId AND p.IsActive = 1
    WHERE t.TaskId = @taskId
      AND (
        @isAdmin = 1
        OR EXISTS (
          SELECT 1
          FROM dbo.MR_V_CorporateProjectAccess a
          WHERE p.SourceType = 'CORPORATE' AND a.ProjectCode = UPPER(p.ProjectCode) AND a.Sicil = @sicil
        )
        OR (p.SourceType = 'MANUAL' AND p.LeadSicil = @sicil)
        OR t.CreatedBySicil = @sicil
        OR EXISTS (
          SELECT 1 FROM dbo.MR_ProjectAccess pa
          WHERE pa.ProjectId = t.ProjectId AND pa.Sicil = @sicil AND pa.IsActive = 1
            AND pa.AccessLevel IN ('FULL', 'READ')
        )
        OR EXISTS (
          SELECT 1 FROM dbo.MR_TaskAssignees ta
          WHERE ta.TaskId = t.TaskId
            AND (
              ta.Sicil = @sicil
              OR EXISTS (
                SELECT 1 FROM dbo.MR_V_ExecutiveScope es
                WHERE es.ManagerSicil = @sicil AND es.EmployeeSicil = ta.Sicil
              )
            )
        )
      );
  `);
  if (!result.recordset.length) {
    throw new ServerPersistenceError('FORBIDDEN', 'Bu görev için hatırlatma gönderme yetkiniz yok.');
  }
}

/** Yapılandırma okuma/yazma yalnızca sistem yöneticisine açıktır. */
export function assertReminderAdmin(actor) {
  if (!actor?.isSystemAdmin) {
    throw new ServerPersistenceError('FORBIDDEN', 'Hatırlatma yapılandırması yalnızca sistem yöneticileri tarafından görüntülenip değiştirilebilir.');
  }
}

function safeEquals(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8');
  const b = Buffer.from(String(right ?? ''), 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/**
 * Zamanlayıcı anahtarını doğrular.
 *
 * Anahtar yapılandırılmamışsa uç YALNIZCA sistem yöneticisi oturumuyla
 * çalıştırılabilir; hiçbir koşulda kimliksiz erişime açılmaz.
 */
export function hasReminderSchedulerKey(request) {
  const configured = String(process.env.MERGEN_ROTA_REMINDER_CRON_SECRET ?? '').trim();
  if (!configured) return false;
  const provided = request?.headers?.get?.('x-mergen-rota-reminder-key') || '';
  return safeEquals(configured, provided);
}
