/**
 * Görev hatırlatma e-postası şablonu.
 *
 * Modül SAFTIR: veritabanı, ağ ve React bağımlılığı yoktur. Böylece yer tutucu
 * yerleştirme, kaçış ve temizleme kuralları tek başına sınanabilir; aynı kod
 * hem sunucudaki gönderim yolunda hem de yönetici önizlemesinde çalışır.
 *
 * Güvenlik sözleşmesi:
 *  - Yönetici HTML'i KAPALI bir etiket/öznitelik kümesine göre temizlenir;
 *    betik, olay işleyicisi, `javascript:` bağlantısı ve gömülü çerçeve geçemez.
 *  - Dinamik değerler HTML'e KAÇIRILARAK yazılır: görev adında `<script>`
 *    bulunması bile yalnızca metin üretir.
 *  - Yer tutucu sözdizimi sabittir (`{{ad}}`); ifade, kod ya da sunucu
 *    şablonu çalıştırılmaz.
 */

/** Desteklenen yer tutucular; yönetici ekranı bu listeyi gösterir. */
export const REMINDER_PLACEHOLDERS = Object.freeze([
  Object.freeze({ key: 'task_name', label: 'Görev adı', example: 'Teklif dosyasının hazırlanması' }),
  Object.freeze({ key: 'project_name', label: 'Proje adı', example: 'İHA Hava Savunma Sistemi ELDD Projesi' }),
  Object.freeze({ key: 'project_code', label: 'Proje kodu', example: 'P4417041' }),
  Object.freeze({ key: 'description', label: 'Görev açıklaması', example: 'Teknik şartname eklenecek.' }),
  Object.freeze({ key: 'keyword', label: 'Kısa açıklama / etiket', example: 'Teklif' }),
  Object.freeze({ key: 'assignees', label: 'Sorumlular', example: 'Ayşe Yılmaz, Mehmet Demir' }),
  Object.freeze({ key: 'due_date', label: 'Termin tarihi', example: '20.08.2026' }),
  Object.freeze({ key: 'remaining_days', label: 'Kalan gün sayısı', example: '3' }),
  Object.freeze({ key: 'remaining_duration', label: 'Kalan süre (okunur)', example: '3 gün kaldı' }),
  Object.freeze({ key: 'priority', label: 'Öncelik', example: 'Yüksek' }),
  Object.freeze({ key: 'status', label: 'Durum', example: 'Devam ediyor' }),
  Object.freeze({ key: 'app_name', label: 'Uygulama adı', example: 'MERGEN Rota' }),
  Object.freeze({ key: 'today', label: 'Gönderim günü', example: '17.08.2026' })
]);

export const REMINDER_PLACEHOLDER_KEYS = Object.freeze(REMINDER_PLACEHOLDERS.map((entry) => entry.key));

/** Değeri bilinmeyen alanlar için gösterilen nötr işaret. */
export const MISSING_VALUE_MARK = '—';

/* ── Temizleme (sanitization) ─────────────────────────────────── */

const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's',
  'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'a',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'small'
]);
const VOID_TAGS = new Set(['br', 'hr']);
const ALLOWED_ATTRIBUTES = new Set(['href', 'title', 'colspan', 'rowspan', 'align', 'style']);
// E-posta istemcileri yalnızca basit, satır içi biçimlendirmeyi güvenilir
// biçimde uygular; ayrıca `expression()`/`url()` gibi tehlikeli değerler
// tümüyle dışarıda bırakılır.
const ALLOWED_STYLE_PROPERTIES = new Set([
  'color', 'background-color', 'font-size', 'font-weight', 'font-style',
  'text-align', 'text-decoration', 'padding', 'margin', 'border',
  'border-collapse', 'border-bottom', 'border-top', 'width', 'line-height'
]);

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const NAMED_ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0'
});

/**
 * HTML varlıklarını çözer.
 *
 * Zengin metin düzenleyicisi `innerHTML` verdiği için metin sunucuya ZATEN
 * kodlanmış gelir (`A & B` → `A &amp; B`). Yeniden kaçırmadan önce çözülmezse
 * temizleyici her geçişte bir kat daha kodlar (`&amp;amp;`) ve önizleme ile
 * e-posta ham varlık gösterir; ayar yükle/kaydet/gönder yolunda temizleyici
 * birden çok kez çalıştığı için kat sayısı büyür.
 *
 * Çözüm AYRICA güvenliği artırır: `&#106;avascript:` gibi kodlanmış değerler
 * şema denetiminden önce açığa çıkar.
 */
