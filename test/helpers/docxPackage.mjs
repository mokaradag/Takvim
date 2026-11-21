/**
 * Kanonik şablon sınamaları için sınırlı, salt okunur ZIP/DOCX okuyucusu.
 * Saklanmış ve deflate girdileri desteklenir. ZIP64, şifreleme, çok parçalı
 * arşivler ve kanonik şablonun kullanmadığı veri betimleyicileri reddedilir.
 */
import { readFile } from 'node:fs/promises';
import { crc32, inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 128;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function requireZip(condition, message) {
  if (!condition) throw new Error(message);
}

function findEndOfCentralDirectory(buffer) {
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= lowest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE
      && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) return offset;
  }
  throw new Error('ZIP merkezî dizin sonu bulunamadı');
}

/** @returns {Map<string, Buffer>} girdi adı → açılmış içerik */
export function readZipEntries(buffer) {
  requireZip(buffer.length <= MAX_ARCHIVE_BYTES, 'ZIP paket boyutu sınırı aşıldı');
  const end = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(end + 10);
  requireZip(buffer.readUInt16LE(end + 4) === 0 && buffer.readUInt16LE(end + 6) === 0
    && buffer.readUInt16LE(end + 8) === count, 'çok parçalı ZIP desteklenmez');
  const centralStart = buffer.readUInt32LE(end + 16);
  const centralSize = buffer.readUInt32LE(end + 12);
  requireZip(count > 0 && count <= MAX_ENTRIES && centralStart + centralSize === end,
    'ZIP merkezî dizin aralığı veya girdi sayısı geçersiz');

  let offset = centralStart;
  let totalBytes = 0;
  const entries = new Map();
  const names = new Set();
  const ranges = [];
  for (let index = 0; index < count; index += 1) {
    requireZip(offset + 46 <= end && buffer.readUInt32LE(offset) === CENTRAL_SIGNATURE,
      'ZIP merkezî dizin girdisi bozuk');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const checksum = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    requireZip(next <= end && nameLength > 0, 'ZIP merkezî dizin girdi aralığı geçersiz');
    requireZip(buffer.readUInt16LE(offset + 34) === 0, 'çok parçalı ZIP girdisi desteklenmez');
    const nameBytes = buffer.subarray(offset + 46, offset + 46 + nameLength);
    const name = utf8.decode(nameBytes);
    const normalized = name.normalize('NFC').toLowerCase();
    requireZip(!/[\u0000-\u001f\\%:?#]/u.test(name)
      && name.split('/').every((segment) => segment && !/^\.+$/u.test(segment) && !segment.endsWith('.')),
    'ZIP parça adı geçersiz: ' + name);
    requireZip(!names.has(normalized), 'yinelenen ZIP parça adı: ' + name);
    names.add(normalized);
    requireZip(method === 0 || method === 8, 'desteklenmeyen ZIP sıkıştırma yöntemi: ' + name);
    requireZip((flags & ~(method === 8 ? 0x806 : 0x800)) === 0, 'desteklenmeyen ZIP girdi bayrakları: ' + name);
    requireZip(localOffset + 30 <= centralStart && buffer.readUInt32LE(localOffset) === LOCAL_SIGNATURE,
      'ZIP yerel başlığı bozuk: ' + name);
    const localNameStart = localOffset + 30;
    const localNameEnd = localNameStart + buffer.readUInt16LE(localOffset + 26);
    const dataStart = localNameEnd + buffer.readUInt16LE(localOffset + 28);
    const dataEnd = dataStart + compressedSize;
    requireZip(dataEnd <= centralStart && !ranges.some(([start, finish]) => localOffset < finish && dataEnd > start),
      'ZIP yerel girdi aralığı geçersiz: ' + name);
    ranges.push([localOffset, dataEnd]);
    requireZip(nameBytes.equals(buffer.subarray(localNameStart, localNameEnd))
      && buffer.readUInt16LE(localOffset + 6) === flags && buffer.readUInt16LE(localOffset + 8) === method
      && buffer.readUInt32LE(localOffset + 14) === checksum
      && buffer.readUInt32LE(localOffset + 18) === compressedSize && buffer.readUInt32LE(localOffset + 22) === size,
    'ZIP yerel başlığı merkezî dizinle uyuşmuyor: ' + name);
    totalBytes += size;
    requireZip(size <= MAX_ENTRY_BYTES && totalBytes <= MAX_TOTAL_BYTES, 'açılmış ZIP boyutu sınırı aşıldı: ' + name);

    const raw = buffer.subarray(dataStart, dataEnd);
    let decoded = raw;
    if (method === 8) {
      const inflated = inflateRawSync(raw, { maxOutputLength: Math.max(1, size), info: true });
      requireZip(inflated.engine.bytesWritten === raw.length, 'ZIP sıkıştırılmış veri aralığı geçersiz: ' + name);
      decoded = inflated.buffer;
    }
    requireZip(decoded.length === size, 'ZIP girdi boyutu uyuşmuyor: ' + name);
    requireZip(crc32(decoded) === checksum, 'ZIP girdi sağlama toplamı uyuşmuyor: ' + name);
    entries.set(name, method === 0 ? Buffer.from(decoded) : decoded);
    offset = next;
  }
  requireZip(offset === end, 'ZIP merkezî dizin uzunluğu uyuşmuyor');
  return entries;
}

/** DOCX paketini okur; metin parçalarında geçersiz UTF-8 reddedilir. */
export async function readDocxPackage(file) {
  const entries = readZipEntries(await readFile(file));
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    buffer: (name) => entries.get(name),
    text: (name) => {
      if (!entries.has(name)) throw new Error('paket parçası yok: ' + name);
      return utf8.decode(entries.get(name));
    }
  };
}
