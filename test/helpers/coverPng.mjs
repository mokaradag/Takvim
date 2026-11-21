import assert from 'node:assert/strict';
import { crc32, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

/** Kanonik kapak yedeğinin 8 bit RGB/RGBA PNG verisini ve A4 oranını denetler. */
export function validateCoverPng(png) {
  assert.ok(png.subarray(0, 8).equals(SIGNATURE), 'PNG imzası geçersiz');
  const imageData = [];
  let rowBytes = 0;
  let height = 0;
  let endSeen = false;
  for (let offset = 8; offset < png.length;) {
    assert.ok(offset + 12 <= png.length, 'PNG parça başlığı eksik');
    const length = png.readUInt32BE(offset);
    const end = offset + 8 + length;
    assert.ok(end + 4 <= png.length, 'PNG parça aralığı geçersiz');
    const type = png.toString('latin1', offset + 4, offset + 8);
    assert.equal(crc32(png.subarray(offset + 4, end)), png.readUInt32BE(end), 'PNG parça sağlama toplamı geçersiz');
    const data = png.subarray(offset + 8, end);
    if (offset === 8) {
      assert.ok(type === 'IHDR' && length === 13, 'PNG görüntü başlığı eksik');
      const width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.ok(width > 0 && width <= 4096 && height > 0 && height <= 4096, 'PNG boyutları sınır dışında');
      assert.ok(Math.abs(width / height - 210 / 297) < 0.002, 'PNG kapak oranı A4 olmalıdır');
      assert.ok(data[8] === 8 && [2, 6].includes(data[9]) && data.subarray(10).equals(Buffer.alloc(3)),
        'PNG kapak biçimi desteklenmiyor');
      rowBytes = 1 + width * (data[9] === 2 ? 3 : 4);
    } else if (type === 'IDAT') {
      imageData.push(data);
    } else {
      assert.ok(type === 'IEND' && length === 0 && end + 4 === png.length, 'PNG parça sırası veya bitişi geçersiz');
      endSeen = true;
    }
    offset = end + 4;
  }
  assert.ok(endSeen && imageData.length > 0, 'PNG görüntü verisi veya bitişi eksik');
  const compressed = Buffer.concat(imageData);
  const size = rowBytes * height;
  const { buffer, engine } = inflateSync(compressed, { maxOutputLength: size, info: true });
  assert.equal(engine.bytesWritten, compressed.length, 'PNG sıkıştırılmış veri aralığı geçersiz');
  assert.equal(buffer.length, size, 'PNG görüntü satırları eksik');
  for (let offset = 0; offset < size; offset += rowBytes) {
    assert.ok(buffer[offset] <= 4, 'PNG satır filtresi geçersiz');
  }
}
