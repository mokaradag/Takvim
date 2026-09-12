import { safeErrorResponse, ServerPersistenceError } from '../../../../../../server/errors.js';
import { loadSystemAdminContext } from '../../../../../../server/observability/adminRequestContext.js';
import { withRouteObservability } from '../../../../../../server/observability/observeOperation.js';
import {
  acknowledgeOperationalAlert,
  loadOperationalAlerts,
  loadOperationalEvents
} from '../../../../../../server/observability/operationalEventsRepository.js';
import { recentFeed } from '../../../../../../server/observability/telemetryRegistry.js';
import {
  COMPONENTS,
  COMPONENT_LABELS,
  EVENT_CODES,
  SEVERITY_LABELS,
  isEventSeverity
} from '../../../../../../domain/observability/eventModel.js';
import { timeRange } from '../../../../../../domain/observability/metrics.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const EVENT_CODE_LIST = Object.keys(EVENT_CODES);

function safeComponent(value) {
  const text = String(value ?? '').trim().toUpperCase();
  return Object.hasOwn(COMPONENTS, text) ? text : null;
}

function safeCode(value) {
  const text = String(value ?? '').trim().toUpperCase();
  return EVENT_CODE_LIST.includes(text) ? text : null;
}

/**
 * Sistem Yönetimi · Hatalar ve Olaylar.
 *
 * Ham günlük değil YAPILANDIRILMIŞ olay gezgini: süzgeçler kapalı listeden
 * seçilir, sayfa boyutu sunucuda sınırlanır ve yinelenen olaylar yazılırken
 * zaten tek satırda toplanmıştır.
 */
export const GET = withRouteObservability('api.admin.system.events', async (request) => {
  try {
    const { pool } = await loadSystemAdminContext();
    const url = new URL(request.url, 'http://mergen-rota.invalid');
    const range = timeRange(url.searchParams.get('range'));
    const since = new Date(Date.now() - range.durationMs);
    const severityParam = String(url.searchParams.get('severity') || '').trim().toUpperCase();
    const stateParam = String(url.searchParams.get('state') || '').trim().toLowerCase();

    const [events, alerts] = await Promise.all([
      loadOperationalEvents(pool, {
        since,
        severity: isEventSeverity(severityParam) ? severityParam : null,
        component: safeComponent(url.searchParams.get('component')),
        code: safeCode(url.searchParams.get('code')),
        search: url.searchParams.get('search'),
        offset: Number(url.searchParams.get('offset') || 0),
        limit: Number(url.searchParams.get('limit') || 25)
      }),
      loadOperationalAlerts(pool, {
        activeOnly: stateParam !== 'all',
        component: safeComponent(url.searchParams.get('component')),
        since,
        limit: 100
      })
    ]);

    return Response.json({
      ok: true,
      range: { id: range.id, label: range.label, durationMs: range.durationMs },
      schemaReady: events.schemaReady && alerts.schemaReady,
      total: events.total,
      offset: events.offset,
      limit: events.limit,
      events: events.events,
      alerts: alerts.alerts,
      // Süreç belleğindeki akış, kalıcılaştırma turu beklenmeden "az önce ne
      // oldu" sorusunu yanıtlar.
      feed: recentFeed(20),
      filters: {
        severities: Object.entries(SEVERITY_LABELS).map(([id, label]) => ({ id, label })),
        components: Object.entries(COMPONENT_LABELS).map(([id, label]) => ({ id, label })),
        codes: EVENT_CODE_LIST.map((code) => ({ id: code, label: EVENT_CODES[code].summary }))
      }
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return safeErrorResponse(error);
  }
});

/**
 * Uyarı onaylama.
 *
 * Onay yalnızca AÇIK bir uyarıyı kapsar ve koşulu çözmez: sorun sürüyorsa
 * uyarı "Onaylandı" durumunda kalır, sayaç ilerlemeye devam eder. Çözme
 * kararını yalnızca sağlık değerlendirmesi verir.
 */
export const POST = withRouteObservability('api.admin.system.events.acknowledge', async (request) => {
  try {
    const { pool, actor } = await loadSystemAdminContext();
    const body = await request.json().catch(() => null);
    if (String(body?.action || '') !== 'acknowledge') {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Tanınmayan uyarı eylemi.', { status: 400 });
    }
    const alertId = Number(body?.alertId);
    if (!Number.isSafeInteger(alertId) || alertId <= 0) {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Geçerli bir uyarı seçilmedi.', { status: 400 });
    }
    const outcome = await acknowledgeOperationalAlert(pool, { alertId, actorSicil: actor.sicil });
    return Response.json({
      ok: true,
      acknowledged: outcome.acknowledged,
      state: outcome.state,
      message: outcome.acknowledged
        ? 'Uyarı onaylandı. Koşul sürdüğü sürece uyarı açık kalmaya devam eder.'
        : 'Uyarı zaten onaylanmış ya da çözülmüş.'
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return safeErrorResponse(error);
  }
});