export function decodeHtmlEntities(value) {
  return String(value ?? '').replace(/&(#[Xx][0-9A-Fa-f]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1] === 'x' || entity[1] === 'X';
      const code = Number.parseInt(hex ? entity.slice(2) : entity.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/** Metni HTML'e güvenle yazar: önce çözer, sonra kaçırır — yani IDEMPOTENTTİR. */
export function escapeText(value) {
  return escapeHtml(decodeHtmlEntities(value));
}

function sanitizeStyle(value) {
  return String(value || '')
    .split(';')
    .map((declaration) => declaration.trim())
    .filter(Boolean)
    .map((declaration) => {
      const separator = declaration.indexOf(':');
      if (separator < 0) return null;
      const property = declaration.slice(0, separator).trim().toLowerCase();
      const propertyValue = declaration.slice(separator + 1).trim();
      if (!ALLOWED_STYLE_PROPERTIES.has(property)) return null;
      if (/url\s*\(|expression\s*\(|javascript:|@import/i.test(propertyValue)) return null;
      return `${property}: ${propertyValue}`;
    })
    .filter(Boolean)
    .join('; ');
}

function sanitizeHref(value) {
  const href = String(value || '').trim();
  if (/^(https?:|mailto:)/i.test(href) && !/[\s<>"]/.test(href)) return href;
  return null;
}

function sanitizeAttributes(raw) {
  const attributes = [];
  const pattern = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match;
  while ((match = pattern.exec(raw))) {
    const name = match[1].toLowerCase();
    if (!ALLOWED_ATTRIBUTES.has(name)) continue;
    // Öznitelik değeri kaynakta kodlu gelir; önce çözülür ki denetim gerçek
    // değeri görsün ve yeniden yazım kat kat kodlamaya dönüşmesin.
    const value = decodeHtmlEntities(match[3] ?? match[4] ?? match[5] ?? '');
    if (name === 'href') {
      const href = sanitizeHref(value);
      if (href) attributes.push(`href="${escapeHtml(href)}"`);
      continue;
    }
    if (name === 'style') {
      const style = sanitizeStyle(value);
      if (style) attributes.push(`style="${escapeHtml(style)}"`);
      continue;
    }
    attributes.push(`${name}="${escapeHtml(value)}"`);
  }
  return attributes.length ? ` ${attributes.join(' ')}` : '';
}

/**
 * Yönetici HTML'ini kapalı bir etiket kümesine indirger.
 *
 * Etiket dışındaki metin KAÇIRILIR; izin verilmeyen etiketler tümüyle düşer
 * (`<script>` ve `<style>` gövdeleriyle birlikte). Böylece zengin metin
 * düzenleyicisi XSS yüzeyi açmaz.
 */
/**
 * Etiketin KAPANIŞ konumunu bulur; tırnak içindeki `>` etiketi bitirmez.
 *
 * İlk `>` karakterinde durmak, `<a title="a > b">` gibi geçerli bir etiketi
 * ortasından kesiyor, öznitelik değerini yitiriyor ve bozuk çıktı üretiyordu.
 *
 * @returns {number} `>` karakterinin dizini; kapanış yoksa `-1`
 */
function findTagEnd(source, start) {
  let quote = '';
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '>') return index;
  }
  return -1;
}

export function sanitizeReminderHtml(input) {
  const source = String(input ?? '');
  let output = '';
  let index = 0;

  while (index < source.length) {
    const start = source.indexOf('<', index);
    if (start < 0) {
      output += escapeText(source.slice(index));
      break;
    }
    output += escapeText(source.slice(index, start));

    // Yorumlar ve işlem yönergeleri tümüyle düşer.
    if (source.startsWith('<!--', start)) {
      const end = source.indexOf('-->', start + 4);
      index = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<!', start) || source.startsWith('<?', start)) {
      const end = source.indexOf('>', start);
      index = end < 0 ? source.length : end + 1;
      continue;
    }

    const end = findTagEnd(source, start);
    if (end < 0) {
      output += escapeText(source.slice(start));
      break;
    }
    const raw = source.slice(start + 1, end);
    const closing = raw.startsWith('/');
    const body = closing ? raw.slice(1) : raw;
    const nameMatch = /^([A-Za-z][A-Za-z0-9]*)/.exec(body.trim());
    const tag = nameMatch ? nameMatch[1].toLowerCase() : '';

    if (!tag || !ALLOWED_TAGS.has(tag)) {
      // `script`/`style` gövdesi de atılır: yalnızca etiketi düşürmek, kodu
      // düz metin olarak bırakırdı.
      if (tag === 'script' || tag === 'style') {
        const closeIndex = source.toLowerCase().indexOf(`</${tag}>`, end + 1);
        index = closeIndex < 0 ? source.length : closeIndex + tag.length + 3;
        continue;
      }
      index = end + 1;
      continue;
    }

    if (closing) {
      if (!VOID_TAGS.has(tag)) output += `</${tag}>`;
    } else if (VOID_TAGS.has(tag)) {
      output += `<${tag} />`;
    } else {
      output += `<${tag}${sanitizeAttributes(body.slice(tag.length))}>`;
    }
    index = end + 1;
  }

  return output;
}

/* ── Yer tutucu yerleştirme ───────────────────────────────────── */

const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * Metindeki yer tutucuları değerlerle değiştirir.
 *
 * @param {string} template şablon metni
 * @param {Record<string, string>} values yer tutucu değerleri
 * @param {{escape?: (value: string) => string}} [options]
 * @returns {{text: string, unknown: string[]}} bilinmeyen yer tutucular
 *   DEĞİŞTİRİLMEZ: metin olduğu gibi kalır ve ayrıca raporlanır. Böylece
 *   yönetici yazım hatasını görür, ileti ise sessizce bozulmaz.
 */
export function applyReminderPlaceholders(template, values = {}, { escape = escapeHtml } = {}) {
  const unknown = new Set();
  const text = String(template ?? '').replace(PLACEHOLDER_PATTERN, (match, key) => {
    if (!REMINDER_PLACEHOLDER_KEYS.includes(key)) {
      unknown.add(key);
      return match;
    }
    const value = values[key];
    const resolved = value == null || String(value).trim() === '' ? MISSING_VALUE_MARK : String(value);
    return escape(resolved);
  });
  return { text, unknown: [...unknown] };
}

/** HTML gövdesinden okunabilir düz metin karşılığı üretir. */
export function htmlToPlainText(html) {
  return String(html ?? '')
    .replace(/<\s*(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|h[1-4]|li|tr|blockquote)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
    .replace(/<\s*t[dh][^>]*>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    // Varlıklar TEK GEÇİŞTE çözülür. Zincirlenmiş `replaceAll` çağrıları
    // birbirinin çıktısı üzerinde çalışıyordu: `&amp;lt;` önce `&lt;` oluyor,
    // sonraki adım onu `<` yapıyordu; HTML'de `<` gösteren metin düz metin
    // bölümünde `<` olarak bozuluyordu.
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (match, entity) => (
      { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[entity] ?? match
    ))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ── Varsayılan şablon ────────────────────────────────────────── */

export const DEFAULT_REMINDER_SUBJECT = '{{app_name}} · Görev hatırlatması: {{task_name}} ({{remaining_duration}})';

/**
 * Kurulumla birlikte gelen varsayılan gövde.
 *
 * Biçimlendirme bilinçli olarak SADEDİR ve Outlook'ta güvenilir çalışan
 * araçlara dayanır: tablo düzeni, satır içi stiller, kaçınılan modern CSS.
 * Yönetici hiçbir şey değiştirmese bile özellik ilk günden çalışır.
 */
export const DEFAULT_REMINDER_BODY = [
  '<h2 style="margin: 0 0 12px; font-size: 18px; color: #1f2937;">Görev hatırlatması</h2>',
  '<p style="margin: 0 0 14px; color: #374151; line-height: 1.55;">',
  'Sayın {{assignees}},<br />',
  'aşağıdaki görevin termin tarihine <strong>{{remaining_duration}}</strong>.',
  'Durumu gözden geçirip gerekirse güncellemenizi rica ederiz.',
  '</p>',
  '<table style="border-collapse: collapse; width: 100%; margin: 0 0 14px;">',
  '<tr><td style="padding: 7px 10px; border: 1px solid #e5e7eb; background-color: #f9fafb; width: 170px;"><strong>Görev</strong></td>',
  '<td style="padding: 7px 10px; border: 1px solid #e5e7eb;">{{task_name}}</td></tr>',
  '<tr><td style="padding: 7px 10px; border: 1px solid #e5e7eb; background-color: #f9fafb;"><strong>Proje</strong></td>',
  '<td style="padding: 7px 10px; border: 1px solid #e5e7eb;">{{project_code}} · {{project_name}}</td></tr>',
  '<tr><td style="padding: 7px 10px; border: 1px solid #e5e7eb; background-color: #f9fafb;"><strong>Kısa açıklama</strong></td>',
  '<td style="padding: 7px 10px; border: 1px solid #e5e7eb;">{{keyword}}</td></tr>',
  '<tr><td style="padding: 7px 10px; border: 1px solid #e5e7eb; background-color: #f9fafb;"><strong>Sorumlular</strong></td>',
  '<td style="padding: 7px 10px; border: 1px solid #e5e7eb;">{{assignees}}</td></tr>',
  '<tr><td style="padding: 7px 10px; border: 1px solid #e5e7eb; background-color: #f9fafb;"><strong>Termin</strong></td>',
  '<td style="padding: 7px 10px; border: 1px solid #e5e7eb;">{{due_date}} ({{remaining_duration}})</td></tr>',
  '<tr><td style="padding: 7px 10px; border: 1px solid #e5e7eb; background-color: #f9fafb;"><strong>Öncelik</strong></td>',
  '<td style="padding: 7px 10px; border: 1px solid #e5e7eb;">{{priority}}</td></tr>',
  '<tr><td style="padding: 7px 10px; border: 1px solid #e5e7eb; background-color: #f9fafb;"><strong>Durum</strong></td>',
  '<td style="padding: 7px 10px; border: 1px solid #e5e7eb;">{{status}}</td></tr>',
  '</table>',
  '<p style="margin: 0 0 6px; color: #374151;"><strong>Açıklama</strong></p>',
  '<p style="margin: 0 0 16px; color: #4b5563; line-height: 1.55;">{{description}}</p>',
  '<p style="margin: 0; color: #6b7280; font-size: 12px;">',
  'Bu ileti {{app_name}} tarafından {{today}} tarihinde otomatik olarak hazırlanmıştır.',
  '</p>'
].join('\n');

/** Gövdeyi e-posta iskeletine yerleştirir (Outlook uyumlu, satır içi stil). */
export function wrapReminderDocument(bodyHtml) {
  return [
    '<!DOCTYPE html>',
    '<html lang="tr"><head><meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '</head>',
    '<body style="margin: 0; padding: 0; background-color: #f3f4f6;">',
    '<table role="presentation" style="border-collapse: collapse; width: 100%; background-color: #f3f4f6;">',
    '<tr><td style="padding: 22px 12px;">',
    '<table role="presentation" style="border-collapse: collapse; width: 100%; max-width: 640px; margin: 0 auto;',
    ' background-color: #ffffff; border: 1px solid #e5e7eb;">',
    '<tr><td style="padding: 22px 24px; font-family: Segoe UI, Arial, sans-serif; font-size: 14px; color: #111827;">',
    bodyHtml,
    '</td></tr></table>',
    '</td></tr></table>',
    '</body></html>'
  ].join('\n');
}

/**
 * Konu ve gövdeyi görev değerleriyle üretir.
 *
 * @param {{subject: string, body: string}} template yönetici şablonu
 * @param {Record<string, string>} values yer tutucu değerleri
 * @returns {{subject: string, html: string, text: string, unknownPlaceholders: string[]}}
 */
export function renderReminderEmail(template, values = {}) {
  const subjectResult = applyReminderPlaceholders(
    template?.subject || DEFAULT_REMINDER_SUBJECT,
    values,
    // Konu satırı HTML değildir; kaçış uygulanmaz, başlık temizliği MIME
    // katmanında yapılır (bkz. server/mail/mimeMessage.js).
    { escape: (value) => value }
  );
  // SIRA ÖNEMLİDİR: yer tutucular ÖNCE yerleştirilir, temizlik SONRA çalışır.
  // Ters sırada `sanitizeStyle` ve `sanitizeHref` yalnızca şablonun kendisini
  // görüyor, yerleştirilen DEĞERİ hiç denetlemiyordu: `style="color: {{keyword}}"`
  // yazan bir yönetici şablonuna, `red; background-image: url(...)` gibi bir
  // anahtar sözcük enjekte edilebiliyordu (`escapeHtml`, `(`, `)`, `:` ve `;`
  // karakterlerini kaçırmaz). Artık izin listeleri dinamik değerler için de
  // yetkilidir.
  const substituted = applyReminderPlaceholders(template?.body || DEFAULT_REMINDER_BODY, values);
  const bodyResult = { text: sanitizeReminderHtml(substituted.text), unknown: substituted.unknown };
  return {
    subject: subjectResult.text,
    // Tam ileti gövdesi (e-posta iskeletiyle birlikte).
    html: wrapReminderDocument(bodyResult.text),
    // Yalnızca gövde: yönetici önizlemesi bunu gösterir; iskelet `<html>`
    // etiketleri sayfa içine gömülemez.
    bodyHtml: bodyResult.text,
    text: htmlToPlainText(bodyResult.text),
    unknownPlaceholders: [...new Set([...subjectResult.unknown, ...bodyResult.unknown])]
  };
}
