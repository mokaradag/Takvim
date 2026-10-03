import 'server-only';
import { createAiSqlGate } from '../aiSqlGate.js';
import { TOOL_SQL_GATE } from './toolLimits.js';

/**
 * Rota AI alan araçlarının ortak SQL havuzuna giden TEK kapısı.
 *
 * Konuşma, rehber ve anahtar kapılarından ayrıdır: araç sorguları konuşma
 * kaydını ya da kimlik denetimini bekletemez. Yer, sürücüdeki sorgu GERÇEKTEN
 * bitene kadar tutulur (bkz. aiSqlGate); iptal edilen ama hâlâ çalışan bir
 * sorgu yeni araç sorgusuna yer açmaz.
 */
export const toolSqlGate = createAiSqlGate({
  name: 'domain-tools',
  ...TOOL_SQL_GATE,
  saturation: 'tools'
});

export function toolSqlGateStatus() {
  return toolSqlGate.status();
}

export function resetToolSqlGateForTests() {
  toolSqlGate.resetForTests();
}
