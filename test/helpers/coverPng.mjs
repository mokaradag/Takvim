import assert from 'node:assert/strict';
import { crc32, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

function hexToRgb(hex) {
  return [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** IDAT öncesinde izin verilen metinsiz yardımcı PNG parçaları ve beklenen bayt uzunlukları (null = değişken). */
const PRE_IDAT_ANCILLARY_LENGTHS = new Map([
  ['pHYs', 9],
  ['sRGB', 1],
  ['gAMA', 4],
  ['cHRM', 32],
  ['sBIT', null]
]);

/** İzinli IDAT öncesi yardımcı PNG parçasının yük alanlarını doğrular. */
function validateAncillaryPayload(type, data) {
  if (type === 'pHYs') {
    assert.ok(data[8] === 0 || data[8] === 1, 'PNG pHYs birim alanı geçersiz: ' + data[8]);
  } else if (type === 'sRGB') {
    assert.ok(data[0] <= 3, 'PNG sRGB işleme amacı geçersiz: ' + data[0]);
  } else if (type === 'gAMA') {
    assert.ok(data.readUInt32BE(0) > 0, 'PNG gAMA değeri pozitif olmalıdır');
  } else if (type === 'sBIT') {
    for (let i = 0; i < data.length; i += 1) {
      assert.ok(data[i] >= 1 && data[i] <= 8, 'PNG sBIT kanal bit sayısı geçersiz');
    }
  }
}

/** Kanonik kapak yedeğinin 8 bit RGB/RGBA PNG verisini, A4 oranını ve onaylı kapak piksel içeriğini denetler. */
export function validateCoverPng(png, expected = { background: '003087', strokes: ['077780', 'FF5620'] }) {
  assert.ok(png.subarray(0, 8).equals(SIGNATURE), 'PNG imzası geçersiz');
  const imageData = [];
  const seenAncillary = new Set();
  let width = 0;
  let height = 0;
  let bpp = 0;
  let rowBytes = 0;
  let idatSeen = false;
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
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.ok(width > 0 && width <= 4096 && height > 0 && height <= 4096, 'PNG boyutları sınır dışında');
      assert.ok(Math.abs(width / height - 210 / 297) < 0.002, 'PNG kapak oranı A4 olmalıdır');
      assert.ok(data[8] === 8 && [2, 6].includes(data[9]) && data.subarray(10).equals(Buffer.alloc(3)),
        'PNG kapak biçimi desteklenmiyor');
      bpp = data[9] === 2 ? 3 : 4;
      rowBytes = 1 + width * bpp;
    } else if (type === 'IDAT') {
      assert.equal(endSeen, false, 'PNG parça sırası veya bitişi geçersiz');
      idatSeen = true;
      imageData.push(data);
    } else if (type === 'IEND') {
      assert.ok(length === 0 && end + 4 === png.length, 'PNG parça sırası veya bitişi geçersiz');
      endSeen = true;
    } else if (!idatSeen && PRE_IDAT_ANCILLARY_LENGTHS.has(type)) {
      assert.ok(!seenAncillary.has(type), `PNG yardımcı parçası yinelenemez: ${type}`);
      seenAncillary.add(type);
      const expectedLength = PRE_IDAT_ANCILLARY_LENGTHS.get(type);
      const validLength = expectedLength === null ? length === bpp : length === expectedLength;
      assert.ok(validLength, `PNG yardımcı parça uzunluğu geçersiz: ${type}`);
      validateAncillaryPayload(type, data);
    } else {
      assert.fail('PNG parça sırası veya türü geçersiz: ' + type);
    }
    offset = end + 4;
  }
  assert.ok(endSeen && imageData.length > 0, 'PNG görüntü verisi veya bitişi eksik');
  const compressed = Buffer.concat(imageData);
  const size = rowBytes * height;
  const { buffer, engine } = inflateSync(compressed, { maxOutputLength: size, info: true });
  assert.equal(engine.bytesWritten, compressed.length, 'PNG sıkıştırılmış veri aralığı geçersiz');
  assert.equal(buffer.length, size, 'PNG görüntü satırları eksik');

  // PNG satır filtrelerini geri çözerek onaylı zemin ve yedigen çizgi renklerinin görünür piksel varlığını doğrula.
  const stride = width * bpp;
  const bg = hexToRgb(expected.background);
  const strokeTargets = expected.strokes.map(hexToRgb);
  const strokeCounts = new Array(strokeTargets.length).fill(0);
  let backgroundCount = 0;
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowBytes;
    const filter = buffer[rowStart];
    assert.ok(filter <= 4, 'PNG satır filtresi geçersiz');
    for (let i = 0; i < stride; i += 1) {
      const raw = buffer[rowStart + 1 + i];
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = prev[i];
      const upLeft = i >= bpp ? prev[i - bpp] : 0;
      if (filter === 0) cur[i] = raw;
      else if (filter === 1) cur[i] = (raw + left) & 0xff;
      else if (filter === 2) cur[i] = (raw + up) & 0xff;
      else if (filter === 3) cur[i] = (raw + ((left + up) >> 1)) & 0xff;
      else cur[i] = (raw + paeth(left, up, upLeft)) & 0xff;
    }
    for (let x = 0; x < stride; x += bpp) {
      const r = cur[x];
      const g = cur[x + 1];
      const b = cur[x + 2];
      const alpha = bpp === 4 ? cur[x + 3] : 255;
      if (alpha === 255 && r === bg[0] && g === bg[1] && b === bg[2]) {
        backgroundCount += 1;
        continue;
      }
      if (alpha < 128) continue;
      for (let s = 0; s < strokeTargets.length; s += 1) {
        const [tr, tg, tb] = strokeTargets[s];
        // Kenar yumuşatma (anti-aliasing) piksellerini de kapsayacak şekilde hedef çizgi rengine yakınlığı ölç.
        if (Math.abs(r - tr) + Math.abs(g - tg) + Math.abs(b - tb) <= 180) {
          strokeCounts[s] += 1;
          break;
        }
      }
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }

  const totalPixels = width * height;
  assert.ok(backgroundCount / totalPixels >= 0.9, 'PNG kapak zemini onaylı ana lacivert değil');
  for (let s = 0; s < strokeTargets.length; s += 1) {
    assert.ok(strokeCounts[s] >= Math.max(100, Math.floor(totalPixels * 0.001)),
      'PNG kapak yedeğinde onaylı yedigen çizgi rengi bulunamadı: ' + expected.strokes[s]);
  }
}
