import { extractActualId } from '../../../../../../domain/identity/actualId.js';
import { loadAuthorizationContext } from '../../../../../../server/authorization/loadAuthorizationContext.js';
import { getSqlPool } from '../../../../../../server/db/pool.js';
import { safeErrorResponse, ServerPersistenceError } from '../../../../../../server/errors.js';
import { assertTaskReminderAccess } from '../../../../../../server/reminders/reminderAccess.js';
import { sendManualReminder } from '../../../../../../server/reminders/reminderService.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * ELLE hatırlatma gönderimi.
 *
 * Alıcılar YALNIZCA görevin kendisinden türetilir. İstek gövdesinden alıcı
 * kabul edilseydi bu uç açık bir posta rölesine dönüşürdü; bu yüzden gövde hiç
 * okunmaz. Görev kimliği yol parametresinden gelir, sunucuda doğrulanır ve
 * kullanıcının o görevi GÖRÜP GÖRMEDİĞİ ayrıca denetlenir.
 *
 * Otomatik hatırlatma kapalı olsa da bu uç çalışır.
 */
export async function POST(_request, context) {
  try {
    const rawTaskId = (await context?.params)?.taskId;
    // Gerçek kipte YENİ oluşturulan görevler `task-<uuid>` istemci takma adını
    // korur ve arayüz `task.id` değerini olduğu gibi yollar. Yalnızca çıplak
    // GUID kabul edilseydi, kalıcılık yolunun sorunsuz yazdığı bir görev için
    // hatırlatma ucu 400 dönerdi.
    const taskId = extractActualId(rawTaskId);
    if (!taskId) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Geçerli bir görev kimliği gereklidir.', { status: 400 });
    }

    const pool = await getSqlPool();
    const actor = await loadAuthorizationContext(pool);
    await assertTaskReminderAccess(pool, actor, taskId);

    const result = await sendManualReminder(pool, {
      taskId,
      actorSicil: actor.sicil,
      // Yetki, GÖNDERİME GİRECEK satır yüklendikten sonra yeniden doğrulanır:
      // görev iki sorgu arasında taşınmış ya da yeniden atanmış olabilir.
      authorize: (task) => assertTaskReminderAccess(pool, actor, task.id)
    });
    if (!result.ok) {
      return Response.json({
        error: { code: result.code, message: result.message, details: null }
      }, { status: result.code === 'TASK_NOT_FOUND' ? 404 : 422, headers: { 'cache-control': 'no-store' } });
    }
    return Response.json({
      ok: true,
      recipientCount: result.recipientCount,
      message: result.message,
      // Adres çözülemeyen sorumlular kullanıcıya AÇIKÇA bildirilir; ne e-posta
      // adresi ne de KİMLİK taşınır. Ayrıntılı iletiler kapsam dışı bir eş
      // sorumlunun adını içerdiği için yalnızca sayı ve neden döner (PARTIAL
      // anlık görüntü o kimliği bilinçli olarak gizler).
      warnings: result.warnings || []
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return safeErrorResponse(error);
  }
}
