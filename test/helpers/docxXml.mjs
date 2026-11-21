import assert from 'node:assert/strict';
import { posix } from 'node:path';
import { JSDOM } from 'jsdom';

const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
const MAIN_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const { DOMParser } = new JSDOM('').window;
const namespaces = {
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  asvg: 'http://schemas.microsoft.com/office/drawing/2016/SVG/main',
  cp: 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties',
  custom: 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties',
  dc: 'http://purl.org/dc/elements/1.1/',
  ep: 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties',
  o: 'urn:schemas-microsoft-com:office:office',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  svg: 'http://www.w3.org/2000/svg',
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'
};

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
    assert.ok(id && !rows.has(id) && type, name + ': ilişki kimliği veya türü geçersiz');
    assert.doesNotMatch(type, /vbaProject|activeX|oleObject|\/package$/iu, name + ': ilişki türü yasak');
    assert.ok(target && !/[\u0000-\u001f\\%:?#]/u.test(target) && !target.startsWith('//'),
      name + ': ilişki hedefi geçersiz');
    const resolved = target.startsWith('/') ? posix.normalize(target.slice(1)) : posix.normalize(posix.join(posix.dirname(source), target));
    assert.ok(pkg.has(resolved), name + ': ilişki hedefi pakette yok: ' + resolved);
    rows.set(id, { type, target: resolved });
  }
  return rows;
}

/** Yalnızca kanonik şablonun yerel sayfa ve başlık sayaçlarına izin verir. */
function checkWordFields(document, name) {
  for (const tag of ['w:object', 'o:OLEObject', 'w:altChunk', 'w:hyperlink', 'w:attachedTemplate', 'w:updateFields',
    'w:instrText', 'w:delInstrText', 'w:fldChar']) {
    assert.equal(all(document, tag).length, 0, name + ': izin verilmeyen öğe ' + tag);
  }
  const fields = all(document, 'w:fldSimple');
  const allowed = {
    'word/document.xml': ['SEQ Şekil \\* ARABIC', 'SEQ Tablo \\* ARABIC'],
    'word/footer1.xml': ['PAGE', 'NUMPAGES']
  };
  assert.deepEqual(fields.map((field) => (attr(field, 'w:instr') ?? '').trim().replace(/\s+/gu, ' ')),
    allowed[name] ?? [], name + ': Word alan komutları');
}

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
  const contentType = (name) => overrides.get('/' + name) ?? defaults.get(posix.extname(name).slice(1).toLowerCase());
  for (const name of pkg.names) {
    if (name === '[Content_Types].xml') continue;
    const type = /\.rels$/iu.test(name) ? defaults.get('rels') : contentType(name);
    assert.ok(type, name + ': içerik türü eksik');
  }
  assert.equal(overrides.get('/word/document.xml'), MAIN_TYPE, 'ana belge içerik türü');
  assertRoot(xml('word/document.xml'), namespaces.w, 'document', 'word/document.xml');
  const rootRelationships = [...(relations.get('_rels/.rels') ?? new Map()).values()];
  assert.deepEqual(rootRelationships.filter(({ type }) => type === namespaces.r + '/officeDocument')
    .map(({ target }) => target), ['word/document.xml'], 'paket kökü ana belge ilişkisi');

  return {
    xml,
    contentType,
    documentRelationship: (id, type) => {
      const relation = relations.get('word/_rels/document.xml.rels')?.get(id);
      assert.equal(relation?.type, namespaces.r + '/' + type, 'ana belge ilişki türü: ' + id);
      return relation.target;
    }
  };
}
