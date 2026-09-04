import { buildZipArchive, encodeUtf8 } from './zipArchive.js';

/**
 * Bağımlılıksız `.xlsx` (SpreadsheetML) yazıcısı.
 *
 * Eski dışa aktarım, `.xls` uzantılı bir HTML tablosu üretiyordu; Excel dosyayı
 * açarken her seferinde "biçim ve uzantı eşleşmiyor" uyarısı gösteriyor,
 * kullanıcı raporu görmek için güvenlik uyarısını onaylamak zorunda kalıyordu.
 * Burada üretilen dosya GERÇEK bir Excel çalışma kitabıdır: uyarı çıkmaz,
 * birden çok sayfa taşır ve başlık satırı dondurulmuş + süzgeçlidir.
 *
 * Kapsam bilinçli olarak dardır: satır içi metin (`inlineStr`), sayı, yüzde ve
 * tarih hücreleri; sabit bir biçem tablosu; sayfa başına dondurulmuş başlık ve
 * otomatik süzgeç.
 */

const SHEET_NAME_LIMIT = 31;
// Excel sayfa adlarında YASAK karakterler: : \\ / ? * [ ]
const FORBIDDEN_SHEET_CHARS = /[:\\/?*[\]]/g;
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);
const EXCEL_LEAP_BUG_CUTOFF_UTC = Date.UTC(1900, 2, 1);
const MS_PER_DAY = 86400000;

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Denetim karakterleri XML 1.0'da geçersizdir; kaynak veriden gelen tek bir
    // kaçış baytı dosyayı tümüyle açılamaz yapardı.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
}

/** `1 → A`, `27 → AA` (1 tabanlı sütun numarası). */
export function columnLetter(index) {
  let remaining = Math.max(1, Math.floor(index));
  let letters = '';
  while (remaining > 0) {
    const modulo = (remaining - 1) % 26;
    letters = String.fromCharCode(65 + modulo) + letters;
    remaining = Math.floor((remaining - modulo - 1) / 26);
  }
  return letters;
}

/**
 * `YYYY-MM-DD` → Excel seri numarası (1899-12-30 tabanlı).
 *
 * Takvimde OLMAYAN gün `null` döner ve hücre metin olarak yazılır. `Date.UTC`
 * taşan alanları sessizce devreder: `2026-02-30` 2 Mart'a, `2026-00-10` ise bir
 * önceki YILA kayıyordu. Bozuk bir tarih, çıktıda bozuk göründüğünde fark
 * edilir; makul görünen BAŞKA bir tarihe dönüştüğünde edilmez.
 */
export function excelSerialDate(value) {
  const text = String(value ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(utc)) return null;
  const rolled = new Date(utc);
  if (rolled.getUTCFullYear() !== year
    || rolled.getUTCMonth() !== month - 1
    || rolled.getUTCDate() !== day) return null;
  // Excel'in 1900 tarih sistemi, var olmayan 29 Şubat 1900 gününü seri 60
  // olarak ayırır. Bu tarihten önce gerçek takvim farkından bir çıkarılır;
  // böylece 1 Ocak 1900 seri 1 olur. Daha eski günler Excel'de tarih değildir.
  let serial = Math.round((utc - EXCEL_EPOCH_UTC) / MS_PER_DAY);
  if (utc < EXCEL_LEAP_BUG_CUTOFF_UTC) serial -= 1;
  return serial >= 1 ? serial : null;
}

/**
 * Elektronik tablo formülü enjeksiyonuna karşı nötrleme. `=`, `+`, `-`, `@`
 * ile başlayan metin, hücreye kesme işaretiyle yazılır.
 */
export function neutralizeCellText(value) {
  const text = value == null ? '' : String(value);
  return /^[\t\r\n ]*[=+\-@]/.test(text) ? `'${text}` : text;
}

