import 'server-only';
import { ServerPersistenceError } from '../errors.js';

export function encodeVersion(value) {
  if (!value) return null;
  return Buffer.from(value).toString('base64');
}

export function decodeVersion(value) {
  if (!value || typeof value !== 'string') {
    throw new ServerPersistenceError('CONFLICT', 'Kayıt sürümü eksik. Verileri yeniden yükleyin.');
  }
  try {
    const buffer = Buffer.from(value, 'base64');
    if (buffer.length !== 8) throw new Error('invalid rowversion');
    return buffer;
  } catch (cause) {
    throw new ServerPersistenceError('CONFLICT', 'Kayıt sürümü geçersiz. Verileri yeniden yükleyin.', { cause });
  }
}
