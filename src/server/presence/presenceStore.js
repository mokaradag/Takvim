import 'server-only';
import {
  PRESENCE_ACTIVE_WINDOW_MS,
  PRESENCE_LIST_LIMIT,
  PRESENCE_RECENT_WINDOW_MS,
  PRESENCE_SESSION_GAP_MS
} from '../../domain/presence/presenceModel.js';
import { getSqlPool, sql } from '../db/pool.js';
import { loadAuthorizationContext } from '../authorization/loadAuthorizationContext.js';
import { assertSystemAdmin } from '../authorization/authorization.js';

/**
 * Kullanıcı varlığının kalıcılığı.
 *
 * Sicil başına TEK satır tutulur: sekme sayısı, istek sayısı ve uygulama örneği
 * sayısı tablo boyutunu büyütmez. İstek düzeyinde telemetri satırı YAZILMAZ.
 */

const MISSING_TABLE_NUMBERS = new Set([208, 4145]);

export function isMissingPresenceSchema(error) {
  return MISSING_TABLE_NUMBERS.has(Number(error?.number))
    && String(error?.message || '').includes('MR_UserPresence');
}

/**
 * Nabzı işler.
 *
 * Uzun sessizlikten sonraki nabız YENİ oturum başlatır; böylece "aktif olduğu
 * süre" gerçekten kesintisiz süredir.
 */
export async function recordPresenceHeartbeat(executor, sicil) {
  const request = executor.request();
  request.input('sicil', sql.Int, Number(sicil));
  request.input('gapSeconds', sql.Int, Math.round(PRESENCE_SESSION_GAP_MS / 1000));
  const result = await request.query(`
    UPDATE dbo.MR_UserPresence WITH (UPDLOCK, HOLDLOCK)
    SET SessionStartedAt = CASE
          WHEN DATEDIFF(second, LastSeenAt, SYSUTCDATETIME()) > @gapSeconds
          THEN SYSUTCDATETIME() ELSE SessionStartedAt END,
        LastSeenAt = SYSUTCDATETIME()
    WHERE Sicil = @sicil;
    IF @@ROWCOUNT = 0
      INSERT dbo.MR_UserPresence(Sicil, FirstSeenAt, SessionStartedAt, LastSeenAt)
      VALUES(@sicil, SYSUTCDATETIME(), SYSUTCDATETIME(), SYSUTCDATETIME());

    SELECT TOP (1) FirstSeenAt, SessionStartedAt, LastSeenAt
    FROM dbo.MR_UserPresence WHERE Sicil = @sicil;
  `);
  const row = (result.recordsets?.[result.recordsets.length - 1] || [])[0] || {};
  return {
    firstSeenAt: row.FirstSeenAt ? new Date(row.FirstSeenAt).toISOString() : null,
    sessionStartedAt: row.SessionStartedAt ? new Date(row.SessionStartedAt).toISOString() : null,
    lastSeenAt: row.LastSeenAt ? new Date(row.LastSeenAt).toISOString() : null
  };
}

/** Oturum kullanıcısının nabzı. Yetki oturumdan türetilir, istemciden alınmaz. */
export async function submitPresenceHeartbeat() {
  const pool = await getSqlPool();
  const actor = await loadAuthorizationContext(pool);
  try {
    const presence = await recordPresenceHeartbeat(pool, actor.sicil);
    return { ok: true, ...presence };
  } catch (error) {
    // Göç uygulanmadan açılan kurulumda nabız sessizce atlanır; uygulama
    // kullanılabilir kalır.
    if (isMissingPresenceSchema(error)) return { ok: true, enabled: false };
    throw error;
  }
}

function presenceRow(row) {
  return {
    sicil: String(row.Sicil),
    name: row.DisplayName || String(row.Sicil),
    directorate: row.Directorate || null,
    department: row.Department || null,
    unit: row.Unit || null,
    sessionStartedAt: row.SessionStartedAt ? new Date(row.SessionStartedAt).toISOString() : null,
    firstSeenAt: row.FirstSeenAt ? new Date(row.FirstSeenAt).toISOString() : null,
    lastSeenAt: row.LastSeenAt ? new Date(row.LastSeenAt).toISOString() : null
  };
}

