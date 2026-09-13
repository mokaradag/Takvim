import { describeReminderSchedule } from '../../../../../domain/reminders/reminderPolicy.js';
import { REMINDER_PLACEHOLDERS } from '../../../../../domain/reminders/reminderTemplate.js';
import { loadAuthorizationContext } from '../../../../../server/authorization/loadAuthorizationContext.js';
import { getSqlPool } from '../../../../../server/db/pool.js';
import { safeErrorResponse, ServerPersistenceError } from '../../../../../server/errors.js';
import { withRouteObservability } from '../../../../../server/observability/observeOperation.js';
import { assertReminderAdmin } from '../../../../../server/reminders/reminderAccess.js';
import { isSmtpConfigured } from '../../../../../server/mail/smtpConfig.js';
import {
  loadReminderHistory,
  loadReminderSettings,
  saveReminderSettings
} from '../../../../../server/reminders/reminderStore.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Hatırlatma yapılandırması — YALNIZCA sistem yöneticisi.
 *
 * Yetki gezinme öğesini gizlemekle sağlanmaz: bu uç, oturumdan türetilen
 * yetkiyi her istekte yeniden denetler. SMTP kullanıcı adı/parolası hiçbir
 * yanıtta yer almaz; yalnızca "yapılandırıldı mı" bilgisi döner.
 */
function settingsResponse(settings, history) {
  return {
    settings: {
      automaticEnabled: settings.automaticEnabled,
      windowValue: settings.windowValue,
      windowUnit: settings.windowUnit,
      frequencyValue: settings.frequencyValue,
      frequencyUnit: settings.frequencyUnit,
      subject: settings.subject,
      body: settings.body,
      updatedAt: settings.updatedAt,
      updatedBySicil: settings.updatedBySicil,
      // Satır sürümü düzenleyiciye kadar taşınır ve kaydederken geri gelir:
      // iki yöneticinin aynı şablonu ayrı ayrı kaydetmesi sessiz kayıp üretmez.
      rowVersion: settings.rowVersion ?? null
    },
    summary: describeReminderSchedule(settings),
    placeholders: REMINDER_PLACEHOLDERS,
    smtpConfigured: isSmtpConfigured(),
    schemaReady: settings.schemaReady !== false,
    history
  };
}

async function handleLoadReminderSettings() {
  try {
    const pool = await getSqlPool();
    const actor = await loadAuthorizationContext(pool);
    assertReminderAdmin(actor);
    const settings = await loadReminderSettings(pool);
    return Response.json(settingsResponse(settings, await loadReminderHistory(pool, 20)), {
      headers: { 'cache-control': 'no-store' }
    });
  } catch (error) {
    return safeErrorResponse(error);
  }
}

async function handleSaveReminderSettings(request) {
  try {
    const pool = await getSqlPool();
    const actor = await loadAuthorizationContext(pool);
    assertReminderAdmin(actor);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Geçerli bir yapılandırma gönderilmelidir.', { status: 400 });
    }
    const saved = await saveReminderSettings(pool, actor.sicil, body);
    const settings = await loadReminderSettings(pool);
    return Response.json(
      { ...settingsResponse(settings, await loadReminderHistory(pool, 20)), saved: true, appliedSubject: saved.subject },
      { headers: { 'cache-control': 'no-store' } }
    );
  } catch (error) {
    return safeErrorResponse(error);
  }
}

// Ölçüm sarmalayıcısı imzayı ve yanıtı DEĞİŞTİRMEZ; yalnızca süreyi, sonucu ve
// ilişkilendirme kimliğini kaydeder (bkz. server/observability).
export const GET = withRouteObservability('api.admin.reminder-settings', handleLoadReminderSettings);
export const PUT = withRouteObservability('api.admin.reminder-settings.save', handleSaveReminderSettings);
