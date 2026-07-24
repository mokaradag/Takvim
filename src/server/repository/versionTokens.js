import 'server-only';
import { ServerPersistenceError } from '../errors.js';
import { decodeCanonicalRowVersion } from './rowVersionTokenValidation.js';

export function encodeVersion(value) {
  if (!value) return null;
  return Buffer.from(value).toString('base64');
}

export function decodeVersion(value) {
  if (!value || typeof value !== 'string') {
    throw new ServerPersistenceError('CONFLICT', 'Kayıt sürümü eksik. Verileri yeniden yükleyin.');
  }
  try {
    return decodeCanonicalRowVersion(value);
  } catch (cause) {
    throw new ServerPersistenceError('CONFLICT', 'Kayıt sürümü geçersiz. Verileri yeniden yükleyin.', { cause });
  }
}
