/**
 * Sınamalar için en küçük salt okunur ZIP/DOCX okuyucusu (bağımlılıksız).
 *
 * Merkezî dizin okunur; yalnızca saklanmış (0) ve deflate (8) girdileri açılır. ZIP64, şifreli girdi ve çok
 * parçalı arşiv desteklenmez: kanonik şablon bunları içermez, içerirse okuma açık bir hatayla durur.
 */
import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function findEndOfCentralDirectory(buffer) {
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= lowest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error('ZIP merkezî dizin sonu bulunamadı');
}

/** @returns {Map<string, Buffer>} girdi adı → açılmış içerik */
export function readZipEntries(buffer) {
  const end = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new Error('ZIP merkezî dizin girdisi bozuk');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (flags & 0x1) throw new Error(`şifreli ZIP girdisi desteklenmez: ${name}`);
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new Error(`yerel başlık bozuk: ${name}`);
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) entries.set(name, Buffer.from(raw));
    else if (method === 8) entries.set(name, inflateRawSync(raw));
    else throw new Error(`desteklenmeyen sıkıştırma yöntemi ${method}: ${name}`);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** DOCX paketini okur; `text(ad)` UTF-8 metin döndürür. */
export async function readDocxPackage(file) {
  const entries = readZipEntries(await readFile(file));
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    buffer: (name) => entries.get(name),
    text: (name) => {
      if (!entries.has(name)) throw new Error(`paket parçası yok: ${name}`);
      return entries.get(name).toString('utf8');
    }
  };
}