/**
 * Aktif kullanıcılar ve KPI toplamları — YALNIZCA sistem yöneticisi.
 *
 * Yetki burada bağımsız olarak yeniden denetlenir; gezinmeyi gizlemek sınır
 * değildir. Sorgu dizinlidir (`IX_MR_UserPresence_LastSeenAt`) ve satır sayısı
 * sınırlıdır.
 */
export async function loadActiveUsers() {
  const pool = await getSqlPool();
  const actor = await loadAuthorizationContext(pool);
  assertSystemAdmin(actor);
  const activeSeconds = Math.round(PRESENCE_ACTIVE_WINDOW_MS / 1000);
  const recentSeconds = Math.round(PRESENCE_RECENT_WINDOW_MS / 1000);
  try {
    const request = pool.request();
    request.input('activeSeconds', sql.Int, activeSeconds);
    request.input('recentSeconds', sql.Int, recentSeconds);
    request.input('limit', sql.Int, PRESENCE_LIST_LIMIT);
    const result = await request.query(`
      SELECT
        COUNT(CASE WHEN DATEDIFF(second, LastSeenAt, SYSUTCDATETIME()) <= @activeSeconds THEN 1 END) AS ActiveCount,
        COUNT(CASE WHEN DATEDIFF(second, LastSeenAt, SYSUTCDATETIME()) <= @recentSeconds THEN 1 END) AS RecentCount
      FROM dbo.MR_UserPresence;

      SELECT TOP (@limit) p.Sicil, p.FirstSeenAt, p.SessionStartedAt, p.LastSeenAt,
        pd.DisplayName, pd.Directorate, pd.Department, pd.Unit
      FROM dbo.MR_UserPresence p
      LEFT JOIN dbo.MR_V_PeopleDirectory pd ON pd.Sicil = p.Sicil
      WHERE DATEDIFF(second, p.LastSeenAt, SYSUTCDATETIME()) <= @recentSeconds
      ORDER BY p.LastSeenAt DESC, p.Sicil;
    `);
    const counts = result.recordsets?.[0]?.[0] || {};
    const users = (result.recordsets?.[1] || []).map(presenceRow);
    const activeUsers = users.filter((user) => {
      const seen = user.lastSeenAt ? Date.parse(user.lastSeenAt) : NaN;
      return Number.isFinite(seen) && Date.now() - seen <= PRESENCE_ACTIVE_WINDOW_MS;
    });
    const directorates = new Set(activeUsers.map((user) => user.directorate).filter(Boolean));
    const departments = new Set(activeUsers.map((user) => user.department).filter(Boolean));
    return {
      ok: true,
      enabled: true,
      generatedAt: new Date().toISOString(),
      definition: {
        activeWindowMs: PRESENCE_ACTIVE_WINDOW_MS,
        recentWindowMs: PRESENCE_RECENT_WINDOW_MS,
        listLimit: PRESENCE_LIST_LIMIT
      },
      metrics: {
        activeCount: Number(counts.ActiveCount || 0),
        recentCount: Number(counts.RecentCount || 0),
        directorateCount: directorates.size,
        departmentCount: departments.size
      },
      users
    };
  } catch (error) {
    if (isMissingPresenceSchema(error)) {
      return {
        ok: true,
        enabled: false,
        generatedAt: new Date().toISOString(),
        definition: {
          activeWindowMs: PRESENCE_ACTIVE_WINDOW_MS,
          recentWindowMs: PRESENCE_RECENT_WINDOW_MS,
          listLimit: PRESENCE_LIST_LIMIT
        },
        metrics: { activeCount: 0, recentCount: 0, directorateCount: 0, departmentCount: 0 },
        users: []
      };
    }
    throw error;
  }
}