/** Sayfa adı: yasak karakterler temizlenir, 31 karakterde kırpılır, tekilleştirilir. */
export function normalizeSheetName(value, used = new Set()) {
  const base = String(value || 'Sayfa').replace(FORBIDDEN_SHEET_CHARS, ' ').trim().slice(0, SHEET_NAME_LIMIT) || 'Sayfa';
  let name = base;
  let counter = 2;
  while (used.has(name.toLocaleLowerCase('tr-TR'))) {
    const suffix = ` (${counter})`;
    name = `${base.slice(0, SHEET_NAME_LIMIT - suffix.length)}${suffix}`;
    counter += 1;
  }
  used.add(name.toLocaleLowerCase('tr-TR'));
  return name;
}

/* ── Biçemler ─────────────────────────────────────────────
   0 gövde metni · 1 başlık · 2 tarih · 3 yüzde · 4 sayı
   5 rapor başlığı · 6 etiket (kalın) · 7 vurgulu gövde       */
const STYLE = Object.freeze({
  body: 1,
  header: 2,
  date: 3,
  percent: 4,
  number: 5,
  title: 6,
  label: 7,
  subtle: 8
});

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts>
<fonts count="4">
<font><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="15"/><color rgb="FF1B3A6B"/><name val="Calibri"/><family val="2"/></font>
<font><sz val="11"/><color rgb="FF5A6675"/><name val="Calibri"/><family val="2"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF2F6FED"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEEF4FF"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFD8DEE8"/></left><right style="thin"><color rgb="FFD8DEE8"/></right><top style="thin"><color rgb="FFD8DEE8"/></top><bottom style="thin"><color rgb="FFD8DEE8"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
<xf numFmtId="9" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function cellXml(reference, value, style) {
  if (value == null || value === '') return `<c r="${reference}" s="${style}"/>`;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${reference}" s="${style}"><v>${value}</v></c>`;
  }
  return `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

/** Bir hücre tanımını `{value, style}` çiftine indirger. */
function resolveCell(rawValue, type) {
  if (type === 'date') {
    const serial = excelSerialDate(rawValue);
    return serial == null
      ? { value: rawValue ? neutralizeCellText(rawValue) : '', style: STYLE.body }
      : { value: serial, style: STYLE.date };
  }
  if (type === 'percent') {
    const numeric = rawValue == null || rawValue === '' ? null : Number(rawValue);
    return Number.isFinite(numeric)
      ? { value: numeric / 100, style: STYLE.percent }
      : { value: '', style: STYLE.percent };
  }
  if (type === 'number') {
    const numeric = rawValue == null || rawValue === '' ? null : Number(rawValue);
    return Number.isFinite(numeric)
      ? { value: numeric, style: STYLE.number }
      : { value: '', style: STYLE.number };
  }
  // Tür verilmemiş bir hücrede GERÇEK sayı yine sayı olarak yazılır: özet
  // sayfasındaki sayaçlar metin hücresine düştüğünde Excel onları toplayamıyor
  // ve "sayı metin olarak saklanmış" uyarısı gösteriyordu.
  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
    return { value: rawValue, style: STYLE.number };
  }
  return { value: neutralizeCellText(rawValue), style: STYLE.body };
}

function sheetXml(sheet) {
  const columns = sheet.columns || [];
  const rows = sheet.rows || [];
  const lastColumn = columnLetter(Math.max(1, columns.length));
  const lines = [];

  // Rapor başlığı ve alt satırı, tabloyu iterek yazılır; başlık satırı bu
  // yüzden değişken bir satır numarasında durur ve dondurma/süzgeç başvuruları
  // ondan türetilir.
  const leadRows = [];
  if (sheet.title) leadRows.push({ text: sheet.title, style: STYLE.title });
  for (const note of sheet.notes || []) leadRows.push({ text: note, style: STYLE.subtle });
  if (leadRows.length) leadRows.push(null); // boş ayraç satırı

  leadRows.forEach((lead, index) => {
    const rowNumber = index + 1;
    if (!lead) {
      lines.push(`<row r="${rowNumber}"/>`);
      return;
    }
    lines.push(`<row r="${rowNumber}">${cellXml(`A${rowNumber}`, lead.text, lead.style)}</row>`);
  });

  const headerRowNumber = leadRows.length + 1;
  lines.push(`<row r="${headerRowNumber}" ht="22" customHeight="1">${columns
    .map((column, index) => cellXml(`${columnLetter(index + 1)}${headerRowNumber}`, column.header, STYLE.header))
    .join('')}</row>`);

  rows.forEach((row, rowIndex) => {
    const rowNumber = headerRowNumber + rowIndex + 1;
    const cells = columns.map((column, columnIndex) => {
      // Tür sütundan gelir; `typeKey` verilmişse SATIRDAN okunur. Özet
      // sayfasında değer sütunu satır satır sayı, tarih ya da yüzde taşır ve
      // metne çevrilseydi Excel'de sıralama, tarih aritmetiği ve toplama
      // çalışmazdı.
      const type = column.typeKey ? row[column.typeKey] : column.type;
      const { value, style } = resolveCell(row[column.key], type);
      return cellXml(`${columnLetter(columnIndex + 1)}${rowNumber}`, value, style);
    }).join('');
    lines.push(`<row r="${rowNumber}">${cells}</row>`);
  });

  const lastRowNumber = headerRowNumber + rows.length;
  const colsXml = columns.length
    ? `<cols>${columns.map((column, index) => `<col min="${index + 1}" max="${index + 1}" width="${Number(column.width) || 16}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const frozenPane = `<pane ySplit="${headerRowNumber}" topLeftCell="A${headerRowNumber + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${headerRowNumber + 1}" sqref="A${headerRowNumber + 1}"/>`;
  const autoFilter = sheet.autoFilter === false || !columns.length
    ? ''
    : `<autoFilter ref="A${headerRowNumber}:${lastColumn}${Math.max(headerRowNumber, lastRowNumber)}"/>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${lastColumn}${Math.max(1, lastRowNumber)}"/>
<sheetViews><sheetView workbookViewId="0" ${sheet.active ? 'tabSelected="1" ' : ''}showGridLines="0">${frozenPane}</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
${colsXml}
<sheetData>${lines.join('')}</sheetData>
${autoFilter}
<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>
</worksheet>`;
}

function workbookXml(sheets) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<workbookPr/>
<sheets>${sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets>
</workbook>`;
}

function contentTypesXml(sheets) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets.map((sheet, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
}

function workbookRelsXml(sheets) {
  const sheetRels = sheets.map((sheet, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRels}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
}

/**
 * `sheets`: `{ name, title?, notes?, columns:[{header,key,width,type}], rows, autoFilter? }`
 * Dönüş: `.xlsx` içeriği (`Uint8Array`).
 */
export function buildXlsxWorkbook({ title = 'MERGEN Rota', creator = 'MERGEN Rota', sheets = [], modifiedAt = new Date() } = {}) {
  const usedNames = new Set();
  const normalized = (sheets.length ? sheets : [{ name: 'Sayfa1', columns: [], rows: [] }])
    .map((sheet, index) => ({ ...sheet, name: normalizeSheetName(sheet.name, usedNames), active: index === 0 }));
  const timestamp = (modifiedAt instanceof Date && Number.isFinite(modifiedAt.getTime()) ? modifiedAt : new Date()).toISOString();

  const files = [
    {
      name: '[Content_Types].xml',
      data: encodeUtf8(contentTypesXml(normalized))
    },
    {
      name: '_rels/.rels',
      data: encodeUtf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`)
    },
    {
      name: 'docProps/core.xml',
      data: encodeUtf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${escapeXml(title)}</dc:title><dc:creator>${escapeXml(creator)}</dc:creator><cp:lastModifiedBy>${escapeXml(creator)}</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:modified>
</cp:coreProperties>`)
    },
    {
      name: 'docProps/app.xml',
      data: encodeUtf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>${escapeXml(creator)}</Application></Properties>`)
    },
    { name: 'xl/workbook.xml', data: encodeUtf8(workbookXml(normalized)) },
    { name: 'xl/_rels/workbook.xml.rels', data: encodeUtf8(workbookRelsXml(normalized)) },
    { name: 'xl/styles.xml', data: encodeUtf8(STYLES_XML) },
    ...normalized.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: encodeUtf8(sheetXml(sheet))
    }))
  ];

  return buildZipArchive(files, { modifiedAt });
}

export const XLSX_STYLE_IDS = STYLE;
