import assert from 'node:assert/strict';
import test from 'node:test';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

registerServerOnlyShim();

const { loadActiveAlertSummary } = await import('../src/server/observability/activeAlertSummaryRepository.js');

test('aktif uyarı toplamı görüntüleme sınırından bağımsız okunur', async () => {
  const executor = {
    request() {
      return {
        async query(statement) {
          assert.match(String(statement), /COUNT_BIG\(\*\) AS TotalCount/);
          assert.match(String(statement), /State <> 'RESOLVED'/);
          return {
            recordset: [{
              TotalCount: 56,
              OpenCount: 55,
              AcknowledgedCount: 1,
              InfoCount: 0,
              WarningCount: 55,
              ErrorCount: 0,
              CriticalCount: 1
            }]
          };
        }
      };
    }
  };

  const result = await loadActiveAlertSummary(executor);
  assert.equal(result.schemaReady, true);
  assert.deepEqual(result.counts, {
    total: 56,
    open: 55,
    acknowledged: 1,
    info: 0,
    warning: 55,
    error: 0,
    critical: 1
  });
});
