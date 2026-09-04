/**
 * En küçük ZIP yazıcısı — bağımlılıksız.
 *
 * `.xlsx` bir ZIP kabıdır. Uygulama çevrimdışı kurulabildiği ve paket listesi
 * bilinçli olarak küçük tutulduğu için dışarıdan bir kitaplık eklenmez; burada
 * yalnızca ihtiyaç duyulan alt küme vardır: SIKIŞTIRMASIZ (store) girdiler,
 * UTF-8 ad bayrağı ve merkezi dizin.
 *
 * Girdiler sıkıştırılmaz: rapor dosyaları birkaç yüz kilobayttır ve tarayıcıda
 * deflate uygulamak hem kod hem de hata yüzeyi ekler.
 */

const TEXT_ENCODER = new TextEncoder();
export const MAX_ZIP_ARCHIVE_BYTES = 64 * 1024 * 1024;

function archiveSizeError(maxArchiveBytes) {
  const error = new RangeError(
    `Dışa aktarım dosyası ${Math.floor(maxArchiveBytes / (1024 * 1024))} MB güvenli boyut sınırını aşıyor. `
    + 'Daha dar bir kapsam seçip yeniden deneyin.'
  );
  error.code = 'ZIP_ARCHIVE_TOO_LARGE';
  return error;
}

/** CRC-32 (IEEE 802.3) — ZIP girdi başlıklarının istediği sağlama. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[index]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function encodeUtf8(value) {
  return TEXT_ENCODER.encode(String(value ?? ''));
}

/** MS-DOS tarih/saat çifti (ZIP başlıklarının biçimi). */
function dosDateTime(date) {
  const value = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
  const year = Math.min(2107, Math.max(1980, value.getFullYear()));
  return {
    time: (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate()
  };
}

function writer(size) {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  return {
    bytes,
    u16(value) { view.setUint16(offset, value, true); offset += 2; },
    u32(value) { view.setUint32(offset, value >>> 0, true); offset += 4; },
    raw(chunk) { bytes.set(chunk, offset); offset += chunk.length; },
    get offset() { return offset; }
  };
}

/**
 * `files`: `{ name, data }` girdileri (`data` bir `Uint8Array`).
 * Dönüş: tek parça ZIP içeriği.
 */
export function buildZipArchive(
  files = [],
  { modifiedAt = new Date(), maxArchiveBytes = MAX_ZIP_ARCHIVE_BYTES } = {}
) {
  if (!Number.isSafeInteger(maxArchiveBytes) || maxArchiveBytes < 22) {
    throw new RangeError('ZIP arşivi boyut sınırı en az 22 baytlık güvenli bir tam sayı olmalıdır.');
  }
  if (files.length > 0xffff) {
    throw new RangeError('ZIP arşivi 65.535 girdiden fazlasını taşıyamaz.');
  }

  const stamp = dosDateTime(modifiedAt);
  let archiveSize = 22; // Merkezi dizin sonlandırma kaydı.
  const entries = files.map((file) => {
    const nameBytes = encodeUtf8(file.name);
    if (nameBytes.length > 0xffff) {
      throw new RangeError('ZIP girdi adı UTF-8 olarak 65.535 baytı aşamaz.');
    }
    const data = file.data instanceof Uint8Array ? file.data : encodeUtf8(file.data);
    archiveSize += 30 + nameBytes.length + data.length; // Yerel başlık ve veri.
    archiveSize += 46 + nameBytes.length; // Merkezi dizin girdisi.
    if (archiveSize > maxArchiveBytes) {
      throw archiveSizeError(maxArchiveBytes);
    }
    return { nameBytes, data };
  });

  // CRC ancak bütün girdilerin sığdığı doğrulandıktan sonra hesaplanır. Böylece
  // fazla büyük bir dışa aktarım için ikinci arşiv tamponu ayrılmaz ve bütün
  // içerik gereksiz yere bir kez daha taranmaz.
  entries.forEach((entry) => { entry.crc = crc32(entry.data); });
  const output = writer(archiveSize);
  const offsets = [];

  for (const entry of entries) {
    offsets.push(output.offset);
    output.u32(0x04034b50);
    output.u16(20);
    output.u16(0x0800); // UTF-8 ad bayrağı
    output.u16(0); // store
    output.u16(stamp.time);
    output.u16(stamp.date);
    output.u32(entry.crc);
    output.u32(entry.data.length);
    output.u32(entry.data.length);
    output.u16(entry.nameBytes.length);
    output.u16(0);
    output.raw(entry.nameBytes);
    output.raw(entry.data);
  }

  const centralStart = output.offset;
  entries.forEach((entry, index) => {
    output.u32(0x02014b50);
    output.u16(20);
    output.u16(20);
    output.u16(0x0800);
    output.u16(0);
    output.u16(stamp.time);
    output.u16(stamp.date);
    output.u32(entry.crc);
    output.u32(entry.data.length);
    output.u32(entry.data.length);
    output.u16(entry.nameBytes.length);
    output.u16(0);
    output.u16(0);
    output.u16(0);
    output.u16(0);
    output.u32(0);
    output.u32(offsets[index]);
    output.raw(entry.nameBytes);
  });

  // Merkezi dizinin BOYUTU, sonlandırma kaydı yazılmadan ÖNCE ölçülür: kayıt
  // alanları yazılırken `offset` ilerlediği için satır içinde okunan değer
  // dizini 12 bayt fazla gösteriyor ve arşiv "bozuk merkezi dizin" hatasıyla
  // açılmıyordu.
  const centralSize2 = output.offset - centralStart;
  output.u32(0x06054b50);
  output.u16(0);
  output.u16(0);
  output.u16(entries.length);
  output.u16(entries.length);
  output.u32(centralSize2);
  output.u32(centralStart);
  output.u16(0);

  return output.bytes;
}
