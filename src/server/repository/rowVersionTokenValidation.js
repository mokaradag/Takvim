const CANONICAL_ROWVERSION_BASE64 = /^[A-Za-z0-9+/]{11}=$/;

export function decodeCanonicalRowVersion(value) {
  if (typeof value !== 'string' || !CANONICAL_ROWVERSION_BASE64.test(value)) {
    throw new TypeError('Rowversion token must be canonical Base64.');
  }

  const buffer = Buffer.from(value, 'base64');
  if (buffer.length !== 8 || buffer.toString('base64') !== value) {
    throw new TypeError('Rowversion token must decode to exactly eight bytes.');
  }

  return buffer;
}
