import 'server-only';
import { isMissingTelemetrySchema } from './telemetryRepository.js';

const ACTIVE_ALERT_SUMMARY_SQL = `
  SELECT
    COUNT_BIG(*) AS TotalCount,
    COALESCE(SUM(CAST(CASE WHEN State = 'ACKNOWLEDGED' THEN 0 ELSE 1 END AS bigint)), 0) AS OpenCount,
    COALESCE(SUM(CAST(CASE WHEN State = 'ACKNOWLEDGED' THEN 1 ELSE 0 END AS bigint)), 0) AS AcknowledgedCount,
    COALESCE(SUM(CAST(CASE WHEN Severity IN ('WARNING', 'ERROR', 'CRITICAL') THEN 0 ELSE 1 END AS bigint)), 0) AS InfoCount,
    COALESCE(SUM(CAST(CASE WHEN Severity = 'WARNING' THEN 1 ELSE 0 END AS bigint)), 0) AS WarningCount,
    COALESCE(SUM(CAST(CASE WHEN Severity = 'ERROR' THEN 1 ELSE 0 END AS bigint)), 0) AS ErrorCount,
    COALESCE(SUM(CAST(CASE WHEN Severity = 'CRITICAL' THEN 1 ELSE 0 END AS bigint)), 0) AS CriticalCount
  FROM dbo.MR_OperationalAlerts
  WHERE State <> 'RESOLVED';`;

const EMPTY_COUNTS = Object.freeze({
  total: 0,
  open: 0,
  acknowledged: 0,
  info: 0,
  warning: 0,
  error: 0,
  critical: 0
});

/** Çözülmemiş uyarıların sınırsız toplamını döndürür. */
export async function loadActiveAlertSummary(executor) {
  try {
    const result = await executor.request().query(ACTIVE_ALERT_SUMMARY_SQL);
    const row = result.recordset?.[0] || {};
    return {
      schemaReady: true,
      counts: {
        total: Number(row.TotalCount || 0),
        open: Number(row.OpenCount || 0),
        acknowledged: Number(row.AcknowledgedCount || 0),
        info: Number(row.InfoCount || 0),
        warning: Number(row.WarningCount || 0),
        error: Number(row.ErrorCount || 0),
        critical: Number(row.CriticalCount || 0)
      }
    };
  } catch (error) {
    if (isMissingTelemetrySchema(error)) return { schemaReady: false, counts: { ...EMPTY_COUNTS } };
    throw error;
  }
}
