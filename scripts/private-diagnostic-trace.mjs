import { closeSync, constants, fchmodSync, fstatSync, openSync, writeSync } from 'node:fs';

const oneOf = (value, allowed) => allowed.includes(value) ? value : null;
const length = (value) => typeof value === 'string' || Array.isArray(value) ? value.length : 0;

/** Diagnostics keep structure and bounded enums, never conversation text, identities, queries or argument values. */
export function diagnosticMetadata(record) {
  return {
    at: new Date().toISOString(),
    toolCalls: (record.toolCalls || []).map((call) => ({
      // Only protocol tool names; unknown names can themselves contain private text.
      kind: oneOf(call.name, ['rota_plan', 'rota_answer_compose']) || 'other',
      argumentCount: call.arguments && typeof call.arguments === 'object' ? Object.keys(call.arguments).length : 0
    })),
    textChars: length(record.text), turnChars: length(record.turn), answerChars: length(record.answer),
    failureCount: length(record.failures),
    finish: oneOf(record.finish, ['stop', 'unavailable', 'clarification', 'length', 'error', 'tool_calls']),
    reads: (record.reads || []).map((read) => ({
      query: oneOf(read.query, ['task-facts', 'portfolio']),
      assigneeMode: oneOf(read.assigneeMode, ['any', 'me', 'team', 'person', 'unassigned']),
      teamLevel: oneOf(read.teamLevel, ['UNIT', 'DEPARTMENT', 'DIRECTORATE']),
      projectSelected: Boolean(read.projectId), personSelected: Boolean(read.personSicil),
      dateWindow: Boolean(read.dateFrom || read.dateTo), taskSelected: Boolean(read.taskIds)
    })),
    trail: (record.trail || []).map((item) => ({ role: oneOf(item.role, ['system', 'user', 'assistant', 'tool']), calls: length(item.calls), contentChars: length(item.content) }))
  };
}

export function appendPrivateDiagnostic(path, record) {
  // Sanitize before opening or persisting. Existing traces are tightened too; symlink destinations are rejected.
  const line = `${JSON.stringify(diagnosticMetadata(record))}\n`;
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NONBLOCK || 0) | (constants.O_NOFOLLOW || 0), 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('DIAGNOSTIC_NOT_REGULAR_FILE');
    fchmodSync(fd, 0o600);
    writeSync(fd, line);
  } finally { closeSync(fd); }
}
