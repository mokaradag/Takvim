import assert from 'node:assert/strict';
import { posix } from 'node:path';
import { JSDOM } from 'jsdom';

const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL_TYPE = 'application/vnd.openxmlformats-package.relationships+xml';
const TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
const MAIN_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const { DOMParser, XMLSerializer } = new JSDOM('').window;
const namespaces = {
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  asvg: 'http://schemas.microsoft.com/office/drawing/2016/SVG/main',
  cp: 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties',
  custom: 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties',
  dc: 'http://purl.org/dc/elements/1.1/',
  dcterms: 'http://purl.org/dc/terms/',
  ep: 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  o: 'urn:schemas-microsoft-com:office:office',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  svg: 'http://www.w3.org/2000/svg',
  v: 'urn:schemas-microsoft-com:vml',
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'
};

/** Ayrıştırılmış XML belgesini diziye çevirir (sınama mutasyonları için). */
export function serializeDocxXml(document) {
  return new XMLSerializer().serializeToString(document);
}

function qualified(tag) {
  const [prefix, local] = tag.split(':');
  return local ? [namespaces[prefix], local] : [null, prefix];
}

/** Belirtilen ad alanındaki alt öğeleri belge sırasıyla döndürür. */
export function all(element, tag) {
  return [...element.getElementsByTagNameNS(...qualified(tag))];
}

/** Belirtilen ad alanındaki doğrudan çocukları döndürür. */
export function children(element, tag) {
  const [ns, local] = qualified(tag);
  return element ? [...element.children].filter((node) => node.namespaceURI === ns && node.localName === local) : [];
}

/** İlk eşleşen doğrudan çocuğu, yoksa null döndürür. */
export function child(element, tag) {
  return children(element, tag)[0] ?? null;
}

/** Özniteliği XML önekinin yazımından bağımsız okur. */
export function attr(element, name = 'w:val') {
  return element?.getAttributeNS(...qualified(name)) ?? null;
}

/** Word aç/kapa öğesinde boş değer özniteliği ile özniteliğin yokluğu farklıdır. */
export function on(element) {
  if (!element) return false;
  const value = attr(element);
  assert.ok([null, 'true', 'false', '1', '0', 'on', 'off'].includes(value), 'Word aç/kapa değeri geçersiz');
  return [null, 'true', '1', 'on'].includes(value);
}

/** Parçayı yalnızca bir kez ayrıştırır; hatalı XML ile gizli yorum/işleme yönergesi düğümlerini reddeder. */
export function parseDocxXml(source, name) {
  assert.doesNotMatch(source, /<!DOCTYPE\b/u, name + ': DTD yasak');
  const document = new DOMParser().parseFromString(source, 'application/xml');
  assert.ok(document.documentElement && !document.getElementsByTagNameNS(
    'http://www.mozilla.org/newlayout/xml/parsererror.xml', 'parsererror'
  ).length, name + ': bozuk XML');
  const stack = [...document.childNodes];
  while (stack.length > 0) {
    const node = stack.pop();
    assert.notEqual(node.nodeType, 8, name + ': gizli XML yorumu yasak');
    assert.notEqual(node.nodeType, 7, name + ': XML işleme yönergesi yasak');
    assert.notEqual(node.nodeType, 4, name + ': XML CDATA bölümü yasak');
    if (node.childNodes?.length) {
      for (let i = 0; i < node.childNodes.length; i += 1) stack.push(node.childNodes[i]);
    }
  }
  return document;
}

function assertRoot(document, namespaceURI, localName, name) {
  const root = document.documentElement;
  assert.ok(root.namespaceURI === namespaceURI && root.localName === localName, name + ': kök öğe geçersiz');
  return root;
}

function relationshipSource(name) {
  if (name === '_rels/.rels') return '';
  const match = /^(.*\/)?_rels\/([^/]+)\.rels$/iu.exec(name);
  assert.ok(match, name + ': ilişki parçası yolu geçersiz');
  return (match[1] ?? '') + match[2];
}

