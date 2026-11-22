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

/** Parçayı yalnızca bir kez ayrıştırır ve hatalı XML'i tüketiciye bırakmaz. */
export function parseDocxXml(source, name) {
  assert.doesNotMatch(source, /<!DOCTYPE\b/u, name + ': DTD yasak');
  const document = new DOMParser().parseFromString(source, 'application/xml');
  assert.ok(document.documentElement && !document.getElementsByTagNameNS(
    'http://www.mozilla.org/newlayout/xml/parsererror.xml', 'parsererror'
  ).length, name + ': bozuk XML');
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

function readRelationships(document, name, pkg) {
  const root = assertRoot(document, REL, 'Relationships', name);
  const source = relationshipSource(name);
  assert.ok(!source || pkg.has(source), name + ': ilişki kaynağı yok');
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
    assert.ok(target && !/[\u0000-\u001f\\%:?#]/u.test(target) && !target.startsWith('//'),
      name + ': ilişki hedefi geçersiz');
    const resolved = target.startsWith('/') ? posix.normalize(target.slice(1)) : posix.normalize(posix.join(posix.dirname(source), target));
    assert.ok(pkg.has(resolved), name + ': ilişki hedefi pakette yok: ' + resolved);
    rows.set(id, { type, target: resolved });
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

/** Yalnızca kanonik şablonun yerel sayfa ve başlık sayaçlarına izin verir; revizyon ve gizli metni reddeder. */
function checkWordFields(document, name) {
  const disallowed = [
    'w:object', 'o:OLEObject', 'w:altChunk', 'w:hyperlink', 'w:attachedTemplate', 'w:updateFields',
    'w:instrText', 'w:delInstrText', 'w:fldChar',
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
  // Zorunlu metni gizleyebilecek doğrudan ya da stil tabanlı gizleme biçimleri yasaktır.
  for (const hiddenTag of ['w:vanish', 'w:webHidden']) {
    for (const element of all(document, hiddenTag)) {
      assert.equal(on(element), false, name + ': gizli metin biçimi yasak (' + hiddenTag + ')');
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
      return all(node, 'w:t').map((t) => t.textContent).join('');
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

/** Okunabilir XML parçalarını ve paket içi bağlantıları kanonik DOCX sözleşmesine göre denetler. */
export function validateDocxXml(pkg) {
  const documents = new Map();
  const relations = new Map();
  for (const name of pkg.names) {
    assert.doesNotMatch(name, /vbaProject|embeddings\/|activeX|oleObject/iu, name);
    if (!/\.(xml|rels|svg)$/iu.test(name)) continue;
    const document = parseDocxXml(pkg.text(name), name);
    documents.set(name, document);
    checkWordFields(document, name);
    if (/\.rels$/iu.test(name)) relations.set(name, readRelationships(document, name, pkg));
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
      assert.ok(part?.startsWith('/') && pkg.has(part.slice(1)) && !overrides.has(part), 'geçersiz içerik türü parçası');
      overrides.set(part, type);
    } else {
      const extension = attr(element, 'Extension')?.toLowerCase();
      assert.ok(element.localName === 'Default' && extension && !defaults.has(extension), 'geçersiz varsayılan içerik türü');
      defaults.set(extension, type);
    }
  }
  const contentType = (name) => overrides.get('/' + name)
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
