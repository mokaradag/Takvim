function fillRandomBytes(bytes, cryptoProvider, random) {
  if (cryptoProvider && typeof cryptoProvider.getRandomValues === 'function') {
    cryptoProvider.getRandomValues(bytes);
    return bytes;
  }
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(random() * 256) & 0xff;
  }
  return bytes;
}

export function createUuidV4({ cryptoProvider = globalThis.crypto, random = Math.random } = {}) {
  if (cryptoProvider && typeof cryptoProvider.randomUUID === 'function') {
    return cryptoProvider.randomUUID();
  }

  const bytes = fillRandomBytes(new Uint8Array(16), cryptoProvider, random);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

export function createClientEntityId(prefix, options) {
  const normalizedPrefix = String(prefix || '').trim();
  if (!normalizedPrefix) throw new TypeError('Client entity ID prefix is required.');
  return `${normalizedPrefix}-${createUuidV4(options)}`;
}