/** OPC parça adı eşdeğerliği için ASCII büyük/küçük harf katlaması uygular. */
function toAsciiLower(value) {
  return value.replace(/[A-Z]/gu, (ch) => ch.toLowerCase());
}

function readRelationships(document, name, partByAsciiLower) {
  const root = assertRoot(document, REL, 'Relationships', name);
  const source = relationshipSource(name);
  assert.ok(!source || partByAsciiLower.has(toAsciiLower(source)), name + ': ilişki kaynağı yok');
  const rows = new Map();
  for (const element of root.children) {
    assert.ok(element.namespaceURI === REL && element.localName === 'Relationship', name + ': ilişki öğesi geçersiz');
    const id = attr(element, 'Id');
    const target = attr(element, 'Target');
    const type = attr(element, 'Type');
    const mode = attr(element, 'TargetMode');
    assert.ok(mode === null || mode === 'Internal', name + ': dış ilişki yasak');
    assert.ok(
      id && /^[A-Za-z_\p{L}][A-Za-z0-9._\-\p{L}\p{N}]*$/u.test(id) && !rows.has(id) && type,
      name + ': ilişki kimliği veya türü geçersiz'
    );
    assert.doesNotMatch(type, /vbaProject|activeX|oleObject|\/package$/iu, name + ': ilişki türü yasak');
    assert.ok(target && !/[\u0000-\u001f\\%:?#]/u.test(target), name + ': ilişki hedefi geçersiz');
    const segments = (target.startsWith('/') ? target.slice(1) : target).split('/');
    assert.ok(segments.every(Boolean) && !/^\.{1,2}$/u.test(segments.at(-1)), name + ': ilişki hedefi geçersiz');
    const path = target.startsWith('/') ? [] : source.split('/').slice(0, -1);
    for (const segment of segments) {
      if (segment === '..') {
        assert.ok(path.length, name + ': ilişki hedefi paket kökünü aşıyor');
        path.pop();
      } else if (segment !== '.') {
        path.push(segment);
      }
    }
    const resolved = path.join('/');
    const actualTarget = partByAsciiLower.get(toAsciiLower(resolved));
    assert.ok(actualTarget, name + ': ilişki hedefi pakette yok: ' + resolved);
    rows.set(id, { type, target: actualTarget });
  }
  return rows;
}

function enclosingParagraph(node) {
  let current = node.parentNode;
  while (current) {
    if (current.namespaceURI === namespaces.w && current.localName === 'p') return current;
    current = current.parentNode;
  }
  return null;
}

/** Yalnızca kanonik şablonun yerel sayfa ve başlık sayaçlarına izin verir; revizyon, dış veri bağlantısı ve gizli metni reddeder. */
function checkWordFields(document, name) {
  const disallowed = [
    'w:object', 'o:OLEObject', 'w:altChunk', 'w:hyperlink', 'w:attachedTemplate', 'w:updateFields',
    'w:instrText', 'w:delInstrText', 'w:fldChar', 'w:sym',
    // Veri bağlantısı, gizli belge değişkeni, dış şema/çerçeve ve koşullu işaretleme dalları kanonik şablonda yasaktır.
    'w:mailMerge', 'w:docVars', 'w:docVar', 'w:dataBinding', 'w:subDoc', 'w:control',
    'w:frameset', 'w:attachedSchema', 'w:saveThroughXslt',
    'mc:AlternateContent', 'mc:Choice', 'mc:Fallback',
    // İzlenen değişiklikler, taşınan aralıklar, biçim revizyonları ve açıklamalar kanonik şablonda bulunamaz.
    'w:del', 'w:delText', 'w:ins', 'w:moveFrom', 'w:moveTo',
    'w:moveFromRangeStart', 'w:moveFromRangeEnd', 'w:moveToRangeStart', 'w:moveToRangeEnd',
    'w:rPrChange', 'w:pPrChange', 'w:sectPrChange', 'w:tblPrChange', 'w:trPrChange', 'w:tcPrChange',
    'w:cellDel', 'w:cellIns', 'w:cellMerge',
    'w:commentReference', 'w:commentRangeStart', 'w:commentRangeEnd'
  ];
  for (const tag of disallowed) {
    assert.equal(all(document, tag).length, 0, name + ': izin verilmeyen öğe ' + tag);
  }
  // Zorunlu metni veya paragraf sonunu gizleyebilecek doğrudan ya da stil tabanlı gizleme biçimleri yasaktır.
  for (const hiddenTag of ['w:vanish', 'w:webHidden', 'w:specVanish']) {
    for (const element of all(document, hiddenTag)) {
      assert.equal(on(element), false, name + ': gizli metin biçimi yasak (' + hiddenTag + ')');
    }
  }
  // Başında veya sonunda boşluk bulunan her w:t öğesi Word'ün boşlukları kırpmaması için xml:space="preserve" taşımalıdır.
  for (const textNode of all(document, 'w:t')) {
    if (/^\s|\s$/u.test(textNode.textContent)) {
      assert.equal(
        textNode.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'space'),
        'preserve',
        `${name}: kenar boşluklu w:t öğesinde xml:space="preserve" zorunludur ("${textNode.textContent}")`
      );
    }
  }
  // Şablon metninin düzenlenmesini engelleyen içerik denetimi kilitleri yasaktır.
  for (const lock of all(document, 'w:lock')) {
    const lockVal = attr(lock, 'w:val');
    assert.ok(!['sdtContentLocked', 'contentLocked'].includes(lockVal),
      name + ': içerik düzenlemeyi engelleyen denetim kilidi yasak (' + lockVal + ')');
  }
  const fields = all(document, 'w:fldSimple');
  const allowed = {
    'word/document.xml': ['SEQ Şekil \\* ARABIC', 'SEQ Tablo \\* ARABIC'],
    'word/footer1.xml': ['PAGE', 'NUMPAGES']
  };
  const instructions = fields.map((field) => (attr(field, 'w:instr') ?? '').trim().replace(/\s+/gu, ' '));
  assert.deepEqual(instructions, allowed[name] ?? [], name + ': Word alan komutları');

  // İzinli sayaç alanlarının kilidi kapalı olmalı ve önbellekteki görünür metni yalnızca boş ya da sayısal olmalıdır.
  for (const [index, field] of fields.entries()) {
    const fldLock = attr(field, 'w:fldLock');
    assert.ok([null, 'false', '0', 'off'].includes(fldLock),
      name + ': kilitli Word alanı yasak (w:fldLock=' + fldLock + ')');
    const cached = all(field, 'w:t').map((node) => node.textContent).join('').trim();
    assert.match(cached, /^\d*$/u, name + ': Word alan sonucu sayısal veya boş olmalıdır');
    const paragraph = enclosingParagraph(field);
    assert.ok(paragraph, name + ': Word alanı paragraf içinde olmalıdır');
    const style = attr(child(child(paragraph, 'w:pPr'), 'w:pStyle'));
    const ordered = [...paragraph.children].map((node) => {
      if (node === field) return '<FIELD>';
      return all(node, 'w:t').map((t) => t.textContent).join('');
    }).join('');
    const instr = instructions[index];
    if (name === 'word/document.xml' && instr === 'SEQ Şekil \\* ARABIC') {
      assert.equal(style, 'Caption', 'şekil sayacı başlık stilinde olmalıdır');
      assert.ok(ordered.startsWith('Şekil <FIELD>: ') && ordered.includes('{{SEKIL_1_BASLIGI}}'),
        'şekil sayacı Şekil etiketinden sonra ve şekil başlığında olmalıdır');
    } else if (name === 'word/document.xml' && instr === 'SEQ Tablo \\* ARABIC') {
      assert.equal(style, 'Caption', 'tablo sayacı başlık stilinde olmalıdır');
      assert.ok(ordered.startsWith('Tablo <FIELD>: ') && ordered.includes('{{TABLO_1_BASLIGI}}'),
        'tablo sayacı Tablo etiketinden sonra ve tablo başlığında olmalıdır');
    } else if (name === 'word/footer1.xml') {
      assert.equal(style, 'Footer', 'sayfa sayaçları alt bilgi paragrafında olmalıdır');
    }
  }
  if (name === 'word/footer1.xml') {
    const paragraph = enclosingParagraph(fields[0]);
    assert.equal(enclosingParagraph(fields[1]), paragraph, 'PAGE ve NUMPAGES aynı alt bilgi paragrafında olmalıdır');
    const parts = [...paragraph.children].map((node) => {
      if (node === fields[0]) return '<PAGE>';
      if (node === fields[1]) return '<NUMPAGES>';
      return [...node.getElementsByTagNameNS(namespaces.w, '*')].map((element) => {
        if (['br', 'cr', 'tab'].includes(element.localName)) return '\n';
        return element.localName === 't' ? element.textContent : '';
      }).join('');
    }).join('');
    assert.ok(parts.includes('Sayfa <PAGE> / <NUMPAGES>'), 'alt bilgide sayfa sayaç konumu geçersiz');
  }
}

const REQUIRED_ROOT_RELATIONS = [
  ['officeDocument', namespaces.r + '/officeDocument', MAIN_TYPE, namespaces.w, 'document'],
  ['core', 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
    'application/vnd.openxmlformats-package.core-properties+xml', namespaces.cp, 'coreProperties'],
  ['app', namespaces.r + '/extended-properties',
    'application/vnd.openxmlformats-officedocument.extended-properties+xml', namespaces.ep, 'Properties'],
  ['custom', namespaces.r + '/custom-properties',
    'application/vnd.openxmlformats-officedocument.custom-properties+xml', namespaces.custom, 'Properties']
];

const REQUIRED_DOCUMENT_RELATIONS = [
  ['styles', namespaces.r + '/styles', 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml', namespaces.w, 'styles'],
  ['settings', namespaces.r + '/settings', 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml', namespaces.w, 'settings'],
  ['fontTable', namespaces.r + '/fontTable', 'application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml', namespaces.w, 'fonts'],
  ['numbering', namespaces.r + '/numbering', 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml', namespaces.w, 'numbering'],
  ['theme', namespaces.r + '/theme', 'application/vnd.openxmlformats-officedocument.theme+xml', namespaces.a, 'theme']
];

/** ECMA-376 WordprocessingML karmaşık türleri için doğrudan alt öğe sırası (aynı sıra numarası yalnızca tekrarlanabilir veya karşılıklı dışlayan yuvalarda kullanılır). */
const OOXML_CHILD_SEQUENCES = new Map([
  ['tblPr', {
    order: {
      tblStyle: 0, tblpPr: 1, tblOverlap: 2, bidiVisual: 3, tblStyleRowBandSize: 4, tblStyleColBandSize: 5,
      tblW: 6, jc: 7, tblCellSpacing: 8, tblInd: 9, tblBorders: 10, shd: 11, tblLayout: 12, tblCellMar: 13,
      tblLook: 14, tblCaption: 15, tblDescription: 16, tblPrChange: 17
    }
  }],
  ['tblBorders', {
    order: { top: 0, start: 1, left: 2, bottom: 3, end: 4, right: 5, insideH: 6, insideV: 7 }
  }],
  ['tcBorders', {
    order: { top: 0, start: 1, left: 2, bottom: 3, end: 4, right: 5, insideH: 6, insideV: 7, tl2br: 8, tr2bl: 9 }
  }],
  ['tblCellMar', {
    order: { top: 0, start: 1, left: 2, bottom: 3, end: 4, right: 5 }
  }],
  ['tcMar', {
    order: { top: 0, start: 1, left: 2, bottom: 3, end: 4, right: 5 }
  }],
  ['pPr', {
    order: {
      pStyle: 0, keepNext: 1, keepLines: 2, pageBreakBefore: 3, framePr: 4, widowControl: 5, numPr: 6,
      suppressLineNumbers: 7, pBdr: 8, shd: 9, tabs: 10, suppressAutoHyphens: 11, kinsoku: 12, wordWrap: 13,
      overflowPunct: 14, topLinePunct: 15, autoSpaceDE: 16, autoSpaceDN: 17, bidi: 18, adjustRightInd: 19,
      snapToGrid: 20, spacing: 21, ind: 22, contextualSpacing: 23, mirrorIndents: 24, suppressOverlap: 25,
      jc: 26, textDirection: 27, textAlignment: 28, textboxTightWrap: 29, outlineLvl: 30, divId: 31,
      cnfStyle: 32, rPr: 33, sectPr: 34, pPrChange: 35
    }
  }],
  ['rPr', {
    order: {
      rStyle: 0, rFonts: 1, b: 2, bCs: 3, i: 4, iCs: 5, caps: 6, smallCaps: 7, strike: 8, dstrike: 9,
      outline: 10, shadow: 11, emboss: 12, imprint: 13, noProof: 14, snapToGrid: 15, vanish: 16,
      webHidden: 17, color: 18, spacing: 19, w: 20, kern: 21, position: 22, sz: 23, szCs: 24, highlight: 25,
      u: 26, effect: 27, bdr: 28, shd: 29, fitText: 30, vertAlign: 31, rtl: 32, cs: 33, em: 34, lang: 35,
      eastAsianLayout: 36, specVanish: 37, oMath: 38, rPrChange: 39
    }
  }],
  ['tcPr', {
    order: {
      cnfStyle: 0, tcW: 1, gridSpan: 2, hMerge: 3, vMerge: 4, tcBorders: 5, shd: 6, noWrap: 7, tcMar: 8,
      textDirection: 9, tcFitText: 10, vAlign: 11, hideMark: 12, headers: 13, cellIns: 14, cellDel: 15,
      cellMerge: 16, tcPrChange: 17
    }
  }],
  ['sectPr', {
    order: {
      headerReference: 0, footerReference: 0, footnotePr: 1, endnotePr: 2, type: 3, pgSz: 4, pgMar: 5,
      paperSrc: 6, pgBorders: 7, lnNumType: 8, pgNumType: 9, cols: 10, formProt: 11, vAlign: 12, noEndnote: 13,
      titlePg: 14, textDirection: 15, bidi: 16, rtlGutter: 17, docGrid: 18, printerSettings: 19, sectPrChange: 20
    },
    repeatable: new Set(['headerReference', 'footerReference'])
  }]
]);

/** WordprocessingML özellik kapsayıcılarının (tblPr, tblBorders, pPr, rPr, tcPr, sectPr vb.) ECMA-376 alt öğe sırasını doğrular. */
export function checkOoxmlElementOrder(document, name) {
  for (const parent of document.getElementsByTagNameNS(namespaces.w, '*')) {
    const spec = OOXML_CHILD_SEQUENCES.get(parent.localName);
    if (!spec) continue;
    let prevRank = -1;
    for (const node of parent.children) {
      if (node.namespaceURI !== namespaces.w) continue;
      const rank = spec.order[node.localName];
      assert.notEqual(rank, undefined, `${name}: w:${parent.localName} içinde tanınmayan alt öğe: w:${node.localName}`);
      const allowedSameRank = rank === prevRank && Boolean(spec.repeatable?.has(node.localName));
      assert.ok(rank > prevRank || allowedSameRank,
        `${name}: OOXML alt öğe sırası geçersiz (w:${parent.localName} içinde w:${node.localName})`);
      prevRank = rank;
    }
  }
}

/** Okunabilir XML parçalarını ve paket içi bağlantıları kanonik DOCX sözleşmesine göre denetler. */
export function validateDocxXml(pkg) {
  const documents = new Map();
  const relations = new Map();
  const partByAsciiLower = new Map(pkg.names.map((entryName) => [toAsciiLower(entryName), entryName]));
  for (const name of pkg.names) {
    assert.doesNotMatch(name, /vbaProject|embeddings\/|activeX|oleObject/iu, name);
    if (!/\.(xml|rels|svg)$/iu.test(name)) continue;
    const document = parseDocxXml(pkg.text(name), name);
    documents.set(name, document);
    checkWordFields(document, name);
    checkOoxmlElementOrder(document, name);
    if (/\.rels$/iu.test(name)) relations.set(name, readRelationships(document, name, partByAsciiLower));
  }

  const xml = (name) => {
    assert.ok(documents.has(name), 'XML parçası yok: ' + name);
    return documents.get(name);
  };
  const types = assertRoot(xml('[Content_Types].xml'), TYPES, 'Types', '[Content_Types].xml');
  const overrides = new Map();
  const defaults = new Map();
  for (const element of types.children) {
    const type = attr(element, 'ContentType');
    assert.ok(type && !/macroEnabled|vbaProject|oleObject/iu.test(type), 'izin verilmeyen içerik türü');
    assert.equal(element.namespaceURI, TYPES, 'içerik türü ad alanı');
    if (element.localName === 'Override') {
      const part = attr(element, 'PartName');
      const key = part?.startsWith('/') ? toAsciiLower(part.slice(1)) : null;
      assert.ok(key && partByAsciiLower.has(key) && !overrides.has(key), 'geçersiz içerik türü parçası');
      overrides.set(key, type);
    } else {
      const extension = attr(element, 'Extension')?.toLowerCase();
      assert.ok(element.localName === 'Default' && extension && !defaults.has(extension), 'geçersiz varsayılan içerik türü');
      defaults.set(extension, type);
    }
  }
  const contentType = (name) => overrides.get(toAsciiLower(name))
    ?? (/\.rels$/iu.test(name) ? defaults.get('rels') : defaults.get(posix.extname(name).slice(1).toLowerCase()));
  for (const name of pkg.names) {
    if (name === '[Content_Types].xml') continue;
    if (/\.rels$/iu.test(name)) {
      assert.equal(contentType(name), REL_TYPE, name + ': OPC ilişki içerik türü geçersiz');
      continue;
    }
    const type = contentType(name);
    assert.ok(type, name + ': içerik türü eksik');
  }

  const parts = new Map();
  const resolveSingleRelation = (relsName, key, relType, expectedContentType, rootNs, rootLocal, label) => {
    const rows = [...(relations.get(relsName) ?? new Map()).values()];
    const matches = rows.filter(({ type }) => type === relType);
    assert.equal(matches.length, 1, label + ': tekil ilişki zorunludur');
    const [{ target }] = matches;
    if (key === 'core') {
      assert.equal(rows.filter((relation) => relation.target === target).length, 1, 'OPC çekirdek özellik parçasına tek ilişki zorunludur');
    }
    assert.equal(contentType(target), expectedContentType, label + ': içerik türü geçersiz');
    assertRoot(xml(target), rootNs, rootLocal, target);
    parts.set(key, target);
    return target;
  };

  const mainPart = resolveSingleRelation('_rels/.rels', ...REQUIRED_ROOT_RELATIONS[0], 'paket kökü ana belge ilişkisi');
  assert.equal(mainPart, 'word/document.xml', 'paket kökü ana belge ilişkisi');
  for (const [key, relType, expectedContentType, rootNs, rootLocal] of REQUIRED_ROOT_RELATIONS.slice(1)) {
    resolveSingleRelation('_rels/.rels', key, relType, expectedContentType, rootNs, rootLocal, 'paket kökü ' + key + ' ilişkisi');
  }
  for (const [key, relType, expectedContentType, rootNs, rootLocal] of REQUIRED_DOCUMENT_RELATIONS) {
    resolveSingleRelation('word/_rels/document.xml.rels', key, relType, expectedContentType, rootNs, rootLocal, 'ana belge ' + key + ' ilişkisi');
  }

  return {
    xml,
    contentType,
    part: (key) => {
      assert.ok(parts.has(key), 'çözümlenmiş parça yok: ' + key);
      return parts.get(key);
    },
    documentRelationship: (id, type) => {
      const relation = relations.get('word/_rels/document.xml.rels')?.get(id);
      assert.equal(relation?.type, namespaces.r + '/' + type, 'ana belge ilişki türü: ' + id);
      return relation.target;
    }
  };
}
