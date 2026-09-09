import 'server-only';
import { ServerPersistenceError } from '../errors.js';

export const OUTLOOK_BODY_LIMIT = 8192;

export async function readOutlookRequestBody(request) {
  const tooLarge = () => new ServerPersistenceError('MUTATION_FAILED', 'Outlook görev seçimi çok büyük.', { status: 413 });
  if (Number(request.headers?.get('content-length')) > OUTLOOK_BODY_LIMIT) throw tooLarge();
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > OUTLOOK_BODY_LIMIT) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch {
    throw new ServerPersistenceError('MUTATION_FAILED', 'Geçerli bir görev seçimi gereklidir.', { status: 400 });
  }
}
