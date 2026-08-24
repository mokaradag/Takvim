import { loadAuthorizationContext } from '../../../../../server/authorization/loadAuthorizationContext.js';
import { getSqlPool } from '../../../../../server/db/pool.js';
import { safeErrorResponse, ServerPersistenceError } from '../../../../../server/errors.js';
import { hasReminderSchedulerKey } from '../../../../../server/reminders/reminderAccess.js';
import { runAutomaticReminders } from '../../../../../server/reminders/reminderService.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Otomatik hatırlatma turu.
 *
 * Tur SUNUCU TARAFINDA çalışır ve açık bir tarayıcı gerektirmez: uç, işletim
 * sisteminin zamanlayıcısından (Windows Görev Zamanlayıcı / cron) düzenli
 * aralıklarla çağrılır. Uygulama zaten Next.js sunucusu olarak çalıştığı için
 * ayrı bir kuyruk altyapısı eklenmez.
 *
 * Yetki iki yoldan biriyle verilir:
 *  - `x-mergen-rota-reminder-key` başlığı `MERGEN_ROTA_REMINDER_CRON_SECRET`
 *    ile eşleşir (zamanlayıcı yolu), ya da
 *  - istek, oturum açmış bir SYSTEM_ADMIN kullanıcıdan gelir (elle deneme).
 *
 * Turun sık çalışması güvenlidir: aynı hatırlatma aralığı için ikinci ileti
 * gönderilmez (bkz. reminderPolicy · aralık anahtarı ve MR_TaskReminderLog
 * üzerindeki benzersiz dizin).
 */
export async function POST(request) {
  try {
    const pool = await getSqlPool();
    let actorSicil = null;

    if (!hasReminderSchedulerKey(request)) {
      const actor = await loadAuthorizationContext(pool);
      if (!actor.isSystemAdmin) {
        throw new ServerPersistenceError('FORBIDDEN', 'Otomatik hatırlatma turu yalnızca zamanlayıcı anahtarıyla ya da sistem yöneticisiyle çalıştırılabilir.');
      }
      actorSicil = actor.sicil;
    }

    const summary = await runAutomaticReminders(pool, { actorSicil });
    // Tur BAŞLAYAMADIYSA durum kodu da bunu söyler. İşletim sistemi
    // zamanlayıcısı yalnızca HTTP durumuna (ya da `curl` çıkış koduna) bakar;
    // her koşulda 200 dönmek, hatırlatmalar tamamen dururken çalıştırmayı
    // başarılı gösteriyordu.
    return Response.json(summary, {
      status: summary.ok === false ? 503 : 200,
      headers: { 'cache-control': 'no-store' }
    });
  } catch (error) {
    return safeErrorResponse(error);
  }
}
