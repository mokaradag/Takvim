/**
 * Bilgin Aşama 4I-0 · yönetici raporu temeli: kanonik stil belgesi, kanonik Word şablonu, rapor model rolleri ve
 * yol haritası belgeleri.
 *
 * Bu sınamalar rapor MOTORUNU değil (henüz yoktur), sonraki artımların dayanacağı sözleşmeleri sınar: YAML ile DOCX
 * aynı onaylı stili anlatır (sayfa, stil, renk, yazı tipi, yer tutucu, sabit metin, bölüm sırası, sürüm); kapak
 * yedigeni uygulamadaki yetkili yollardan türetilmiştir; şablonda kurum adı, makro, gömülü nesne ya da dış bağlantı
 * yoktur; rapor rollerinin adayları güncel model kaydında gerekli yeteneklerle bulunur ve hiçbir model ölçümsüz
 * "nitelikli" ilan edilmez.
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import yaml from 'js-yaml';
import { readDocxPackage, readZipEntries } from './helpers/docxPackage.mjs';
import { all, attr, child, children, on, parseDocxXml, serializeDocxXml, validateDocxXml } from './helpers/docxXml.mjs';
import { validateCoverPng } from './helpers/coverPng.mjs';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

registerServerOnlyShim();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(ROOT, relative), 'utf8');
const spec = yaml.load(await read('config/ai/bilgin_rapor_stili.yaml'), { schema: yaml.CORE_SCHEMA });
const docx = await readDocxPackage(path.join(ROOT, spec.sablon.dosya));
const { validateModelRegistry } = await import('../src/domain/ai/aiModelRegistry.js');
const { DEFAULT_AI_MODEL_REGISTRY } = await import('../src/server/ai/defaultModelRegistry.js');
const operationalRegistry = JSON.parse(await read('config/ai-model-registry.onprem.json'));

const { xml, contentType, part, documentRelationship } = validateDocxXml(docx);
const insideField = (node) => all(node.ownerDocument, 'w:fldSimple').some((field) => field.contains(node));
const PLACEHOLDER = /\{\{([A-Z0-9_]+)\}\}/g;

/** Palet anahtarı → onaltılık renk (stil belgesindeki adlandırmayla). */
function paletteColor(name) {
  const palette = spec.palet;
  if (['ana_lacivert', 'vurgu_turuncu', 'zemin'].includes(name)) return palette[name];
  if (palette.destek[name]) return palette.destek[name];
  if (palette.notr[name]) return palette.notr[name];
  const [family, step] = name.split('_');
  const value = palette.tonlar[family]?.[step];
  assert.ok(value, `bilinmeyen renk anahtarı: ${name}`);
  return value;
}

const ALLOWED_COLORS = new Set([
  spec.palet.ana_lacivert, spec.palet.vurgu_turuncu, spec.palet.zemin,
  ...Object.values(spec.palet.destek), ...Object.values(spec.palet.notr),
  ...Object.values(spec.palet.tonlar.lacivert), ...Object.values(spec.palet.tonlar.turuncu)
].map((value) => value.toUpperCase()));

/** Gövdedeki paragrafın görünen metni (alan sonuçları hariç). */
const paragraphText = (paragraph) => all(paragraph, 'w:t').filter((node) => !insideField(node)).map((node) => node.textContent).join('');
const paragraphStyle = (paragraph) => attr(child(child(paragraph, 'w:pPr'), 'w:pStyle'));

// ------------------------------------------------------------------ stil belgesi

test('stil belgesi: sürümlü, makinece okunur ve temel ilkeyi açıkça taşır', () => {
  assert.equal(spec.sema, 'bilgin-rapor-stili');
  assert.match(spec.surum, /^\d+\.\d+\.\d+$/);
  assert.equal(spec.sablon.surum, spec.sablon.belge_ozellikleri.BilginSablonSurumu);
  assert.equal(spec.surum, spec.sablon.belge_ozellikleri.BilginStilSurumu);
  assert.ok(spec.ilkeler.includes('Olgusal doğruluk yazımı sınırlar; yazımın yerine geçmez.'));
  assert.ok(spec.ilkeler.some((line) => line.includes('Düzyazıyı dil modeli yazar')), 'düzyazının sahibi modeldir');
  assert.ok(spec.ilkeler.some((line) => line.includes('kurum adı yazılmaz')));
  for (const term of ['notu', 'iletiler', 'değişiklik metinleri', 'belgeler', 'rapor başına açık rıza', 'başka rapora taşınmaz']) {
    assert.ok(spec.guvenlik.korunan_metin.includes(term), `korunan_metin rıza kuralı eksik: ${term}`);
  }
});

test('stil belgesi: ton adımları kurumsal formülle (renk × oran + beyaz × (1 − oran)) hesaplanmıştır', () => {
  const hex = (value) => [0, 2, 4].map((index) => Number.parseInt(value.slice(index, index + 2), 16));
  for (const [family, base] of [['lacivert', spec.palet.ana_lacivert], ['turuncu', spec.palet.vurgu_turuncu]]) {
    for (const [step, value] of Object.entries(spec.palet.tonlar[family])) {
      const ratio = Number(step) / 100;
      const expected = hex(base).map((channel) => Math.round(channel * ratio + 255 * (1 - ratio)));
      assert.deepEqual(hex(value), expected, `${family} %${step}`);
    }
  }
  for (const value of ALLOWED_COLORS) assert.match(value, /^[0-9A-F]{6}$/);
  assert.equal(spec.palet.ana_lacivert, '003087');
  assert.equal(spec.palet.vurgu_turuncu, 'FF5620');
});

test('stil belgesi: yer tutucuların sahibi ve türü kapalı sözlüktendir; her biri tam olarak bir bölüme aittir', () => {
  const owners = new Set(['sunucu', 'model', 'kullanici']);
  const kinds = new Set(['satir', 'anlati', 'kisa_metin', 'gorsel', 'tablo_satiri', 'logo']);
  for (const [name, entry] of Object.entries(spec.yer_tutucular)) {
    assert.match(name, /^[A-Z0-9_]+$/);
    assert.ok(owners.has(entry.sahip), name);
    assert.ok(kinds.has(entry.tur), name);
    assert.equal(typeof entry.zorunlu, 'boolean', name);
  }
  const listed = spec.yapi.bolumler.flatMap((section) => section.yer_tutucular || []);
  assert.equal(new Set(listed).size, listed.length, 'bir yer tutucu iki bölümde olamaz');
  assert.deepEqual([...listed].sort(), Object.keys(spec.yer_tutucular).sort());
  // Model düzyazısı yalnızca anlatı ve kısa metin yuvalarına yazılır; sayı, tablo ve görsel sunucunundur.
  for (const [name, entry] of Object.entries(spec.yer_tutucular)) {
    if (entry.sahip === 'model') assert.ok(['anlati', 'kisa_metin'].includes(entry.tur), name);
    if (['gorsel', 'tablo_satiri', 'logo'].includes(entry.tur)) assert.equal(entry.sahip, 'sunucu', name);
  }
});

function checkMandatorySections(styleSpec) {
  const byId = new Map(styleSpec.yapi.bolumler.map((section) => [section.kimlik, section]));
  assert.equal(byId.get('kaynak_ve_yontem').kaldirilamaz, true);
  for (const fixed of ['kaynak_ve_yontem_notu', 'zorunlu_bolumler', 'palet', 'yazi_tipi', 'stiller', 'bolum_sirasi']) {
    assert.ok(styleSpec.ozellestirme.sabit.includes(fixed), fixed);
  }
  for (const id of ['kapak', 'yonetici_degerlendirmesi', 'one_cikan_gelismeler', 'faaliyetler', 'genel_sonuc', 'kaynak_ve_yontem']) {
    assert.equal(byId.get(id)?.zorunlu, true, 'zorunlu bölüm kapatılamaz: ' + id);
  }
  const optionalIds = new Set(styleSpec.yapi.bolumler.filter((section) => section.zorunlu === false).map((section) => section.kimlik));
  for (const id of styleSpec.ozellestirme.serbest.bolumler) {
    assert.ok(byId.has(id), 'serbest bölüm kimliği tanımlı olmalıdır: ' + id);
    assert.ok(optionalIds.has(id), 'zorunlu bölüm serbest bölüm listesinde yer alamaz: ' + id);
  }
  assert.deepEqual([...styleSpec.ozellestirme.serbest.bolumler].sort(), [...optionalIds].sort(),
    'serbest.bolumler yalnızca tüm isteğe bağlı bölüm kimliklerini taşımalıdır');
  assert.match(styleSpec.yapi.bolum_kurallari.dengeli_sunum, /gizleyemez/);
}

test('stil belgesi: kaynak ve yöntem notu ile zorunlu bölümler sunum tercihiyle kapatılamaz', () => {
  checkMandatorySections(spec);
  for (const id of ['one_cikan_gelismeler', 'faaliyetler']) {
    const mutated = structuredClone(spec);
    mutated.yapi.bolumler.find((section) => section.kimlik === id).zorunlu = false;
    assert.throws(() => checkMandatorySections(mutated), new RegExp('zorunlu bölüm kapatılamaz: ' + id));
  }
  const mandatoryInFree = structuredClone(spec);
  mandatoryInFree.ozellestirme.serbest.bolumler.push('faaliyetler');
  assert.throws(() => checkMandatorySections(mandatoryInFree), /zorunlu bölüm serbest bölüm listesinde yer alamaz: faaliyetler/);
  const unknownInFree = structuredClone(spec);
  unknownInFree.ozellestirme.serbest.bolumler.push('kararlar');
  assert.throws(() => checkMandatorySections(unknownInFree), /serbest bölüm kimliği tanımlı olmalıdır: kararlar/);
});

test('stil belgesi: dört iddia sınıfı ve orantılı yerel onarım politikası tanımlıdır', () => {
  assert.deepEqual(Object.keys(spec.kanit.iddia_siniflari), ['nesnel_olgu', 'desteklenen_yorum', 'editoryal_dil', 'desteksiz_maddi_iddia']);
  const { onarim } = spec;
  assert.equal(onarim.birim, 'paragraf');
  for (const forbidden of ['butun_raporu_tek_ifade_icin_reddetmek', 'paragrafi_hazir_sunucu_metniyle_degistirmek',
    'akicilik_icin_uydurma_olguya_izin_vermek', 'birebir_cumle_eslesmesi_aramak']) {
    assert.ok(onarim.yasaklar.includes(forbidden), forbidden);
  }
  assert.deepEqual(onarim.kesin_kapilar, ['yetkisiz_aciklama', 'guvenlik_ihlali', 'cozulemeyen_kritik_olgu_hatasi']);
  const { paragraf_basina: perParagraph, rapor_basina: perReport } = onarim.deneme_butcesi;
  assert.ok(Number.isInteger(perParagraph) && Number.isInteger(perReport) && perParagraph >= 1 && perParagraph <= perReport);
  assert.deepEqual(onarim.adimlar.slice(-2), ['nitele_ya_da_cikar', 'inceleme_iste'], 'son çare taslağı korur, rapor düşmez');
});

test('stil belgesi: logo politikası mevcut ayarı korur, uydurmayı ve ağ kaynağını yasaklar, yeni uç eklemez', async () => {
  const { logo } = spec;
  assert.equal(logo.uydurma_yasak, true);
  const handler = await read('src/server/branding/companyLogo.js');
  assert.ok(handler.includes(logo.varyantlar.koyu_zemin.kaynak_ayari), 'koyu zemin varyantı mevcut logo ayarıdır');
  assert.equal(logo.varyantlar.acik_zemin.durum, 'bekleniyor');
  assert.equal(logo.kaynak_kurallari.dosya_turu, 'olagan_dosya', 'rapor logosu yalnızca olağan dosya olmalıdır');
  assert.equal(logo.kaynak_kurallari.url_kaynagi, 'yasak');
  assert.equal(logo.kaynak_kurallari.yeni_uc, 'yok');
  assert.equal(logo.eksik_logo.davranis, 'alan_bos_birakilir');
  assert.equal(logo.eksik_logo.ikame_gorsel, 'yasak');
  assert.equal(logo.yerlesim.yer_tutucu, 'KURUM_LOGOSU');
  // Logo sunan uç yalnızca mevcut olandır (4I-0 yeni uç eklemez).
  const routes = [];
  const walk = async (directory) => {
    for (const entry of await readdir(path.join(ROOT, directory), { withFileTypes: true })) {
      const relative = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) await walk(relative);
      else if (entry.name === 'route.js' && /[/-]logo(?:[/-]|$)/i.test(relative)) routes.push(relative);
    }
  };
  await walk('src/app/api');
  assert.deepEqual(routes, ['src/app/api/mergen-rota/company-logo/route.js']);
});

// ------------------------------------------------------------------ kanonik şablon

const ALLOWED_PACKAGE_PARTS = [
  '[Content_Types].xml',
  '_rels/.rels',
  'docProps/app.xml',
  'docProps/core.xml',
  'docProps/custom.xml',
  'word/_rels/document.xml.rels',
  'word/document.xml',
  'word/fontTable.xml',
  'word/footer1.xml',
  'word/footer2.xml',
  'word/header1.xml',
  'word/header2.xml',
  'word/numbering.xml',
  'word/settings.xml',
  'word/styles.xml',
  'word/theme/theme1.xml',
  ...spec.gorseller.kapak_yedigeni.medya
].sort();

function checkPackageParts(pkg) {
  assert.deepEqual([...pkg.names].sort(), ALLOWED_PACKAGE_PARTS, 'pakette ilan edilmemiş veya eksik parça var');
}

function checkDocumentSettings(settings) {
  for (const tag of ['w:documentProtection', 'w:writeProtection', 'w:readOnlyRecommended']) {
    assert.equal(all(settings, tag).length, 0, 'belgede düzenleme koruması yasak: ' + tag);
  }
  for (const element of all(settings, 'w:evenAndOddHeaders')) {
    assert.equal(on(element), false, 'çift sayfa üst/alt bilgi kipi kapalı olmalıdır');
  }
  for (const element of all(settings, 'w:trackRevisions')) {
    assert.equal(on(element), false, 'belgede değişiklik izleme (w:trackRevisions) kapalı olmalıdır');
  }
}

test('şablon: paket güvenliği, izinli parça kümesi, belge ayarları ve ana belge ilişkileri doğrulanır', () => {
  checkPackageParts(docx);
  assert.deepEqual(docx.names.filter((name) => name.startsWith('word/media/')).sort(), [...spec.gorseller.kapak_yedigeni.medya].sort());
  checkDocumentSettings(xml(part('settings')));
});

function checkHeaderFooter(partXml, relationship, section, settings) {
  assert.ok(on(child(section, 'w:titlePg')), 'kapak farklı ilk sayfadır');
  if (settings) checkDocumentSettings(settings);
  const allowedFirstPageTags = new Set(['p', 'pPr', 'pStyle', 'rPr', 'spacing', 'jc']);
  for (const [kind, rootTag] of [['header', 'w:hdr'], ['footer', 'w:ftr']]) {
    const references = children(section, 'w:' + kind + 'Reference');
    assert.equal(references.length, 2, kind + ': kapak ve gövde başvuruları');
    for (const [mode, index] of [['default', 1], ['first', 2]]) {
      const ref = references.find((item) => attr(item, 'w:type') === mode);
      const target = relationship(attr(ref, 'r:id'), kind);
      assert.equal(target, 'word/' + kind + index + '.xml', kind + ': ' + mode);
      const document = partXml(target);
      assert.equal(all(document, rootTag)[0], document.documentElement, target + ': parça kökü');
      if (mode === 'first') {
        assert.equal(all(document, 'w:t').map((node) => node.textContent).join('').trim(), '', target + ': kapakta boştur');
        // Kapak üst/alt bilgisinde metinsiz çizim, şekil veya tablo da bulunamaz.
        for (const element of document.documentElement.getElementsByTagName('*')) {
          assert.ok(element.namespaceURI === document.documentElement.namespaceURI
            && allowedFirstPageTags.has(element.localName),
          target + ': kapak üst/alt bilgisinde görünür içerik yasak (' + element.tagName + ')');
        }
      }
    }
  }
}

function checkSectionLayout(document) {
  const body = all(document, 'w:body')[0];
  const sect = all(document, 'w:sectPr');
  assert.equal(sect.length, 1, 'tek bölüm');
  assert.equal(body.lastElementChild, sect[0], 'son bölüm ayarları w:body sonunda doğrudan çocuk olmalıdır');
  const pgNumTypes = children(sect[0], 'w:pgNumType');
  assert.ok(pgNumTypes.length <= 1, 'bölümde en fazla bir w:pgNumType tanımı bulunabilir');
  if (pgNumTypes.length === 1) {
    const start = attr(pgNumTypes[0], 'w:start');
    assert.ok(start === null || start === '1', 'sayfa numaralandırması 1 ile başlamalıdır');
    const fmt = attr(pgNumTypes[0], 'w:fmt');
    assert.ok(fmt === null || fmt === 'decimal', 'sayfa numarası biçimi ondalık (decimal) veya varsayılan olmalıdır');
  }
  const columns = child(sect[0], 'w:cols');
  if (columns) {
    const count = attr(columns, 'w:num') ?? '1';
    const equalWidth = attr(columns, 'w:equalWidth');
    const explicitColumns = children(columns, 'w:col');
    assert.ok(/^\+?0*1$/u.test(count) && (['0', 'false', 'off'].includes(equalWidth)
      ? explicitColumns.length === 1 : explicitColumns.length <= 1),
    'bölüm tek sütunlu olmalıdır');
  }
  return sect[0];
}

function checkPageMargins(sect) {
  const margin = child(sect, 'w:pgMar');
  assert.ok(margin, 'sayfa kenar boşluğu tanımı zorunludur');
  for (const [side, key] of [['ust', 'w:top'], ['alt', 'w:bottom'], ['sol', 'w:left'], ['sag', 'w:right']]) {
    assert.equal(attr(margin, key), String(spec.sayfa.kenar_twip[side]), side);
  }
  assert.equal(attr(margin, 'w:header'), String(spec.sayfa.ust_bilgi_twip));
  assert.equal(attr(margin, 'w:footer'), String(spec.sayfa.alt_bilgi_twip));
  const gutter = attr(margin, 'w:gutter');
  assert.ok(gutter === null || gutter === '0', 'cilt payı (w:gutter) sıfır olmalıdır');
}

test('şablon: A4 dikey sayfa, kenar boşlukları, üst/alt bilgi uzaklığı ve boş kapak üst/alt bilgisi stil belgesiyle aynıdır', () => {
  const sect = checkSectionLayout(xml(part('officeDocument')));
  const size = child(sect, 'w:pgSz');
  assert.equal(attr(size, 'w:w'), String(spec.sayfa.genislik_twip));
  assert.equal(attr(size, 'w:h'), String(spec.sayfa.yukseklik_twip));
  assert.notEqual(attr(size, 'w:orient'), 'landscape');
  checkPageMargins(sect);
  checkHeaderFooter(xml, documentRelationship, sect, xml(part('settings')));
  for (const [name, type] of [['header1', 'header'], ['header2', 'header'], ['footer1', 'footer'], ['footer2', 'footer']]) {
    assert.equal(contentType('word/' + name + '.xml'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.' + type + '+xml');
  }
});

function checkStyles(styles) {
  const byId = new Map();
  for (const element of all(styles, 'w:style')) {
    const styleId = attr(element, 'w:styleId');
    assert.ok(styleId && !byId.has(styleId), 'yinelenen veya boş Word stil kimliği: ' + styleId);
    byId.set(styleId, element);
  }
  // Bütün stillerin w:basedOn zinciri geçerli bir üst stile bağlanmalı ve döngü içermemelidir.
  const inheritanceChain = (styleId) => {
    const visited = [];
    const seen = new Set();
    let currentId = styleId;
    while (currentId) {
      assert.ok(!seen.has(currentId), `döngüsel Word stil kalıtımı yasak: ${currentId}`);
      seen.add(currentId);
      const current = byId.get(currentId);
      assert.ok(current, `tanımsız üst Word stili: ${currentId}`);
      visited.push(current);
      const parentId = attr(child(current, 'w:basedOn'));
      if (parentId) {
        const parent = byId.get(parentId);
        assert.ok(parent, `${currentId}: tanımsız w:basedOn üst stili (${parentId})`);
        assert.equal(attr(parent, 'w:type'), attr(current, 'w:type'),
          `${currentId}: w:basedOn üst stil türü uyuşmuyor (${parentId})`);
      }
      currentId = parentId;
    }
    return visited;
  };
  for (const styleId of byId.keys()) inheritanceChain(styleId);
  const normal = byId.get('Normal');
  assert.ok(normal, 'temel Normal stili zorunludur');
  assert.equal(attr(child(normal, 'w:basedOn')), null, 'Normal stili başka bir stile dayanamaz');
  assert.equal(on(child(child(normal, 'w:pPr'), 'w:keepNext')), false, 'Normal stili keepNext taşımamalıdır');
  assert.equal(attr(child(child(normal, 'w:pPr'), 'w:outlineLvl')), null, 'Normal stili outlineLvl taşımamalıdır');

  const JC = { iki_yana: 'both', orta: 'center', sag: 'right' };
  for (const [id, entry] of Object.entries(spec.stiller)) {
    const element = byId.get(id);
    assert.ok(element, `stil yok: ${id}`);
    assert.equal(attr(child(element, 'w:name')), entry.ad, id);
    if (entry.tur === 'tablo') {
      assert.equal(attr(element, 'w:type'), 'table', id);
      assert.equal(attr(child(element, 'w:basedOn')), 'TableNormal', `${id}: tablo stili TableNormal üst stiline dayanmalıdır`);
      const conditional = (type) => children(element, 'w:tblStylePr').find((node) => attr(node, 'w:type') === type);
      assert.equal(attr(child(child(conditional('firstRow'), 'w:tcPr'), 'w:shd'), 'w:fill'), paletteColor(entry.baslik_satiri_zemini), id);
      assert.equal(attr(child(child(conditional('lastRow'), 'w:tcPr'), 'w:shd'), 'w:fill'), paletteColor(entry.toplam_satiri_zemini), id);
      const normalTable = byId.get('TableNormal');
      assert.equal(attr(normalTable, 'w:type'), 'table', 'temel TableNormal tablo stili zorunludur');
      assert.equal(child(normalTable, 'w:basedOn'), null, 'TableNormal başka bir stile dayanamaz');
      for (const tag of ['w:tblBorders', 'w:tcBorders', 'w:shd']) {
        assert.equal(all(normalTable, tag).length, 0, 'TableNormal kenarlık ya da gölge taşımamalıdır');
      }
      const borders = child(child(element, 'w:tblPr'), 'w:tblBorders');
      assert.ok(borders, id + ': tablo kenarlıkları zorunludur');
      assert.deepEqual([...borders.children].map((node) => [node.localName, attr(node, 'w:color')]), [
        ['top', paletteColor(entry.baslik_satiri_zemini)],
        ['bottom', paletteColor(entry.baslik_satiri_zemini)],
        ['insideH', paletteColor(entry.cizgi)]
      ], id + ': kurumsal tablo kenarlıkları');
      continue;
    }
    assert.equal(attr(element, 'w:type'), 'paragraph', id);
    const expectedParent = id === 'Normal' ? null : 'Normal';
    assert.equal(attr(child(element, 'w:basedOn')), expectedParent,
      id === 'Normal' ? 'Normal stili başka bir stile dayanamaz' : `${id}: paragraf stili Normal üst stiline dayanmalıdır`);
    if (id === 'BilginGovde') {
      for (const ancestor of inheritanceChain(id)) {
        const ancestorPpr = child(ancestor, 'w:pPr');
        assert.equal(on(child(ancestorPpr, 'w:keepNext')), false, 'BilginGovde başlık keepNext özelliğini miras alamaz');
        assert.equal(attr(child(ancestorPpr, 'w:outlineLvl')), null, 'BilginGovde başlık outlineLvl özelliğini miras alamaz');
        assert.equal(on(child(ancestorPpr, 'w:contextualSpacing')), false, 'BilginGovde bağlamsal aralıkla gövde boşluğunu kaldıramaz');
      }
    }
    const rPr = child(element, 'w:rPr');
    const pPr = child(element, 'w:pPr');
    assert.equal(attr(child(rPr, 'w:sz')), String(Math.round(entry.boyut * 2)), `${id} boyut`);
    assert.equal(attr(child(rPr, 'w:color')), paletteColor(entry.renk), `${id} renk`);
    assert.equal(on(child(rPr, 'w:b')), Boolean(entry.kalin), `${id} kalın`);
    assert.equal(on(child(rPr, 'w:i')), Boolean(entry.italik), `${id} italik`);
    const expectedTheme = entry.yazi === 'baslik' ? 'majorHAnsi' : 'minorHAnsi';
    const rFonts = child(rPr, 'w:rFonts');
    assert.equal(attr(rFonts, 'w:asciiTheme'), expectedTheme, `${id} yazı rolü (asciiTheme)`);
    assert.equal(attr(rFonts, 'w:hAnsiTheme'), expectedTheme, `${id} yazı rolü (hAnsiTheme)`);
    assert.equal(attr(rFonts, 'w:ascii'), null, `${id} doğrudan yazı tipi adı taşımaz`);
    assert.equal(attr(rFonts, 'w:hAnsi'), null, `${id} doğrudan High ANSI yazı tipi adı taşımaz`);
    const spacing = child(pPr, 'w:spacing');
    if (entry.once != null) assert.equal(attr(spacing, 'w:before'), String(Math.round(entry.once * 20)), `${id} önce`);
    if (entry.sonra != null) assert.equal(attr(spacing, 'w:after'), String(Math.round(entry.sonra * 20)), `${id} sonra`);
    if (entry.satir != null) {
      assert.equal(attr(spacing, 'w:line'), String(Math.round(entry.satir * 240)), `${id} satır`);
      assert.ok([null, 'auto'].includes(attr(spacing, 'w:lineRule')), `${id} satır aralığı kuralı auto olmalıdır`);
    }
    assert.equal(attr(child(pPr, 'w:jc')), entry.hiza ? JC[entry.hiza] : null, `${id} hiza`);
    assert.equal(on(child(pPr, 'w:pageBreakBefore')), Boolean(entry.yeni_sayfa), `${id} yeni sayfa`);
    const borders = child(pPr, 'w:pBdr');
    for (const [key, side] of [['ust_cizgi', 'w:top'], ['sol_cizgi', 'w:left'], ['alt_cizgi', 'w:bottom']]) {
      assert.equal(attr(child(borders, side), 'w:color'), entry[key] ? paletteColor(entry[key]) : null, `${id} ${key}`);
    }
    assert.equal(attr(child(pPr, 'w:shd'), 'w:fill'), entry.golge ? paletteColor(entry.golge) : null, `${id} gölge`);
  }
}

/** Belge gövdesinde ve üst/alt bilgilerde stil dışı doğrudan yazı boyutu geçersiz kılmalarını reddeder. */
function checkDirectFontSizes(document, name) {
  const coverAnchor = name === 'word/document.xml' ? all(document, 'w:body')[0]?.firstElementChild : null;
  for (const tag of ['w:sz', 'w:szCs']) {
    for (const element of all(document, tag)) {
      const allowedCoverSpacer = coverAnchor
        && coverAnchor.contains(element)
        && all(coverAnchor, 'w:t').length === 0
        && all(coverAnchor, 'wp:anchor').length === 1;
      assert.ok(allowedCoverSpacer, name + ': doğrudan yazı boyutu geçersiz kılması yasak (' + tag + ')');
    }
  }
}

/** BilginGovde paragraflarında stil tanımıyla çelişen doğrudan paragraf aralığı geçersiz kılmalarını reddeder. */
function checkDirectParagraphSpacing(document, name) {
  const govde = spec.stiller.BilginGovde;
  const expectedBefore = String(Math.round(govde.once * 20));
  const expectedAfter = String(Math.round(govde.sonra * 20));
  const expectedLine = String(Math.round(govde.satir * 240));
  for (const paragraph of all(document, 'w:p')) {
    if (paragraphStyle(paragraph) !== 'BilginGovde') continue;
    const properties = child(paragraph, 'w:pPr');
    assert.equal(on(child(properties, 'w:contextualSpacing')), false, name + ': BilginGovde bağlamsal aralık kapalı olmalıdır');
    const spacing = child(properties, 'w:spacing');
    if (!spacing) continue;
    const before = attr(spacing, 'w:before');
    const after = attr(spacing, 'w:after');
    const beforeLines = attr(spacing, 'w:beforeLines');
    const afterLines = attr(spacing, 'w:afterLines');
    const beforeAuto = attr(spacing, 'w:beforeAutospacing');
    const afterAuto = attr(spacing, 'w:afterAutospacing');
    const line = attr(spacing, 'w:line');
    const lineRule = attr(spacing, 'w:lineRule');
    assert.ok(before === null || before === expectedBefore, `${name}: BilginGovde doğrudan w:before çelişiyor`);
    assert.ok(after === null || after === expectedAfter, `${name}: BilginGovde doğrudan w:after çelişiyor`);
    assert.ok(beforeLines === null || (expectedBefore === '0' && beforeLines === '0'),
      `${name}: BilginGovde doğrudan w:beforeLines geçersiz kılması çelişiyor`);
    assert.ok(afterLines === null || (expectedAfter === '0' && afterLines === '0'),
      `${name}: BilginGovde doğrudan w:afterLines geçersiz kılması çelişiyor`);
    assert.ok([null, '0', 'false', 'off'].includes(beforeAuto),
      `${name}: BilginGovde doğrudan w:beforeAutospacing kapalı olmalıdır`);
    assert.ok([null, '0', 'false', 'off'].includes(afterAuto),
      `${name}: BilginGovde doğrudan w:afterAutospacing kapalı olmalıdır`);
    assert.ok(line === null || line === expectedLine, `${name}: BilginGovde doğrudan w:line çelişiyor`);
    assert.ok(lineRule === null || lineRule === 'auto', `${name}: BilginGovde doğrudan w:lineRule auto olmalıdır`);
  }
}

test('şablon: stil belgesindeki her Word stili aynı ad, yazı rolü, boyut, renk, aralık ve kenarlıkla tanımlıdır', () => {
  checkStyles(xml(part('styles')));
  for (const name of [part('officeDocument'), 'word/header1.xml', 'word/header2.xml', 'word/footer1.xml', 'word/footer2.xml']) {
    checkDirectFontSizes(xml(name), name);
  }
  checkDirectParagraphSpacing(xml(part('officeDocument')), part('officeDocument'));
});

function numberingLevel(numbering, styles, style) {
  const element = all(styles, 'w:style').find((node) => attr(node, 'w:styleId') === style);
  const properties = child(child(element, 'w:pPr'), 'w:numPr');
  const numId = attr(child(properties, 'w:numId'));
  assert.ok(typeof numId === 'string' && /^[1-9]\d*$/u.test(numId), style + ': numara kimliği pozitif tamsayı olmalıdır');
  const level = attr(child(properties, 'w:ilvl')) ?? '0';
  assert.equal(level, '0', style + ': numara düzeyi');
  const num = all(numbering, 'w:num').find((node) => attr(node, 'w:numId') === numId);
  assert.ok(num, style + ': numara tanımı yok');
  assert.equal(children(num, 'w:lvlOverride').length, 0, style + ': düzey geçersiz kılınamaz');
  const abstractId = attr(child(num, 'w:abstractNumId'));
  const definition = all(numbering, 'w:abstractNum').find((node) => attr(node, 'w:abstractNumId') === abstractId);
  return children(definition, 'w:lvl').find((node) => attr(node, 'w:ilvl') === level);
}

function checkNumbering(numbering, styles, body) {
  const headingLevel = numberingLevel(numbering, styles, 'Heading1');
  assert.equal(attr(child(headingLevel, 'w:numFmt')), 'decimalZero');
  assert.equal(attr(child(headingLevel, 'w:start')), '1', 'başlık numarası 01 ile başlar');
  assert.equal(attr(child(headingLevel, 'w:lvlText')), '%1', 'başlık numarası biçimi');
  assert.equal(attr(child(child(headingLevel, 'w:rPr'), 'w:color')), paletteColor(spec.stiller.Heading1.numara_rengi));
  for (const heading of all(body, 'w:p').filter((paragraph) => paragraphStyle(paragraph) === 'Heading1')) {
    assert.equal(child(child(heading, 'w:pPr'), 'w:numPr'), null, 'başlık numarası paragrafta değiştirilemez');
  }
  const bulletLevel = numberingLevel(numbering, styles, 'BilginListeMaddesi');
  assert.equal(attr(child(bulletLevel, 'w:numFmt')), 'bullet');
  assert.equal(attr(child(child(bulletLevel, 'w:rPr'), 'w:color')), paletteColor(spec.stiller.BilginListeMaddesi.madde_rengi));
}

test('şablon: bölüm numaraları 01 ile başlar, sıra ve madde işareti stillerden gelir', () => {
  checkNumbering(xml(part('numbering')), xml(part('styles')), xml(part('officeDocument')));
});

function checkDirectBodyFonts(document, name) {
  const nameAttributes = ['ascii', 'hAnsi', 'cs', 'eastAsia'];
  const themeAttributes = { asciiTheme: 'minorHAnsi', hAnsiTheme: 'minorHAnsi', csTheme: 'minorBidi', cstheme: 'minorBidi', eastAsiaTheme: 'minorEastAsia' };
  const profile = spec.yazi_tipi.profiller[spec.yazi_tipi.etkin_profil];
  for (const paragraph of all(document, 'w:p').filter((node) => paragraphStyle(node) === 'BilginGovde')) {
    for (const fonts of all(paragraph, 'w:rFonts')) {
      for (const key of nameAttributes) {
        assert.ok([null, profile.govde].includes(attr(fonts, 'w:' + key)), name + ': doğrudan gövde yazı tipi çelişiyor');
      }
      for (const [key, value] of Object.entries(themeAttributes)) {
        const allowed = ['asciiTheme', 'hAnsiTheme'].includes(key) ? [null, value, 'minorAscii'] : [null, value];
        assert.ok(allowed.includes(attr(fonts, 'w:' + key)), name + ': doğrudan gövde tema yazı tipi çelişiyor');
      }
    }
  }
}

test('şablon: yazı tipleri yalnızca tema üzerinden ve etkin profildendir; Nexa denetimsiz ikameye bırakılmaz', () => {
  const profile = spec.yazi_tipi.profiller[spec.yazi_tipi.etkin_profil];
  assert.ok(profile, 'etkin profil tanımlı');
  const theme = xml(part('theme'));
  const latin = (tag) => all(all(theme, tag)[0], 'a:latin')[0].getAttribute('typeface');
  assert.equal(latin('a:majorFont'), profile.baslik);
  assert.equal(latin('a:minorFont'), profile.govde);
  const allowed = new Set([profile.baslik, profile.govde]);
  for (const name of docx.names.filter((entry) => /^word\/.*\.xml$/.test(entry))) {
    checkDirectBodyFonts(xml(name), name);
    for (const element of all(xml(name), 'w:rFonts')) {
      for (const key of ['w:ascii', 'w:hAnsi', 'w:cs', 'w:eastAsia']) {
        const value = attr(element, key);
        if (value !== null) assert.ok(allowed.has(value), name + ': ' + value);
      }
    }
  }
  for (const font of all(xml(part('fontTable')), 'w:font')) assert.ok(allowed.has(attr(font, 'w:name')), attr(font, 'w:name'));
  assert.equal(spec.yazi_tipi.etkin_profil, 'calibri_uyumlu', 'Nexa için kurulum ya da lisanslı, doğrulanmış gömme gerekir');
});

const LIGHT_SURFACE_DIRECT_INKS = new Set(
  ['ana_lacivert', 'metin', 'ikincil_metin', 'vurgu_turuncu'].map((key) => paletteColor(key).toUpperCase())
);
const DARK_SURFACE_DIRECT_INKS = new Set(
  ['zemin', 'lacivert_20', 'vurgu_turuncu'].map((key) => paletteColor(key).toUpperCase())
);

const THEME_SCHEME_SLOTS = new Set([
  'dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'
]);

function checkPalette(document, name) {
  const wordColors = new Set(all(document, 'w:color'));
  const drawingColors = new Set(all(document, 'a:srgbClr'));
  const highlights = new Set(all(document, 'w:highlight'));
  const presetOrSystemColors = new Set([...all(document, 'a:prstClr'), ...all(document, 'a:sysClr')]);
  const schemeColors = new Set(all(document, 'a:schemeClr'));
  const isThemePart = name === 'word/theme/theme1.xml';
  const themeOverrideAttrs = ['w:themeColor', 'w:themeTint', 'w:themeShade', 'w:themeFill', 'w:themeFillTint', 'w:themeFillShade'];
  for (const element of document.getElementsByTagName('*')) {
    for (const overrideAttr of themeOverrideAttrs) {
      assert.equal(attr(element, overrideAttr), null, name + ': tema renk geçersiz kılması yasak (' + overrideAttr + ')');
    }
    if (highlights.has(element)) {
      const highlightVal = attr(element);
      assert.ok(highlightVal === null || highlightVal === 'none', name + ': adlandırılmış vurgu rengi (w:highlight) yasak: ' + highlightVal);
    }
    if (presetOrSystemColors.has(element) && !isThemePart) {
      assert.fail(name + ': adlandırılmış veya sistem DrawingML rengi yasak (' + element.localName + ')');
    }
    if (schemeColors.has(element)) {
      assert.equal(element.children.length, 0, name + ': DrawingML renk dönüşümü yasak');
      const schemeVal = attr(element, 'val');
      if (!isThemePart) {
        assert.ok(THEME_SCHEME_SLOTS.has(schemeVal), name + ': izinli olmayan şema rengi: ' + schemeVal);
      }
    }
    const colors = [attr(element, 'w:color'), attr(element, 'w:fill')];
    if (wordColors.has(element)) colors.push(attr(element));
    if (drawingColors.has(element)) {
      assert.equal(element.children.length, 0, name + ': DrawingML renk dönüşümü yasak');
      colors.push(attr(element, 'val'));
    }
    if (name.endsWith('.svg')) {
      for (const key of ['stroke', 'fill']) {
        const value = attr(element, key);
        if (value?.startsWith('#')) colors.push(value.slice(1));
      }
    }
    for (const value of colors) {
      if (value === null || value === 'auto') continue;
      assert.ok(ALLOWED_COLORS.has(value.toUpperCase()), name + ': izinli olmayan renk ' + value);
    }
  }
  // Gövde, üst bilgi ve alt bilgi paragraflarında doğrudan metin rengi atanan stilin zemin karşıtlığıyla çelişemez.
  if (/^word\/(?:document|header\d+|footer\d+)\.xml$/u.test(name)) {
    for (const paragraph of all(document, 'w:p')) {
      const styleId = paragraphStyle(paragraph) ?? 'Normal';
      const styleSpec = spec.stiller[styleId];
      const isLightInkStyle = Boolean(styleSpec && ['zemin', 'lacivert_20'].includes(styleSpec.renk));
      const word = paragraph.namespaceURI;
      const enclosing = (node, tag) => {
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          if (parent.namespaceURI === word && parent.localName === tag) return parent;
        }
        return null;
      };
      const fill = (node, property) => attr(child(child(node, property), 'w:shd'), 'w:fill')?.toUpperCase();
      const surfaces = [
        fill(paragraph, 'w:pPr'), fill(enclosing(paragraph, 'tc'), 'w:tcPr'), fill(enclosing(paragraph, 'tbl'), 'w:tblPr')
      ].filter((value) => value && value !== 'AUTO');
      const runs = all(paragraph, 'w:r');
      for (const run of runs) {
        const runInk = attr(child(child(run, 'w:rPr'), 'w:color'));
        const runFill = fill(run, 'w:rPr');
        const background = runFill && runFill !== 'AUTO' ? runFill : surfaces[0];
        const styleInk = styleSpec ? paletteColor(styleSpec.renk) : paletteColor(spec.stiller.Normal.renk);
        const ink = runInk && runInk !== 'auto' ? runInk.toUpperCase() : styleInk.toUpperCase();
        const darkSurface = background
          ? [paletteColor('ana_lacivert'), paletteColor('metin'), paletteColor('ikincil_metin')].includes(background)
          : isLightInkStyle;
        const allowedInks = darkSurface ? DARK_SURFACE_DIRECT_INKS : LIGHT_SURFACE_DIRECT_INKS;
        if (background || (runInk && runInk !== 'auto')) {
          assert.ok(ink !== background && allowedInks.has(ink),
            `${name}: doğrudan metin rengi (${ink}) atanan paragraf stili (${styleId}) ile çelişiyor`);
        }
      }
    }
  }
}

test('şablon: kullanılan her renk kurumsal paletten ya da nötrlerdendir (kapak yedigeni dâhil)', () => {
  for (const name of docx.names.filter((entry) => /\.(xml|svg)$/.test(entry))) checkPalette(xml(name), name);
});

function placeholders(element, name) {
  return all(element, 'w:t').flatMap((node) => {
    const text = node.textContent;
    assert.doesNotMatch(text.replace(PLACEHOLDER, ''), /[{}]/u, name + ': bölünmüş yer tutucu');
    return [...text.matchAll(PLACEHOLDER)].map((match) => match[1]);
  });
}

function sectionHeading(section, scope = 'projeler') {
  return scope === 'kisi' ? section.baslik_kisi ?? section.baslik : section.baslik;
}

function checkSectionPlaceholders(document, scope) {
  const sections = spec.yapi.bolumler;
  const body = all(document, 'w:body')[0];
  // Beklenmeyen doğrudan sayfa veya sütun kırılmaları sayfalama sözleşmesini bozar.
  for (const br of all(document, 'w:br')) {
    const type = attr(br, 'w:type');
    assert.ok(type !== 'page' && type !== 'column', 'belgede doğrudan sayfa veya sütun kırılması yasak');
  }
  let firstBodyHeading = null;
  const tokens = [[]];
  for (const block of body.children) {
    const style = paragraphStyle(block);
    const section = sections[tokens.length];
    const isHeading = ['Heading1', 'BilginEkBasligi'].includes(style);
    if (isHeading || (section?.paragraf_stili && style === section.paragraf_stili)) {
      assert.ok(section, 'beklenmeyen bölüm');
      if (isHeading) {
        assert.equal(paragraphText(block), sectionHeading(section, scope), 'bölüm başlığı ve belge sırası');
        assert.equal(style, section.numarali ? 'Heading1' : 'BilginEkBasligi', section.kimlik);
      }
      if (tokens.length === 1) {
        assert.ok(on(child(child(block, 'w:pPr'), 'w:pageBreakBefore')), 'gövde kapaktan sonra yeni sayfada başlar');
        firstBodyHeading = block;
      }
      tokens.push([]);
    }
    tokens.at(-1).push(...placeholders(block, 'word/document.xml'));
  }
  for (const paragraph of all(document, 'w:p')) {
    if (paragraph === firstBodyHeading) continue;
    const directBreak = child(child(paragraph, 'w:pPr'), 'w:pageBreakBefore');
    if (paragraphStyle(paragraph) === 'BilginEkBasligi') {
      // Ekler başlığı BilginEkBasligi stilinden yeni sayfa kırılımını miras alır; doğrudan kapatılamaz.
      if (directBreak) {
        assert.equal(on(directBreak), true, 'Ekler başlığında stil pageBreakBefore doğrudan kapatılamaz');
      }
      continue;
    }
    assert.equal(on(directBreak), false,
      'ilk gövde başlığı dışında doğrudan pageBreakBefore yasak');
  }
  assert.equal(tokens.length, sections.length, 'bölüm sayısı');
  for (const [index, section] of sections.entries()) {
    assert.deepEqual(tokens[index], section.yer_tutucular ?? [], section.kimlik + ': bölüm yer tutucuları');
  }
  return tokens.flat();
}

test('şablon: yer tutucular bölünmez, stil belgesiyle bire bir aynıdır ve ilgili bölümde doğru sıradadır', () => {
  const variants = spec.yapi.bolumler.filter((section) => Object.hasOwn(section, 'baslik_kisi'));
  assert.deepEqual(variants.map((section) => section.kimlik), ['faaliyetler']);
  const [variant] = variants;
  assert.equal(variant.baslik_kisi, 'Faaliyetler ve İlerleme');
  assert.ok(spec.yapi.bolum_kurallari.kisi_kapsami.includes(variant.baslik_kisi));
  const body = checkSectionPlaceholders(xml(part('officeDocument')));
  const header = placeholders(xml('word/header1.xml'), 'word/header1.xml');
  assert.deepEqual([...new Set([...body, ...header])].sort(), Object.keys(spec.yer_tutucular).sort());
  assert.deepEqual(header, ['RAPOR_TURU', 'DONEM']);
  for (const name of ['word/header2.xml', 'word/footer1.xml', 'word/footer2.xml']) {
    assert.deepEqual(placeholders(xml(name), name), []);
  }
});

function checkCoreProperties(document) {
  const root = document.documentElement;
  assert.equal(root, all(document, 'cp:coreProperties')[0], 'çekirdek belge özellikleri kökü');
  const allowedTags = new Set([
    'http://purl.org/dc/elements/1.1/|title',
    'http://purl.org/dc/elements/1.1/|creator',
    'http://schemas.openxmlformats.org/package/2006/metadata/core-properties|lastModifiedBy',
    'http://schemas.openxmlformats.org/package/2006/metadata/core-properties|revision',
    'http://purl.org/dc/elements/1.1/|language',
    'http://purl.org/dc/terms/|created',
    'http://purl.org/dc/terms/|modified'
  ]);
  const seen = new Set();
  for (const element of root.children) {
    const key = `${element.namespaceURI}|${element.localName}`;
    assert.ok(allowedTags.has(key), 'izinli olmayan çekirdek özellik: ' + element.tagName);
    assert.equal(seen.has(key), false, 'yinelenen çekirdek özellik: ' + element.tagName);
    assert.equal(element.children.length, 0, 'çekirdek özellik alt öğe taşıyamaz: ' + element.tagName);
    seen.add(key);
  }
  assert.equal(child(root, 'dc:title')?.textContent, spec.sablon.cekirdek.baslik);
  assert.equal(child(root, 'dc:creator')?.textContent, spec.sablon.cekirdek.olusturan);
  assert.equal(child(root, 'cp:lastModifiedBy')?.textContent, '');
  assert.equal(child(root, 'dc:language')?.textContent, spec.yazi_tipi.dil);
  const revision = child(root, 'cp:revision');
  if (revision) {
    assert.match(revision.textContent, /^[1-9]\d*$/u, 'cp:revision pozitif tamsayı olmalıdır');
  }
  const resolvePrefixNamespace = (element, prefix) => {
    let cur = element;
    while (cur && cur.nodeType === 1) {
      const ns = cur.getAttributeNS('http://www.w3.org/2000/xmlns/', prefix);
      if (ns) return ns;
      cur = cur.parentNode;
    }
    return null;
  };
  for (const dateTag of ['dcterms:created', 'dcterms:modified']) {
    const dateEl = child(root, dateTag);
    if (!dateEl) continue;
    const xsiType = dateEl.getAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'type');
    assert.ok(typeof xsiType === 'string' && xsiType.includes(':'),
      `${dateTag}: xsi:type özniteliği W3CDTF türüyle zorunludur`);
    const [typePrefix, typeLocal, ...rest] = xsiType.split(':');
    assert.ok(rest.length === 0 && typeLocal === 'W3CDTF' && resolvePrefixNamespace(dateEl, typePrefix) === 'http://purl.org/dc/terms/',
      `${dateTag}: xsi:type yalnızca Dublin Core Terms ad alanlı W3CDTF olabilir`);
    const rawDate = dateEl.textContent;
    assert.match(rawDate, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u,
      `${dateTag}: geçerli UTC ISO-8601 (W3CDTF) tarih damgası olmalıdır`);
    const epoch = Date.parse(rawDate);
    assert.ok(Number.isFinite(epoch) && new Date(epoch).toISOString().slice(0, 19) === rawDate.slice(0, 19),
      `${dateTag}: ayrıştırılabilir ve geçerli takvim tarihli damga olmalıdır`);
  }
}

/** Kapak künye tablosundaki her etiketin doğru değer yer tutucusuyla eşleştiğini doğrular. */
function checkCoverMetadata(document) {
  const expectedPairs = [
    ['Rapor Dönemi', '{{DONEM}}'],
    ['Kapsam', '{{KAPSAM}}'],
    ['Hazırlayan', '{{HAZIRLAYAN}}'],
    ['Birim / Müdürlük', '{{BIRIM}}'],
    ['Hazırlanma Tarihi', '{{HAZIRLANMA_TARIHI}}'],
    ['Veri Anı', '{{VERI_ANI}}'],
    ['Sınıflandırma', 'Kurum İçi']
  ];
  const metaTables = all(document, 'w:tbl').filter((table) =>
    all(table, 'w:p').some((paragraph) => paragraphStyle(paragraph) === 'BilginKapakMetaEtiketi')
  );
  assert.equal(metaTables.length, 1, 'kapak künye tablosu tekil olmalıdır');
  const rows = children(metaTables[0], 'w:tr');
  assert.equal(rows.length, expectedPairs.length, 'kapak künye satır sayısı');
  const actualPairs = rows.map((row) => {
    const cells = children(row, 'w:tc');
    assert.equal(cells.length, 2, 'kapak künye satırı iki hücreli olmalıdır');
    assert.equal(paragraphStyle(child(cells[0], 'w:p')), 'BilginKapakMetaEtiketi', 'kapak künye etiket stili');
    assert.equal(paragraphStyle(child(cells[1], 'w:p')), 'BilginKapakMetaDegeri', 'kapak künye değer stili');
    return [paragraphText(cells[0]), paragraphText(cells[1])];
  });
  assert.deepEqual(actualPairs, expectedPairs, 'kapak künye etiket ve değer eşleşmesi bozulmuş');
}

/** Paragraf içindeki bitişik görünür metin parçalarını (alan, sekme, satır sonu ve yer tutucu sınırlarıyla) ayırır. */
function collectParagraphFixedSegments(paragraph) {
  const segments = [];
  let buffer = '';
  const flush = () => {
    const trimmed = buffer.trim();
    if (trimmed) segments.push(trimmed);
    buffer = '';
  };
  const walk = (node) => {
    const ns = node.namespaceURI;
    const local = node.localName;
    if (ns === 'http://schemas.openxmlformats.org/wordprocessingml/2006/main') {
      if (local === 'fldSimple' || local === 'tab' || local === 'br' || local === 'cr' || local === 'drawing') {
        flush();
        return;
      }
      if (local === 'noBreakHyphen' || local === 'softHyphen') {
        buffer += local === 'noBreakHyphen' ? '\u2011' : '\u00ad';
        return;
      }
      if (local === 't') {
        assert.doesNotMatch(node.textContent.replace(PLACEHOLDER, ''), /[{}]/u, 'bölünmüş yer tutucu');
        const parts = node.textContent.split(/\{\{[A-Z0-9_]+\}\}/gu);
        for (let i = 0; i < parts.length; i += 1) {
          buffer += parts[i];
          if (i < parts.length - 1) flush();
        }
        return;
      }
    }
    for (const childNode of node.childNodes) {
      if (childNode.nodeType === 1) walk(childNode);
      else if (childNode.nodeType === 3) assert.equal(childNode.textContent.trim(), '', 'Word sabit metni w:t dışında bulunamaz');
    }
  };
  walk(paragraph);
  flush();
  return segments;
}

/** Parçadaki tüm paragrafların yer tutucu dışı bitişik sabit metinlerini ilan edilen sözlükle doğrular. */
function checkDeclaredFixedText(document, allowed, name) {
  const seen = new Set();
  for (const paragraph of all(document, 'w:p')) {
    for (const segment of collectParagraphFixedSegments(paragraph)) {
      assert.ok(allowed.has(segment), `${name}: ilan edilmemiş metin "${segment}"`);
      seen.add(segment);
    }
  }
  assert.deepEqual([...allowed].filter((text) => !seen.has(text)), [], `${name}: ilan edilen ama şablonda olmayan metin`);
}

test('şablon: yer tutucu dışındaki her görünen metin stil belgesinde ilan edilmiştir (kurum adı ya da başıboş metin yok)', () => {
  const titles = spec.yapi.bolumler.map((section) => section.baslik).filter(Boolean);
  const declared = {
    'word/document.xml': new Set([...spec.sabit_metinler.kapak, ...spec.sabit_metinler.govde, ...titles]),
    'word/header1.xml': new Set(spec.sabit_metinler.ust_bilgi),
    'word/footer1.xml': new Set(spec.sabit_metinler.alt_bilgi),
    'word/header2.xml': new Set(),
    'word/footer2.xml': new Set()
  };
  for (const [name, allowed] of Object.entries(declared)) {
    checkDeclaredFixedText(xml(name), allowed, name);
  }
  const personDocument = parseDocxXml(docx.text(part('officeDocument')), part('officeDocument'));
  const section = spec.yapi.bolumler.find((entry) => entry.kimlik === 'faaliyetler');
  const heading = all(personDocument, 'w:p').find((paragraph) => paragraphText(paragraph) === section.baslik);
  assert.ok(heading);
  const headingText = all(heading, 'w:t');
  headingText[0].textContent = sectionHeading(section, 'kisi');
  for (const text of headingText.slice(1)) text.textContent = '';
  checkSectionPlaceholders(personDocument, 'kisi');
  checkDeclaredFixedText(personDocument, new Set([...spec.sabit_metinler.kapak, ...spec.sabit_metinler.govde,
    ...spec.yapi.bolumler.map((entry) => sectionHeading(entry, 'kisi')).filter(Boolean)]), part('officeDocument'));
  checkCoverMetadata(xml(part('officeDocument')));
  // Belge özelliklerinde de kişi ya da kurum adı yoktur.
  checkCoreProperties(xml(part('core')));
  checkExtendedProperties(xml(part('app')));
});

function checkExtendedProperties(document) {
  const root = document.documentElement;
  assert.equal(root, all(document, 'ep:Properties')[0], 'genişletilmiş belge özellikleri kökü');
  assert.equal(root.children.length, 2, 'şablonda yalnızca izinli genişletilmiş özellikler bulunur');
  assert.equal(child(root, 'ep:Application')?.textContent, spec.sablon.cekirdek.olusturan);
  assert.equal(child(root, 'ep:DocSecurity')?.textContent, '0');
}

function checkSummaryTable(document) {
  const tables = all(document, 'w:tbl');
  const summary = tables.filter((table) => attr(child(child(table, 'w:tblPr'), 'w:tblStyle')) === spec.tablolar.donem_gorev_ozeti.stil);
  assert.equal(summary.length, 1);
  const tblPr = child(summary[0], 'w:tblPr');
  assert.equal(on(child(tblPr, 'w:bidiVisual')), false, 'özet tablo soldan sağa görüntülenmelidir (w:bidiVisual kapalı olmalıdır)');
  const expectedColumnCount = spec.tablolar.donem_gorev_ozeti.sutunlar.length;
  const gridCols = children(child(summary[0], 'w:tblGrid'), 'w:gridCol');
  assert.equal(gridCols.length, expectedColumnCount, 'özet tablo ızgara sütun sayısı');
  const tblLook = child(tblPr, 'w:tblLook');
  assert.ok(tblLook, 'özet tabloda w:tblLook zorunludur');
  assert.equal(attr(tblLook, 'w:firstRow'), '1', 'özet tabloda ilk satır koşullu biçimi etkin olmalıdır');
  assert.equal(attr(tblLook, 'w:lastRow'), '1', 'özet tabloda son satır koşullu biçimi etkin olmalıdır');
  const lookVal = attr(tblLook, 'w:val');
  if (lookVal !== null) {
    const mask = Number.parseInt(lookVal, 16);
    assert.equal(mask & 0x0060, 0x0060, 'özet tablo w:tblLook bit maskesi ilk ve son satırı etkinleştirmelidir');
  }
  const rows = children(summary[0], 'w:tr');
  assert.equal(rows.length, 3, 'özet tablo başlık, veri şablonu ve toplam satırından oluşmalıdır');
  // Her satır 1. ızgara sütunundan başlamalı ve her hücre tam olarak 1 sütun kaplamalıdır.
  for (const row of rows) {
    const trPr = child(row, 'w:trPr');
    const gridBefore = attr(child(trPr, 'w:gridBefore'));
    const gridAfter = attr(child(trPr, 'w:gridAfter'));
    assert.ok(gridBefore === null || gridBefore === '0', 'özet tablo satırı ilk ızgara sütunundan başlamalıdır');
    assert.ok(gridAfter === null || gridAfter === '0', 'özet tablo satırında fazladan ızgara boşluğu bulunamaz');
    const cells = children(row, 'w:tc');
    assert.equal(cells.length, expectedColumnCount, 'özet tablo satır hücre sayısı sütun sayısına eşit olmalıdır');
    for (const cell of cells) {
      const tcPr = child(cell, 'w:tcPr');
      const span = attr(child(tcPr, 'w:gridSpan'));
      assert.ok(span === null || span === '1', 'özet tablo hücresi birden fazla sütuna yayılamaz');
      assert.equal(child(tcPr, 'w:vMerge'), null, 'özet tablo hücresinde dikey birleştirme (w:vMerge) yasak');
      assert.equal(child(tcPr, 'w:hMerge'), null, 'özet tablo hücresinde yatay birleştirme (w:hMerge) yasak');
    }
  }
  const [headerRow, dataRow, totalRow] = rows;
  assert.ok(on(child(child(headerRow, 'w:trPr'), 'w:tblHeader')), 'başlık satırı her sayfada yinelenir');
  assert.deepEqual(children(headerRow, 'w:tc').map((cell) => paragraphText(cell)), spec.tablolar.donem_gorev_ozeti.sutunlar);
  assert.deepEqual(children(dataRow, 'w:tc').map((cell) => paragraphText(cell)),
    ['{{SATIR_PROJE}}', '{{SATIR_TAM}}', '{{SATIR_ACIK}}', '{{SATIR_YAK}}', '{{SATIR_OZET}}'],
    'veri satırı yer tutucuları ilgili sütun hücrelerinde olmalıdır');
  assert.deepEqual(children(totalRow, 'w:tc').map((cell) => paragraphText(cell)),
    ['Toplam', '{{TOPLAM_TAM}}', '{{TOPLAM_ACIK}}', '{{TOPLAM_YAK}}', '{{TOPLAM_OZET}}'],
    'toplam satırı yer tutucuları ilgili sütun hücrelerinde olmalıdır');
}

test('şablon: numaralı bölüm başlıkları ve ek başlığı stil belgesindeki sırayla yazılıdır; tablo sütunları ve hücre yerleşimi aynıdır', () => {
  const document = xml(part('officeDocument'));
  const paragraphs = all(document, 'w:p');
  const headings = paragraphs.filter((paragraph) => paragraphStyle(paragraph) === 'Heading1').map(paragraphText);
  assert.deepEqual(headings, spec.yapi.bolumler.filter((section) => section.numarali).map((section) => section.baslik));
  const appendix = paragraphs.filter((paragraph) => paragraphStyle(paragraph) === 'BilginEkBasligi').map(paragraphText);
  assert.deepEqual(appendix, spec.yapi.bolumler.filter((section) => section.baslik && section.numarali === false).map((section) => section.baslik));
  checkSummaryTable(document);
});

const CUSTOM_PROPERTY_FMTID = '{D5CDD505-2E9C-101B-9397-08002B2CF9AE}';

function checkCustomProperties(document) {
  const root = document.documentElement;
  assert.equal(root, all(document, 'custom:Properties')[0], 'özel belge özellikleri kökü geçersiz');
  // Prototipsiz nesne kullanılarak __proto__ gibi özel adların düz nesne setter'ına kaçması engellenir.
  const properties = Object.create(null);
  const pids = new Set();
  for (const element of root.children) {
    assert.equal(element.namespaceURI, root.namespaceURI, 'özel özellik ad alanı geçersiz');
    assert.equal(element.localName, 'property', 'özel özellik öğesi geçersiz');
    const fmtid = element.getAttribute('fmtid');
    assert.equal(fmtid?.toUpperCase(), CUSTOM_PROPERTY_FMTID, 'özel özellik fmtid değeri zorunlu şema kimliğiyle eşleşmelidir');
    const name = element.getAttribute('name');
    const pid = element.getAttribute('pid');
    assert.ok(name && Object.hasOwn(spec.sablon.belge_ozellikleri, name), 'izinli olmayan özel özellik adı: ' + name);
    assert.ok(!Object.hasOwn(properties, name), 'özel özellik adı tekil olmalıdır: ' + name);
    assert.match(pid ?? '', /^\d+$/u, 'özel özellik pid değeri geçerli tamsayı olmalıdır: ' + pid);
    const pidNumber = Number(pid);
    assert.ok(Number.isSafeInteger(pidNumber) && pidNumber >= 2 && pidNumber <= 2147483647,
      'özel özellik pid değeri geçerli aralıkta (≥ 2) olmalıdır: ' + pid);
    assert.ok(!pids.has(pidNumber), 'özel özellik pid değeri tekil olmalıdır: ' + pid);
    pids.add(pidNumber);
    const valueElements = [...element.children];
    assert.equal(valueElements.length, 1, 'özel özellik tam olarak bir değer öğesi taşımalıdır: ' + name);
    const [valueEl] = valueElements;
    assert.ok(
      valueEl.namespaceURI === 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes'
        && valueEl.localName === 'lpwstr',
      `özel özellik metin (vt:lpwstr) türünde olmalıdır: ${name}`
    );
    properties[name] = valueEl.textContent;
  }
  assert.deepEqual({ ...properties }, spec.sablon.belge_ozellikleri);
}

test('şablon: sürüm ve kimlik belge özellikleri stil belgesiyle aynıdır', () => {
  checkCustomProperties(xml(part('custom')));
});

const APPROVED_COVER_DIMENSIONS = { width: '210mm', height: '297mm' };
const APPROVED_COVER_VIEWBOX = [0, 0, 210, 297];
const APPROVED_COVER_MATRIX = [0.62, 0, 0, 0.62, 191.652, 180.493];
const APPROVED_COVER_STROKE_WIDTHS = { teal: 0.887, orange: 1.129 };
const APPROVED_COVER_EXTENT_EMU = { cx: 210 * 36000, cy: 297 * 36000 };

/** Yetkili kaynak dosyadan HEPT_PATHS dizisini biçimlendirmeden bağımsız olarak ayıklar. */
function parseHeptPaths(source) {
  const match = /\b(?:const|let|var)\s+HEPT_PATHS\s*=\s*\[([\s\S]*?)\]\s*;/u.exec(source);
  assert.ok(match, 'yetkili HEPT_PATHS tanımı bulunamadı');
  const items = [];
  for (const entryMatch of match[1].matchAll(/\{([\s\S]*?)\}/gu)) {
    const body = entryMatch[1];
    const toneMatch = /\btone\s*:\s*(['"])(teal|orange)\1/u.exec(body);
    const dMatch = /\bd\s*:\s*(['"])([^'"]+)\1/u.exec(body);
    assert.ok(toneMatch && dMatch, 'HEPT_PATHS öğesi geçersiz');
    items.push({ tone: toneMatch[2], d: dMatch[2] });
  }
  return items;
}

/** Yetkili HEPT_PATHS tanımından ve kurumsal paletten beklenen kapak SVG yol ve zemin renklerini türetir. */
async function loadAuthorizedCoverExpectations() {
  const ui = await read(spec.gorseller.kapak_yedigeni.kaynak);
  const paths = parseHeptPaths(ui);
  assert.equal(paths.length, 5, 'yetkili beş yedigen yolu');
  const expectedPaths = paths.map(({ tone, d }) => ({
    d,
    stroke: '#' + paletteColor(spec.gorseller.kapak_yedigeni.renk_eslemesi[tone]).toUpperCase(),
    strokeWidth: APPROVED_COVER_STROKE_WIDTHS[tone]
  }));
  const expectedBg = '#' + paletteColor(spec.gorseller.kapak_yedigeni.zemin).toUpperCase();
  return { expectedPaths, expectedBg };
}

test('şablon: kapak yedigeni uygulamadaki yetkili yedigen yollarını aynen kullanır ve etkin içerik taşımaz', async () => {
  const { expectedPaths, expectedBg } = await loadAuthorizedCoverExpectations();
  checkCoverSvg(xml('word/media/kapak-yedigen.svg'), expectedPaths, expectedBg);
  assert.equal(contentType('word/media/kapak-yedigen.svg'), 'image/svg+xml');
  assert.equal(contentType('word/media/kapak-yedigen.png'), 'image/png');
  validateCoverPng(docx.buffer('word/media/kapak-yedigen.png'), {
    background: paletteColor(spec.gorseller.kapak_yedigeni.zemin),
    strokes: [
      paletteColor(spec.gorseller.kapak_yedigeni.renk_eslemesi.teal),
      paletteColor(spec.gorseller.kapak_yedigeni.renk_eslemesi.orange)
    ]
  });
  checkCoverRelationships(xml(part('officeDocument')), documentRelationship);
});

function checkCoverSvg(document, expectedPaths, expectedBackground) {
  const allowed = {
    svg: ['width', 'height', 'viewBox'],
    rect: ['fill', 'height', 'width', 'x', 'y'],
    g: ['fill', 'stroke-linejoin', 'transform'],
    path: ['d', 'stroke', 'stroke-width']
  };
  const root = document.documentElement;
  assert.equal(all(document, 'svg:svg')[0], root, 'SVG kök öğesi');
  assert.equal([...document.childNodes].filter((node) => node.nodeType === 7).length, 0, 'SVG işlem yönergesi yasak');
  for (const element of document.getElementsByTagName('*')) {
    const attributes = allowed[element.localName];
    assert.ok(element.namespaceURI === root.namespaceURI && Array.isArray(attributes), 'SVG öğesi yasak');
    for (const { localName, namespaceURI, value } of element.attributes) {
      if (namespaceURI === 'http://www.w3.org/2000/xmlns/') continue;
      assert.ok(namespaceURI === null && attributes.includes(localName), 'SVG özniteliği yasak');
      if (localName === 'fill' || localName === 'stroke') {
        assert.match(value, /^(?:none|#[0-9A-Fa-f]{6})$/u, 'SVG boya değeri yerel renk olmalıdır');
      }
    }
  }
  assert.equal(root.textContent.trim(), '', 'SVG serbest metin taşımaz');
  assert.equal(root.getAttribute('width'), APPROVED_COVER_DIMENSIONS.width, 'kapak SVG kök genişliği 210mm olmalıdır');
  assert.equal(root.getAttribute('height'), APPROVED_COVER_DIMENSIONS.height, 'kapak SVG kök yüksekliği 297mm olmalıdır');
  const SVG_NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
  const viewBoxTokens = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/u).filter(Boolean);
  assert.ok(viewBoxTokens.length === APPROVED_COVER_VIEWBOX.length && viewBoxTokens.every((token) => SVG_NUMBER_RE.test(token)),
    'kapak SVG viewBox değerleri geçerli SVG sayı sözdiziminde olmalıdır');
  const viewBox = viewBoxTokens.map(Number);
  assert.deepEqual(viewBox, APPROVED_COVER_VIEWBOX, 'kapak SVG viewBox değeri A4 görünüm alanıyla eşleşmelidir');
  const directChildren = [...root.children];
  if (expectedBackground && expectedPaths) {
    assert.equal(directChildren.length, 2, 'kapak SVG kökünde yalnızca zemin dikdörtgeni ve yedigen grubu bulunmalıdır');
    assert.equal(directChildren[0].localName, 'rect', 'kapak SVG zemin dikdörtgeni yedigen grubundan önce gelmelidir');
    assert.equal(directChildren[1].localName, 'g', 'kapak SVG yedigen grubu zemin dikdörtgeninden sonra gelmelidir');
  }
  if (expectedBackground) {
    const rects = all(document, 'svg:rect');
    assert.equal(rects.length, 1, 'kapak SVG zemin dikdörtgeni tekil olmalıdır');
    const bgRect = rects[0];
    assert.equal(bgRect.parentNode, root, 'kapak SVG zemin dikdörtgeni kökün doğrudan çocuğu olmalıdır');
    assert.equal(bgRect.getAttribute('fill')?.toUpperCase(), expectedBackground, 'kapak SVG zemin rengi');
    const rx = bgRect.getAttribute('x') === null ? 0 : Number(bgRect.getAttribute('x'));
    const ry = bgRect.getAttribute('y') === null ? 0 : Number(bgRect.getAttribute('y'));
    const rw = bgRect.getAttribute('width') === '100%' ? APPROVED_COVER_VIEWBOX[2] : Number(bgRect.getAttribute('width'));
    const rh = bgRect.getAttribute('height') === '100%' ? APPROVED_COVER_VIEWBOX[3] : Number(bgRect.getAttribute('height'));
    assert.ok(rx === 0 && ry === 0 && rw === APPROVED_COVER_VIEWBOX[2] && rh === APPROVED_COVER_VIEWBOX[3],
      'kapak SVG zemin dikdörtgeni onaylı A4 görünüm alanını tam kaplamalıdır');
  }
  if (expectedPaths) {
    const groups = all(document, 'svg:g');
    const pathNodes = all(document, 'svg:path');
    assert.equal(groups.length, 1, 'kapak SVG yedigen grubu tekil olmalıdır');
    const [group] = groups;
    assert.equal(group.parentNode, root, 'kapak SVG yedigen grubu kökün doğrudan çocuğu olmalıdır');
    assert.equal(group.getAttribute('fill'), 'none', 'kapak SVG yedigen grubu dolgusuz (fill="none") olmalıdır');
    assert.equal(group.getAttribute('stroke-linejoin'), 'round', 'kapak SVG yedigen grubu stroke-linejoin="round" olmalıdır');
    assert.ok(pathNodes.every((node) => node.parentNode === group), 'kapak SVG yedigen yolları onaylı grubun içinde olmalıdır');
    const actualPaths = pathNodes.map((node, index) => {
      const width = Number(node.getAttribute('stroke-width'));
      assert.ok(Number.isFinite(width) && width > 0, 'SVG yol çizgi kalınlığı pozitif olmalıdır');
      const expectedWidth = expectedPaths[index]?.strokeWidth;
      if (expectedWidth !== undefined) {
        assert.ok(Math.abs(width - expectedWidth) < 1e-3, 'SVG yol çizgi kalınlığı onaylı değerle eşleşmelidir');
      }
      return {
        d: node.getAttribute('d'),
        stroke: node.getAttribute('stroke')?.toUpperCase()
      };
    });
    assert.deepEqual(actualPaths, expectedPaths.map(({ d, stroke }) => ({ d, stroke })),
      'kapak SVG yedigen yolları yetkili tanımla bire bir eşleşmelidir');
    const transform = (group.getAttribute('transform') ?? '').trim();
    const matrixMatch = /^matrix\(\s*([^)]+)\s*\)$/u.exec(transform);
    assert.ok(matrixMatch, 'kapak SVG yedigen grup dönüşümü onaylı matris biçiminde olmalıdır');
    const numbers = matrixMatch[1].trim().split(/\s*,\s*|\s+/u);
    assert.ok(numbers.every((token) => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(token)),
      'kapak SVG matrisi geçerli ondalık sayılar taşımalıdır');
    const values = numbers.map(Number);
    assert.equal(values.length, APPROVED_COVER_MATRIX.length, 'kapak SVG yedigen dönüşüm matrisi geçersiz');
    for (let i = 0; i < APPROVED_COVER_MATRIX.length; i += 1) {
      assert.ok(Number.isFinite(values[i]) && Math.abs(values[i] - APPROVED_COVER_MATRIX[i]) < 1e-3,
        'kapak SVG yedigen yerleşimi onaylı konumdan sapamaz');
    }
  }
}

const APPROVED_COVER_DOCPR_DESCR = 'Lacivert kapak zemini ve kurumsal yedigen çizgileri (yalnızca süsleme)';

function checkCoverRelationships(document, relationship) {
  const anchors = all(document, 'wp:anchor');
  assert.equal(anchors.length, 1, 'tek kapak çizimi');
  const [anchor] = anchors;
  assert.ok(['1', 'true'].includes(attr(anchor, 'behindDoc')), 'kapak çizimi metnin arkasındadır');
  assert.ok(['0', 'false'].includes(attr(anchor, 'simplePos')), 'kapak çizimi sayfa göreli konumlandırma kullanmalıdır');
  const docPr = child(anchor, 'wp:docPr');
  assert.ok(docPr, 'kapak çizimi wp:docPr üstverisi zorunludur');
  assert.equal(docPr.getAttribute('name'), 'Kapak zemini', 'kapak çiziminin adı onaylı sabit ad olmalıdır');
  assert.ok([null, '0', 'false'].includes(docPr.getAttribute('hidden')), 'kapak çizimi gizlenemez');
  const docPrTitle = docPr.getAttribute('title');
  const docPrDescr = docPr.getAttribute('descr');
  assert.ok(docPrTitle === null || docPrTitle === '', 'kapak çizimi wp:docPr title alanı boş olmalıdır');
  assert.ok(
    docPrDescr === null || docPrDescr === '' || docPrDescr === APPROVED_COVER_DOCPR_DESCR,
    'kapak çizimi wp:docPr descr alanı yalnızca onaylı sabit süsleme metni olabilir'
  );
  const pictures = all(anchor, 'pic:cNvPr');
  assert.equal(pictures.length, 1, 'kapak resmi görünüm dışı özellikleri tekil olmalıdır');
  for (const cNvPr of pictures) {
    assert.equal(cNvPr.getAttribute('name'), 'kapak-yedigen.png', 'kapak dosya adı onaylı sabit ad olmalıdır');
    assert.ok([null, '0', 'false'].includes(cNvPr.getAttribute('hidden')), 'kapak resmi gizlenemez');
    const picTitle = cNvPr.getAttribute('title');
    const picDescr = cNvPr.getAttribute('descr');
    assert.ok(picTitle === null || picTitle === '', 'kapak resmi pic:cNvPr title alanı boş olmalıdır');
    assert.ok(picDescr === null || picDescr === '', 'kapak resmi pic:cNvPr descr alanı boş olmalıdır');
  }
  /** Boş veya eksik özniteliğin Number(null)/Number('') ile 0'a zorlanmasını engeller. */
  const parseStrictInt = (raw, message) => {
    assert.ok(typeof raw === 'string' && /^-?\d+$/u.test(raw.trim()), message);
    return Number(raw.trim());
  };
  const posH = child(anchor, 'wp:positionH');
  const posV = child(anchor, 'wp:positionV');
  assert.equal(posH?.getAttribute('relativeFrom'), 'page', 'kapak yatay konumu sayfaya göre olmalıdır');
  assert.equal(posV?.getAttribute('relativeFrom'), 'page', 'kapak dikey konumu sayfaya göre olmalıdır');
  assert.equal(parseStrictInt(child(posH, 'wp:posOffset')?.textContent, 'kapak yatay konumu sayfa başlangıcında (0 EMU) olmalıdır'), 0,
    'kapak yatay konumu sayfa başlangıcında (0 EMU) olmalıdır');
  assert.equal(parseStrictInt(child(posV, 'wp:posOffset')?.textContent, 'kapak dikey konumu sayfa başlangıcında (0 EMU) olmalıdır'), 0,
    'kapak dikey konumu sayfa başlangıcında (0 EMU) olmalıdır');
  assert.equal(anchor.parentNode?.parentNode?.parentNode, all(document, 'w:body')[0].firstElementChild,
    'kapak çizimi ilk paragraftadır');
  const wpExtent = child(anchor, 'wp:extent');
  assert.equal(parseStrictInt(wpExtent?.getAttribute('cx'), 'kapak wp:extent genişliği A4 ile eşleşmelidir'), APPROVED_COVER_EXTENT_EMU.cx,
    'kapak wp:extent genişliği A4 ile eşleşmelidir');
  assert.equal(parseStrictInt(wpExtent?.getAttribute('cy'), 'kapak wp:extent yüksekliği A4 ile eşleşmelidir'), APPROVED_COVER_EXTENT_EMU.cy,
    'kapak wp:extent yüksekliği A4 ile eşleşmelidir');
  const picSpPr = all(anchor, 'pic:spPr')[0];
  const picXfrm = child(picSpPr, 'a:xfrm');
  assert.ok(picXfrm, 'kapak resmi pic:spPr/a:xfrm zorunludur');
  const rotVal = picXfrm.getAttribute('rot');
  assert.ok(rotVal === null || parseStrictInt(rotVal, `kapak resmi döndürülemez (a:xfrm rot=${rotVal})`) === 0,
    `kapak resmi döndürülemez (a:xfrm rot=${rotVal})`);
  for (const flipAttr of ['flipH', 'flipV']) {
    const flipVal = picXfrm.getAttribute(flipAttr);
    assert.ok([null, '0', 'false'].includes(flipVal), `kapak resmi çevrilemez (a:xfrm ${flipAttr}=${flipVal})`);
  }
  const picOff = child(picXfrm, 'a:off');
  assert.equal(parseStrictInt(picOff?.getAttribute('x'), 'kapak pic:spPr/a:xfrm/a:off x konumu 0 olmalıdır'), 0,
    'kapak pic:spPr/a:xfrm/a:off x konumu 0 olmalıdır');
  assert.equal(parseStrictInt(picOff?.getAttribute('y'), 'kapak pic:spPr/a:xfrm/a:off y konumu 0 olmalıdır'), 0,
    'kapak pic:spPr/a:xfrm/a:off y konumu 0 olmalıdır');
  const picExt = child(picXfrm, 'a:ext');
  assert.equal(parseStrictInt(picExt?.getAttribute('cx'), 'kapak pic:spPr/a:xfrm/a:ext genişliği A4 ile eşleşmelidir'), APPROVED_COVER_EXTENT_EMU.cx,
    'kapak pic:spPr/a:xfrm/a:ext genişliği A4 ile eşleşmelidir');
  assert.equal(parseStrictInt(picExt?.getAttribute('cy'), 'kapak pic:spPr/a:xfrm/a:ext yüksekliği A4 ile eşleşmelidir'), APPROVED_COVER_EXTENT_EMU.cy,
    'kapak pic:spPr/a:xfrm/a:ext yüksekliği A4 ile eşleşmelidir');
  const png = all(anchor, 'a:blip');
  const svg = all(anchor, 'asvg:svgBlip');
  assert.equal(png.length, 1, 'kapak PNG başvurusu');
  assert.equal(svg.length, 1, 'kapak SVG başvurusu');
  assert.ok(png[0].contains(svg[0]), 'kapak PNG ve SVG aynı çizimdedir');
  // Kanonik kapak görselinde şeffaflık/efekt (ör. a:alphaModFix) uygulanamaz; a:blip altında yalnızca SVG uzantısı bulunabilir.
  for (const blipChild of png[0].children) {
    assert.ok(blipChild.namespaceURI === 'http://schemas.openxmlformats.org/drawingml/2006/main' && blipChild.localName === 'extLst',
      `kapak resmi a:blip üzerinde görüntü efekti yasak (${blipChild.tagName})`);
  }
  // Kapak görselinde a:srcRect kırpması bulunmamalıdır (yoksa veya tüm kenarlar 0 ise geçerlidir).
  const blipFill = png[0].parentNode;
  assert.ok(blipFill && blipFill.localName === 'blipFill', 'kapak a:blip öğesi blipFill içinde olmalıdır');
  const srcRects = children(blipFill, 'a:srcRect');
  assert.ok(srcRects.length <= 1, 'kapak resmi en fazla bir a:srcRect öğesi taşıyabilir');
  if (srcRects.length === 1) {
    for (const side of ['l', 't', 'r', 'b']) {
      const inset = srcRects[0].getAttribute(side);
      assert.ok(inset === null || parseStrictInt(inset, `kapak resmi kırpılamaz (a:srcRect ${side}=${inset})`) === 0,
        `kapak resmi kırpılamaz (a:srcRect ${side}=${inset})`);
    }
  }
  const stretches = children(blipFill, 'a:stretch');
  assert.ok(stretches.length === 1 && children(blipFill, 'a:tile').length === 0, 'kapak resmi hedefi döşemeden doldurmalıdır');
  const fillRects = children(stretches[0], 'a:fillRect');
  assert.ok(fillRects.length <= 1, 'kapak resmi en fazla bir hedef dikdörtgeni taşıyabilir');
  for (const side of ['l', 't', 'r', 'b']) {
    const inset = fillRects[0]?.getAttribute(side) ?? null;
    assert.ok(inset === null || /^(?:[+-]?0+(?:\.0+)?%|[+-]?0+)$/u.test(inset),
      'kapak resmi hedef dikdörtgeni boşluksuz doldurmalıdır');
  }
  assert.equal(relationship(attr(png[0], 'r:embed'), 'image'), 'word/media/kapak-yedigen.png');
  assert.equal(relationship(attr(svg[0], 'r:embed'), 'image'), 'word/media/kapak-yedigen.svg');
}

test('şablon: çok parçalı, çakışan, tutarsız, kayıtsız baytlı veya bozuk ZIP girdileri reddedilir', async () => {
  const original = await readFile(path.join(ROOT, spec.sablon.dosya));
  const end = original.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const central = original.readUInt32LE(end + 16);
  const local = original.readUInt32LE(central + 42);
  assert.equal(readZipEntries(original).size, docx.names.length);
  for (const [mutate, expected] of [
    [(copy) => copy.writeUInt32LE(0x10, central + 38), /normal dosya olmalıdır/],
    [(copy) => {
      copy[central + 5] = 3;
      copy.writeUInt32LE(0x40000000, central + 38);
    }, /normal dosya olmalıdır/],
    [(copy) => copy.writeUInt16LE(1, end + 4), /çok parçalı ZIP/],
    [(copy) => copy.writeUInt16LE(1, central + 34), /çok parçalı ZIP girdisi/],
    [(copy) => { copy[local + 30] ^= 1; }, /yerel başlığı merkezî dizinle uyuşmuyor/],
    [(copy) => {
      const checksum = (copy.readUInt32LE(central + 16) ^ 1) >>> 0;
      copy.writeUInt32LE(checksum, central + 16);
      copy.writeUInt32LE(checksum, local + 14);
    }, /girdi sağlama toplamı uyuşmuyor/],
    [(copy) => copy.writeUInt32LE(0xffffffff, central + 20), /yerel girdi aralığı/]
  ]) {
    const copy = Buffer.from(original);
    mutate(copy);
    assert.throws(() => readZipEntries(copy), expected);
  }
  // EOCD sonuna gizli yük eklenip yorum uzunluğu güncellendiğinde reddedilmelidir.
  const payload = Buffer.from('CONFIDENTIAL_PAYLOAD');
  const withComment = Buffer.concat([original, payload]);
  withComment.writeUInt16LE(payload.length, end + 20);
  assert.throws(() => readZipEntries(withComment), /ZIP EOCD yorumu yasak/);
  // Merkezî dizin öncesine kayıtsız bayt eklenip başlangıç kaydırıldığında reddedilmelidir.
  const withGap = Buffer.concat([original.subarray(0, central), payload, original.subarray(central)]);
  const shiftedEnd = end + payload.length;
  withGap.writeUInt32LE(central + payload.length, shiftedEnd + 16);
  assert.throws(() => readZipEntries(withGap), /kayıtsız baytlar var/);

  // Geçerli sınırlar içinde yinelenen girdi adı, taşan ek alan veya ZIP64 (0x0001) ek alanı reddedilmeli; geçerli ek alan kabul edilmelidir.
  const buildSyntheticZip = (items) => {
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;
    for (const { name: rawName, content, localExtra = Buffer.alloc(0), centralExtra = Buffer.alloc(0) } of items) {
      const name = Buffer.from(rawName, 'utf8');
      const data = Buffer.from(content, 'utf8');
      const sum = crc32(data);
      const localHeader = Buffer.alloc(30);
      localHeader.writeUInt32LE(0x04034b50, 0);
      localHeader.writeUInt16LE(20, 4);
      localHeader.writeUInt32LE(sum, 14);
      localHeader.writeUInt32LE(data.length, 18);
      localHeader.writeUInt32LE(data.length, 22);
      localHeader.writeUInt16LE(name.length, 26);
      localHeader.writeUInt16LE(localExtra.length, 28);
      const centralHeader = Buffer.alloc(46);
      centralHeader.writeUInt32LE(0x02014b50, 0);
      centralHeader.writeUInt16LE(20, 4);
      centralHeader.writeUInt16LE(20, 6);
      centralHeader.writeUInt32LE(sum, 16);
      centralHeader.writeUInt32LE(data.length, 20);
      centralHeader.writeUInt32LE(data.length, 24);
      centralHeader.writeUInt16LE(name.length, 28);
      centralHeader.writeUInt16LE(centralExtra.length, 30);
      centralHeader.writeUInt32LE(localOffset, 42);
      localParts.push(localHeader, name, localExtra, data);
      centralParts.push(centralHeader, name, centralExtra);
      localOffset += localHeader.length + name.length + localExtra.length + data.length;
    }
    const centralBuf = Buffer.concat(centralParts);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(items.length, 8);
    eocd.writeUInt16LE(items.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(localOffset, 16);
    return Buffer.concat([...localParts, centralBuf, eocd]);
  };
  const duplicateArchive = buildSyntheticZip([
    { name: 'test.txt', content: 'birinci' },
    { name: 'test.txt', content: 'ikinci' }
  ]);
  assert.throws(() => readZipEntries(duplicateArchive), /yinelenen ZIP parça adı/);
  const validExtra = Buffer.from([0x55, 0x54, 0x04, 0x00, 0x01, 0x02, 0x03, 0x04]);
  const overflowExtra = Buffer.from([0x55, 0x54, 0x10, 0x00, 0x01, 0x02, 0x03, 0x04]);
  const alternativeName = Buffer.from('alternatif.txt');
  const unicodePath = Buffer.alloc(9 + alternativeName.length);
  unicodePath.writeUInt16LE(0x7075, 0);
  unicodePath.writeUInt16LE(unicodePath.length - 4, 2);
  unicodePath[4] = 1;
  unicodePath.writeUInt32LE(crc32(Buffer.from('test.txt')), 5);
  alternativeName.copy(unicodePath, 9);
  for (const field of ['localExtra', 'centralExtra']) {
    assert.throws(() => readZipEntries(buildSyntheticZip([{ name: 'test.txt', content: 'merhaba', [field]: unicodePath }])),
      /ZIP Unicode yol ek alanı yasak/);
  }
  const zip64Extra = Buffer.from([0x01, 0x00, 0x08, 0x00, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  assert.equal(readZipEntries(buildSyntheticZip([{ name: 'test.txt', content: 'merhaba', localExtra: validExtra, centralExtra: validExtra }])).get('test.txt').toString('utf8'), 'merhaba');
  assert.throws(() => readZipEntries(buildSyntheticZip([{ name: 'test.txt', content: 'merhaba', localExtra: overflowExtra }])), /ZIP ek alan kayıt uzunluğu sınırı aşıyor/);
  assert.throws(() => readZipEntries(buildSyntheticZip([{ name: 'test.txt', content: 'merhaba', centralExtra: overflowExtra }])), /ZIP ek alan kayıt uzunluğu sınırı aşıyor/);
  assert.throws(() => readZipEntries(buildSyntheticZip([{ name: 'test.txt', content: 'merhaba', localExtra: zip64Extra }])), /ZIP64 ek alan kaydı yasak/);
  assert.throws(() => readZipEntries(buildSyntheticZip([{ name: 'test.txt', content: 'merhaba', centralExtra: zip64Extra }])), /ZIP64 ek alan kaydı yasak/);
});

function ensureWordChild(parent, tag) {
  return child(parent, tag) ?? parent.insertBefore(parent.ownerDocument.createElementNS(parent.namespaceURI, tag), parent.firstChild);
}

function mutateXmlPart(name, mutator) {
  const doc = parseDocxXml(docx.text(name), name);
  mutator(doc);
  const changed = serializeDocxXml(doc);
  return { ...docx, text: (target) => target === name ? changed : docx.text(target) };
}

test('şablon: geçersiz OOXML, dış ilişki, içerik türü, revizyon, gizli metin ve alan bozulmaları reddedilir', () => {
  // Bozuk XML (serileştirici yazımından bağımsız doğrudan hatalı XML girdisi)
  const brokenHeader = '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p></w:hdr>';
  assert.throws(() => validateDocxXml({ ...docx, text: (target) => target === 'word/header2.xml' ? brokenHeader : docx.text(target) }), /bozuk XML/);

  // Dış ilişki (ana belge ilişkisi rId1 varsayımı yerine türüne göre seçilir)
  assert.throws(() => validateDocxXml(mutateXmlPart('_rels/.rels', (doc) => {
    const rel = [...doc.documentElement.children].find((el) => el.getAttribute('Type')?.endsWith('/officeDocument'));
    assert.ok(rel);
    rel.setAttribute('TargetMode', 'External');
  })), /dış ilişki yasak/);

  // OPC ilişki kimliği XML xsd:ID kuralına uymadığında reddedilmeli, rId dışı geçerli kimlik kabul edilmelidir.
  assert.throws(() => validateDocxXml(mutateXmlPart('_rels/.rels', (doc) => {
    const rel = [...doc.documentElement.children].find((el) => el.getAttribute('Type')?.endsWith('/officeDocument'));
    assert.ok(rel);
    rel.setAttribute('Id', '1');
  })), /ilişki kimliği veya türü geçersiz/);
  validateDocxXml(mutateXmlPart('_rels/.rels', (doc) => {
    const rel = [...doc.documentElement.children].find((el) => el.getAttribute('Type')?.endsWith('/officeDocument'));
    assert.ok(rel);
    const ids = new Set([...doc.documentElement.children].map((node) => node.getAttribute('Id')));
    let id = 'anaBelgeIliskisi';
    while (ids.has(id)) id += '_';
    rel.setAttribute('Id', id);
  }));

  const rootTarget = (target) => mutateXmlPart('_rels/.rels', (doc) => {
    [...doc.documentElement.children].find((node) => node.getAttribute('Type')?.endsWith('/officeDocument'))
      .setAttribute('Target', target);
  });
  validateDocxXml(rootTarget('/word/./document.xml'));
  for (const target of ['word//document.xml', '/../../word/document.xml']) {
    assert.throws(() => validateDocxXml(rootTarget(target)), /ilişki hedefi geçersiz|paket kökünü aşıyor/);
  }
  assert.throws(() => validateDocxXml(mutateXmlPart('_rels/.rels', (doc) => {
    const core = [...doc.documentElement.children].find((node) => node.getAttribute('Target') === 'docProps/core.xml');
    const alias = core.cloneNode();
    alias.setAttribute('Id', 'cekirdekEsAdi');
    alias.setAttribute('Type', 'urn:cekirdek-es-adi');
    doc.documentElement.append(alias);
  })), /çekirdek özellik parçasına tek ilişki/);
  const upperOverride = (duplicate) => mutateXmlPart('[Content_Types].xml', (doc) => {
    const original = [...doc.documentElement.children].find((node) => node.getAttribute('PartName') === '/word/document.xml');
    const override = duplicate ? doc.documentElement.appendChild(original.cloneNode()) : original;
    override.setAttribute('PartName', '/WORD/DOCUMENT.XML');
  });
  validateDocxXml(upperOverride(false));
  assert.throws(() => validateDocxXml(upperOverride(true)), /geçersiz içerik türü parçası/);
  assert.throws(() => validateDocxXml(mutateXmlPart('word/footer1.xml', (doc) => {
    const label = all(doc, 'w:t').find((node) => node.textContent === 'Sayfa ');
    assert.ok(label, 'sayfa etiketi metni bulunmalıdır');
    label.after(doc.createElementNS(label.namespaceURI, 'w:br'));
  })), /sayfa sayaç konumu geçersiz/);

  const sectionAndMargins = (duplicate) => mutateXmlPart('word/document.xml', (doc) => {
    const section = all(doc, 'w:sectPr')[0];
    const borders = doc.createElementNS(section.namespaceURI, 'w:pgBorders');
    section.insertBefore(borders, child(section, 'w:cols'));
    const margin = all(doc, 'w:tblCellMar')[0];
    assert.ok(margin);
    const left = child(margin, 'w:left');
    const start = doc.createElementNS(margin.namespaceURI, 'w:start');
    start.setAttributeNS(margin.namespaceURI, 'w:w', '90');
    start.setAttributeNS(margin.namespaceURI, 'w:type', 'dxa');
    margin.insertBefore(start, left);
    if (duplicate) margin.insertBefore(start.cloneNode(), left);
  });
  validateDocxXml(sectionAndMargins(false));
  assert.throws(() => validateDocxXml(sectionAndMargins(true)), /öğe sırası|yinelenen/);

  // Word stil kalıtımı: BilginGovde Heading1'e dayandırıldığında veya döngüsel kalıtım oluştuğunda reddedilmelidir.
  assert.throws(() => {
    const stylesDoc = parseDocxXml(docx.text('word/styles.xml'), 'word/styles.xml');
    const bodyStyle = all(stylesDoc, 'w:style').find((el) => attr(el, 'w:styleId') === 'BilginGovde');
    assert.ok(bodyStyle);
    const basedOn = child(bodyStyle, 'w:basedOn');
    basedOn.setAttributeNS(basedOn.namespaceURI, 'w:val', 'Heading1');
    checkStyles(stylesDoc);
  }, /Normal üst stiline dayanmalıdır/);
  assert.throws(() => {
    const stylesDoc = parseDocxXml(docx.text('word/styles.xml'), 'word/styles.xml');
    const wNs = stylesDoc.documentElement.namespaceURI;
    const normalStyle = all(stylesDoc, 'w:style').find((el) => attr(el, 'w:styleId') === 'Normal');
    const basedOn = stylesDoc.createElementNS(wNs, 'w:basedOn');
    basedOn.setAttributeNS(wNs, 'w:val', 'BilginGovde');
    normalStyle.appendChild(basedOn);
    checkStyles(stylesDoc);
  }, /döngüsel Word stil kalıtımı yasak/);

  // Ekler başlığında doğrudan w:pageBreakBefore w:val="0" geçersiz kılması reddedilmelidir (mevcut öğe varsa güncellenir).
  assert.throws(() => {
    const doc = parseDocxXml(docx.text('word/document.xml'), 'word/document.xml');
    const wNs = doc.documentElement.namespaceURI;
    const appendix = all(doc, 'w:p').find((p) => paragraphStyle(p) === 'BilginEkBasligi');
    assert.ok(appendix);
    const pPr = child(appendix, 'w:pPr');
    let pb = child(pPr, 'w:pageBreakBefore');
    if (!pb) {
      pb = doc.createElementNS(wNs, 'w:pageBreakBefore');
      pPr.appendChild(pb);
    }
    pb.setAttributeNS(wNs, 'w:val', '0');
    checkSectionPlaceholders(doc);
  }, /Ekler başlığında stil pageBreakBefore doğrudan kapatılamaz/);

  // İzinli XML/SVG parçalarındaki gizli XML yorumları reddedilmelidir (ad alanı önekinden bağımsız DOM üzerinden eklenir).
  assert.throws(() => validateDocxXml(mutateXmlPart('word/media/kapak-yedigen.svg', (svgDoc) => {
    svgDoc.documentElement.appendChild(svgDoc.createComment(' Gizli Proje Atlas '));
  })), /gizli XML yorumu yasak/);

  // OPC ilişki hedefleri ASCII büyük/küçük harf eşdeğerliğiyle çözülmeli; w:sym ve hatalı OOXML alt öğe sırası reddedilmelidir.
  validateDocxXml(mutateXmlPart('word/_rels/document.xml.rels', (doc) => {
    const stylesRel = [...doc.documentElement.children].find((el) => el.getAttribute('Type')?.endsWith('/styles'));
    assert.ok(stylesRel);
    stylesRel.setAttribute('Target', 'STYLES.XML');
  }));
  assert.throws(() => validateDocxXml(mutateXmlPart('word/document.xml', (doc) => {
    const wNs = doc.documentElement.namespaceURI;
    const firstP = all(doc, 'w:p').find((p) => paragraphStyle(p) === 'BilginGovde');
    const run = doc.createElementNS(wNs, 'w:r');
    const sym = doc.createElementNS(wNs, 'w:sym');
    sym.setAttributeNS(wNs, 'w:font', 'Wingdings');
    sym.setAttributeNS(wNs, 'w:char', 'F04A');
    run.appendChild(sym);
    firstP.appendChild(run);
  })), /izin verilmeyen öğe w:sym/);
  assert.throws(() => validateDocxXml(mutateXmlPart('word/document.xml', (doc) => {
    const tblPr = all(doc, 'w:tblPr').find((el) => child(el, 'w:tblLayout') && child(el, 'w:tblCellMar'));
    assert.ok(tblPr);
    tblPr.insertBefore(child(tblPr, 'w:tblCellMar'), child(tblPr, 'w:tblLayout'));
  })), /OOXML alt öğe sırası geçersiz/);

  // Word şablonunda değişiklik izleme (w:trackRevisions) etkinleştirildiğinde reddedilmeli, kapalıyken kabul edilmelidir.
  assert.throws(() => {
    const settingsDoc = parseDocxXml(docx.text('word/settings.xml'), 'word/settings.xml');
    const wNs = settingsDoc.documentElement.namespaceURI;
    const tr = settingsDoc.createElementNS(wNs, 'w:trackRevisions');
    tr.setAttributeNS(wNs, 'w:val', '1');
    settingsDoc.documentElement.appendChild(tr);
    checkDocumentSettings(settingsDoc);
  }, /değişiklik izleme \(w:trackRevisions\) kapalı olmalıdır/);

  // Bölüm sayfa numarası başlangıcı 1'den büyük veya biçimi ondalık dışı olduğunda reddedilmeli, 1/decimal kabul edilmelidir.
  const setSectionPageNum = (doc, startValue, fmtValue = null) => {
    const wNs = doc.documentElement.namespaceURI;
    const sectPr = all(doc, 'w:sectPr')[0];
    let pgNumType = child(sectPr, 'w:pgNumType');
    if (!pgNumType) {
      pgNumType = doc.createElementNS(wNs, 'w:pgNumType');
      sectPr.appendChild(pgNumType);
    }
    if (startValue !== null) pgNumType.setAttributeNS(wNs, 'w:start', startValue);
    if (fmtValue !== null) pgNumType.setAttributeNS(wNs, 'w:fmt', fmtValue);
  };
  assert.throws(() => {
    const doc = parseDocxXml(docx.text('word/document.xml'), 'word/document.xml');
    setSectionPageNum(doc, '25');
    checkSectionLayout(doc);
  }, /sayfa numaralandırması 1 ile başlamalıdır/);
  assert.throws(() => {
    const doc = parseDocxXml(docx.text('word/document.xml'), 'word/document.xml');
    setSectionPageNum(doc, '1', 'upperRoman');
    checkSectionLayout(doc);
  }, /sayfa numarası biçimi ondalık/);
  {
    const doc = parseDocxXml(docx.text('word/document.xml'), 'word/document.xml');
    setSectionPageNum(doc, '1', 'decimal');
    checkSectionLayout(doc);
  }

  // Zorunlu kaynak/yöntem notu üzerinde beyaz (FFFFFF) doğrudan metin rengi reddedilmelidir.
  assert.throws(() => {
    const doc = parseDocxXml(docx.text('word/document.xml'), 'word/document.xml');
    const wNs = doc.documentElement.namespaceURI;
    const noteRun = all(doc, 'w:r').find((run) => all(run, 'w:t').some((t) => t.textContent.includes('{{KAYNAK_VE_YONTEM_NOTU}}')));
    assert.ok(noteRun);
    let rPr = child(noteRun, 'w:rPr');
    if (!rPr) {
      rPr = doc.createElementNS(wNs, 'w:rPr');
      noteRun.insertBefore(rPr, noteRun.firstChild);
    }
    const color = doc.createElementNS(wNs, 'w:color');
    color.setAttributeNS(wNs, 'w:val', 'FFFFFF');
    rPr.appendChild(color);
    checkPalette(doc, 'word/document.xml');
  }, /doğrudan metin rengi \(FFFFFF\) atanan paragraf stili \(BilginKaynakNotu\) ile çelişiyor/);

  // İzinli çekirdek üstveri alanlarında geçersiz tarih, eksik xsi:type veya serbest metin reddedilmelidir (isteğe bağlı öğe yoksa oluşturulur).
  const ensureCoreChild = (coreDoc, ns, qName) => {
    let el = child(coreDoc.documentElement, qName);
    if (!el) {
      el = coreDoc.createElementNS(ns, qName);
      coreDoc.documentElement.appendChild(el);
    }
    return el;
  };
  assert.throws(() => {
    const coreDoc = parseDocxXml(docx.text('docProps/core.xml'), 'docProps/core.xml');
    const created = ensureCoreChild(coreDoc, 'http://purl.org/dc/terms/', 'dcterms:created');
    created.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:dcterms', 'http://purl.org/dc/terms/');
    created.setAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'xsi:type', 'dcterms:W3CDTF');
    created.textContent = 'Gizli Proje Atlas';
    checkCoreProperties(coreDoc);
  }, /geçerli UTC ISO-8601 \(W3CDTF\) tarih damgası olmalıdır/);
  assert.throws(() => {
    const coreDoc = parseDocxXml(docx.text('docProps/core.xml'), 'docProps/core.xml');
    const created = ensureCoreChild(coreDoc, 'http://purl.org/dc/terms/', 'dcterms:created');
    created.removeAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'type');
    created.textContent = '2026-11-09T08:00:00Z';
    checkCoreProperties(coreDoc);
  }, /xsi:type özniteliği W3CDTF türüyle zorunludur/);
  assert.throws(() => {
    const coreDoc = parseDocxXml(docx.text('docProps/core.xml'), 'docProps/core.xml');
    const rev = ensureCoreChild(coreDoc, 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties', 'cp:revision');
    rev.textContent = 'Gizli';
    checkCoreProperties(coreDoc);
  }, /cp:revision pozitif tamsayı olmalıdır/);

  for (const [date, valid] of [['2028-02-29T08:00:00Z', true], ['2026-02-30T08:00:00Z', false]]) {
    const core = parseDocxXml(docx.text('docProps/core.xml'), 'docProps/core.xml');
    const created = ensureCoreChild(core, 'http://purl.org/dc/terms/', 'dcterms:created');
    created.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:dcterms', 'http://purl.org/dc/terms/');
    created.setAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'xsi:type', 'dcterms:W3CDTF');
    created.textContent = date;
    if (valid) checkCoreProperties(core);
    else assert.throws(() => checkCoreProperties(core), /geçerli takvim tarihli/);
  }

  // Özet tablo hücresinde yatay birleştirme (w:hMerge) reddedilmelidir.
  assert.throws(() => {
    const doc = parseDocxXml(docx.text('word/document.xml'), 'word/document.xml');
    const wNs = doc.documentElement.namespaceURI;
    const summaryTable = all(doc, 'w:tbl').find((table) => attr(child(child(table, 'w:tblPr'), 'w:tblStyle')) === spec.tablolar.donem_gorev_ozeti.stil);
    const dataCell = children(children(summaryTable, 'w:tr')[1], 'w:tc')[0];
    let tcPr = child(dataCell, 'w:tcPr');
    if (!tcPr) {
      tcPr = doc.createElementNS(wNs, 'w:tcPr');
      dataCell.insertBefore(tcPr, dataCell.firstChild);
    }
    const hMerge = doc.createElementNS(wNs, 'w:hMerge');
    hMerge.setAttributeNS(wNs, 'w:val', 'restart');
    tcPr.appendChild(hMerge);
    checkSummaryTable(doc);
  }, /yatay birleştirme \(w:hMerge\) yasak/);

  // Özel belge özelliği vt:lpwstr yerine vt:i4 içine yazıldığında reddedilmelidir.
  assert.throws(() => {
    const customDoc = parseDocxXml(docx.text('docProps/custom.xml'), 'docProps/custom.xml');
    const prop = [...customDoc.documentElement.children].find((el) => el.getAttribute('name') === 'BilginStilSurumu');
    assert.ok(prop);
    const vtNs = 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes';
    const badVal = customDoc.createElementNS(vtNs, 'vt:i4');
    badVal.textContent = '1.0.0';
    prop.replaceChildren(badVal);
    checkCustomProperties(customDoc);
  }, /özel özellik metin \(vt:lpwstr\) türünde olmalıdır/);

  // HEPT_PATHS ayıklayıcısı yeni satırda açılan dizi biçimlendirmesini de ayrıştırmalıdır.
  const reformattedPaths = parseHeptPaths(
    "const HEPT_PATHS =\n[\n  { tone: 'teal', d: 'M0 0L1 1' },\n  { d: 'M1 1L2 2', tone: \"orange\" },\n];"
  );
  assert.deepEqual(reformattedPaths, [
    { tone: 'teal', d: 'M0 0L1 1' },
    { tone: 'orange', d: 'M1 1L2 2' }
  ]);

  // Kapak görselinde sıfır olmayan a:srcRect kırpması, a:alphaModFix efekti, aynalama (flipH/flipV) ve yetkisiz alternatif metin reddedilmelidir.
  assert.throws(() => {
    const doc = parseDocxXml(docx.text('word/document.xml'), 'word/document.xml');
    const blip = all(doc, 'a:blip')[0];
    assert.ok(blip);
    let srcRect = child(blip.parentNode, 'a:srcRect');
    if (!srcRect) {
      srcRect = doc.createElementNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'a:srcRect');
      blip.parentNode.appendChild(srcRect);
    }
    srcRect.setAttribute('r', '50000');
    checkCoverRelationships(doc, documentRelationship);
  }, /kapak resmi kırpılamaz/);
  assert.throws(() => {
    const doc = parseDocxXml(docx.text('word/document.xml'), 'word/document.xml');
    const blip = all(doc, 'a:blip')[0];
    assert.ok(blip);
    const alpha = doc.createElementNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'a:alphaModFix');
    alpha.setAttribute('amt', '0');
    blip.appendChild(alpha);
    checkCoverRelationships(doc, documentRelationship);
  }, /görüntü efekti yasak/);
  assert.throws(() => {
    const doc = parseDocxXml(docx.text('word/document.xml'), 'word/document.xml');
    const picXfrm = child(all(all(doc, 'wp:anchor')[0], 'pic:spPr')[0], 'a:xfrm');
    picXfrm.setAttribute('flipH', '1');
    checkCoverRelationships(doc, documentRelationship);
  }, /kapak resmi çevrilemez/);
  {
    const doc = parseDocxXml(docx.text('word/document.xml'), 'word/document.xml');
    const picXfrm = child(all(all(doc, 'wp:anchor')[0], 'pic:spPr')[0], 'a:xfrm');
    picXfrm.setAttribute('flipH', '0');
    picXfrm.setAttribute('flipV', 'false');
    checkCoverRelationships(doc, documentRelationship);
  }
  assert.throws(() => {
    const doc = parseDocxXml(docx.text('word/document.xml'), 'word/document.xml');
    const docPr = child(all(doc, 'wp:anchor')[0], 'wp:docPr');
    docPr.setAttribute('descr', 'Atlas projesinin gizli raporu');
    checkCoverRelationships(doc, documentRelationship);
  }, /wp:docPr descr alanı/);

  // Kapak resmi döndürme (rot) ve eksik/boş konum öznitelikleri reddedilmelidir.
  assert.throws(() => {
    const doc = parseDocxXml(docx.text('word/document.xml'), 'word/document.xml');
    const picXfrm = child(all(all(doc, 'wp:anchor')[0], 'pic:spPr')[0], 'a:xfrm');
    picXfrm.setAttribute('rot', '5400000');
    checkCoverRelationships(doc, documentRelationship);
  }, /kapak resmi döndürülemez/);
  {
    const doc = parseDocxXml(docx.text('word/document.xml'), 'word/document.xml');
    const picXfrm = child(all(all(doc, 'wp:anchor')[0], 'pic:spPr')[0], 'a:xfrm');
    picXfrm.setAttribute('rot', '0');
    checkCoverRelationships(doc, documentRelationship);
  }
  assert.throws(() => {
    const doc = parseDocxXml(docx.text('word/document.xml'), 'word/document.xml');
    const picOff = child(child(all(all(doc, 'wp:anchor')[0], 'pic:spPr')[0], 'a:xfrm'), 'a:off');
    picOff.removeAttribute('x');
    checkCoverRelationships(doc, documentRelationship);
  }, /a:off x konumu 0 olmalıdır/);
  assert.throws(() => {
    const doc = parseDocxXml(docx.text('word/document.xml'), 'word/document.xml');
    const posOffset = child(child(all(doc, 'wp:anchor')[0], 'wp:positionH'), 'wp:posOffset');
    posOffset.textContent = '';
    checkCoverRelationships(doc, documentRelationship);
  }, /kapak yatay konumu sayfa başlangıcında/);

  // Özet tabloda sağdan sola görünüm (w:bidiVisual) reddedilmelidir (mevcut öğe varsa etkinleştirilir).
  assert.throws(() => {
    const doc = parseDocxXml(docx.text('word/document.xml'), 'word/document.xml');
    const wNs = doc.documentElement.namespaceURI;
    const summaryTable = all(doc, 'w:tbl').find((table) => attr(child(child(table, 'w:tblPr'), 'w:tblStyle')) === spec.tablolar.donem_gorev_ozeti.stil);
    const tblPr = child(summaryTable, 'w:tblPr');
    let bidi = child(tblPr, 'w:bidiVisual');
    if (!bidi) {
      bidi = doc.createElementNS(wNs, 'w:bidiVisual');
      tblPr.appendChild(bidi);
    }
    bidi.setAttributeNS(wNs, 'w:val', '1');
    checkSummaryTable(doc);
  }, /w:bidiVisual kapalı olmalıdır/);

  // Sabit metin bitişik w:r/w:t akışlarına bölündüğünde kabul edilmelidir.
  {
    const doc = parseDocxXml(docx.text('word/document.xml'), 'word/document.xml');
    const wNs = doc.documentElement.namespaceURI;
    const xmlNs = 'http://www.w3.org/XML/1998/namespace';
    const label = all(doc, 'w:p').find((node) => paragraphText(node) === 'Kurum İçi');
    assert.ok(label);
    const targetText = all(label, 'w:t').find((node) => node.textContent === 'Kurum İçi');
    if (targetText) {
      const parentRun = targetText.parentNode;
      targetText.textContent = 'Kurum ';
      targetText.setAttributeNS(xmlNs, 'xml:space', 'preserve');
      const nextRun = doc.createElementNS(wNs, 'w:r');
      const nextText = doc.createElementNS(wNs, 'w:t');
      nextText.textContent = 'İçi';
      nextRun.appendChild(nextText);
      parentRun.parentNode.insertBefore(nextRun, parentRun.nextSibling);
    }
    const titles = spec.yapi.bolumler.map((section) => section.baslik).filter(Boolean);
    const allowedDoc = new Set([...spec.sabit_metinler.kapak, ...spec.sabit_metinler.govde, ...titles]);
    checkDeclaredFixedText(doc, allowedDoc, 'word/document.xml');
  }

  {
    const doc = parseDocxXml(docx.text('word/document.xml'), 'word/document.xml');
    const title = all(doc, 'w:p').find((node) => paragraphText(node) === 'Kurum İçi');
    const run = all(title, 'w:r').at(-1);
    run.prepend(doc.createElementNS(run.namespaceURI, 'w:noBreakHyphen'));
    const titles = spec.yapi.bolumler.map((section) => section.baslik).filter(Boolean);
    assert.throws(() => checkDeclaredFixedText(doc, new Set([...spec.sabit_metinler.kapak, ...spec.sabit_metinler.govde, ...titles]),
      'word/document.xml'), /ilan edilmemiş metin/);
  }

  // Adlandırılmış vurgu rengi (w:highlight), a:prstClr ve dönüşümlü a:schemeClr palet denetiminde reddedilmelidir.
  assert.throws(() => {
    const doc = parseDocxXml(docx.text('word/document.xml'), 'word/document.xml');
    const wNs = doc.documentElement.namespaceURI;
    const rPr = all(doc, 'w:rPr')[0];
    const hl = doc.createElementNS(wNs, 'w:highlight');
    hl.setAttributeNS(wNs, 'w:val', 'yellow');
    rPr.appendChild(hl);
    checkPalette(doc, 'word/document.xml');
  }, /adlandırılmış vurgu rengi \(w:highlight\) yasak/);
  assert.throws(() => {
    const doc = parseDocxXml(docx.text('word/document.xml'), 'word/document.xml');
    const aNs = 'http://schemas.openxmlformats.org/drawingml/2006/main';
    const prst = doc.createElementNS(aNs, 'a:prstClr');
    prst.setAttribute('val', 'red');
    all(doc, 'pic:spPr')[0].appendChild(prst);
    checkPalette(doc, 'word/document.xml');
  }, /adlandırılmış veya sistem DrawingML rengi yasak/);
  assert.throws(() => {
    const doc = parseDocxXml(docx.text('word/document.xml'), 'word/document.xml');
    const aNs = 'http://schemas.openxmlformats.org/drawingml/2006/main';
    const scheme = doc.createElementNS(aNs, 'a:schemeClr');
    scheme.setAttribute('val', 'accent1');
    const lumMod = doc.createElementNS(aNs, 'a:lumMod');
    lumMod.setAttribute('val', '50000');
    scheme.appendChild(lumMod);
    all(doc, 'pic:spPr')[0].appendChild(scheme);
    checkPalette(doc, 'word/document.xml');
  }, /DrawingML renk dönüşümü yasak/);

  // Dış SQL veri bağlantısı (w:mailMerge), gizli belge değişkeni (w:docVars), mc:AlternateContent, w:specVanish ve xml:space eksikliği reddedilmelidir.
  assert.throws(() => validateDocxXml(mutateXmlPart('word/settings.xml', (doc) => {
    const wNs = doc.documentElement.namespaceURI;
    doc.documentElement.appendChild(doc.createElementNS(wNs, 'w:mailMerge'));
  })), /izin verilmeyen öğe w:mailMerge/);
  assert.throws(() => validateDocxXml(mutateXmlPart('word/settings.xml', (doc) => {
    const wNs = doc.documentElement.namespaceURI;
    const vars = doc.createElementNS(wNs, 'w:docVars');
    const v = doc.createElementNS(wNs, 'w:docVar');
    v.setAttributeNS(wNs, 'w:name', 'gizli');
    v.setAttributeNS(wNs, 'w:val', 'Atlas');
    vars.appendChild(v);
    doc.documentElement.appendChild(vars);
  })), /izin verilmeyen öğe w:docVars/);
  assert.throws(() => validateDocxXml(mutateXmlPart('word/document.xml', (doc) => {
    const mcNs = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
    const alt = doc.createElementNS(mcNs, 'mc:AlternateContent');
    all(doc, 'w:body')[0].appendChild(alt);
  })), /izin verilmeyen öğe mc:AlternateContent/);
  assert.throws(() => validateDocxXml(mutateXmlPart('word/document.xml', (doc) => {
    const wNs = doc.documentElement.namespaceURI;
    const notePara = all(doc, 'w:p').find((p) => all(p, 'w:t').some((t) => t.textContent.includes('{{KAYNAK_VE_YONTEM_NOTU}}')));
    assert.ok(notePara);
    const pPr = child(notePara, 'w:pPr');
    const rPr = doc.createElementNS(wNs, 'w:rPr');
    rPr.appendChild(doc.createElementNS(wNs, 'w:specVanish'));
    pPr.appendChild(rPr);
  })), /gizli metin biçimi yasak \(w:specVanish\)/);
  assert.throws(() => validateDocxXml(mutateXmlPart('word/footer1.xml', (doc) => {
    const sayfaText = all(doc, 'w:t').find((node) => node.textContent === 'Sayfa ');
    assert.ok(sayfaText);
    sayfaText.removeAttributeNS('http://www.w3.org/XML/1998/namespace', 'space');
  })), /xml:space="preserve" zorunludur/);

  // PNG yardımcı parça doğrulaması: mevcut parçalar temizlenerek pHYs, sRGB/gAMA ve sRGB/cHRM uyumluluğu sınanır.
  const stripPngChunks = (png, types) => {
    const drop = new Set(types);
    const out = [png.subarray(0, 8)];
    for (let offset = 8; offset < png.length;) {
      const length = png.readUInt32BE(offset);
      const end = offset + 12 + length;
      const type = png.toString('latin1', offset + 4, offset + 8);
      if (!drop.has(type)) out.push(png.subarray(offset, end));
      offset = end;
    }
    return Buffer.concat(out);
  };
  const insertPngChunk = (png, chunkType, data) => {
    const type = Buffer.from(chunkType, 'latin1');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([type, data])), 0);
    const chunk = Buffer.concat([len, type, data, crc]);
    // IHDR (8 imza + 25 bayt IHDR = 33) hemen sonrasına yerleştirilir.
    return Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
  };
  const insertPhysChunk = (png, ppuX, ppuY, unit = 1) => {
    const data = Buffer.alloc(9);
    data.writeUInt32BE(ppuX, 0);
    data.writeUInt32BE(ppuY, 4);
    data[8] = unit;
    return insertPngChunk(stripPngChunks(png, ['pHYs']), 'pHYs', data);
  };
  const insertGammaChunk = (png, gamma) => {
    const data = Buffer.alloc(4);
    data.writeUInt32BE(gamma, 0);
    return insertPngChunk(stripPngChunks(png, ['gAMA']), 'gAMA', data);
  };
  const insertChrmChunk = (png, values) => {
    const data = Buffer.alloc(32);
    values.forEach((value, idx) => data.writeUInt32BE(value, idx * 4));
    return insertPngChunk(stripPngChunks(png, ['cHRM']), 'cHRM', data);
  };
  const coverPngBytes = docx.buffer('word/media/kapak-yedigen.png');
  const coverPalette = {
    background: paletteColor(spec.gorseller.kapak_yedigeni.zemin),
    strokes: [
      paletteColor(spec.gorseller.kapak_yedigeni.renk_eslemesi.teal),
      paletteColor(spec.gorseller.kapak_yedigeni.renk_eslemesi.orange)
    ]
  };
  validateCoverPng(insertPhysChunk(coverPngBytes, 2953, 2953, 1), coverPalette);
  assert.throws(() => validateCoverPng(insertPhysChunk(coverPngBytes, 5906, 2953, 1), coverPalette),
    /PNG pHYs yatay ve dikey yoğunlukları eşit ve pozitif olmalıdır/);
  const srgbPng = insertPngChunk(stripPngChunks(coverPngBytes, ['sRGB', 'gAMA', 'cHRM']), 'sRGB', Buffer.from([0]));
  const plainPng = stripPngChunks(coverPngBytes, ['sRGB', 'gAMA', 'cHRM']);
  validateCoverPng(insertGammaChunk(srgbPng, 45455), coverPalette);
  assert.throws(() => validateCoverPng(insertGammaChunk(srgbPng, 100000), coverPalette),
    /PNG gAMA değeri sRGB standardıyla uyumlu \(45455\) olmalıdır/);
  assert.throws(() => validateCoverPng(insertGammaChunk(plainPng, 100000), coverPalette),
    /PNG gAMA değeri sRGB standardıyla uyumlu \(45455\) olmalıdır/);
  validateCoverPng(insertChrmChunk(srgbPng, [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000]), coverPalette);
  assert.throws(
    () => validateCoverPng(insertChrmChunk(srgbPng, [31270, 32900, 63000, 33000, 30000, 60000, 15000, 6000]), coverPalette),
    /PNG cHRM kromatiklik değerleri sRGB standardıyla uyumlu olmalıdır/
  );
  // Gerçek camgöbeği (077780) pikseli olmadan yalnızca laciverte yakın (003A90) satır taşıyan PNG reddedilmelidir.
  {
    const width = 210;
    const height = 297;
    const rowBytes = 1 + width * 3;
    const raw = Buffer.alloc(rowBytes * height);
    for (let y = 0; y < height; y += 1) {
      const start = y * rowBytes;
      raw[start] = 0;
      const [r, g, b] = y === 10 ? [0x00, 0x3a, 0x90] : y === 20 ? [0xff, 0x56, 0x20] : [0x00, 0x30, 0x87];
      for (let x = 0; x < width; x += 1) {
        const px = start + 1 + x * 3;
        raw[px] = r;
        raw[px + 1] = g;
        raw[px + 2] = b;
      }
    }
    const makeChunk = (chunkType, data) => {
      const type = Buffer.from(chunkType, 'latin1');
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length, 0);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(Buffer.concat([type, data])), 0);
      return Buffer.concat([len, type, data, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const noTealPng = Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      makeChunk('IHDR', ihdr),
      makeChunk('IDAT', deflateSync(raw)),
      makeChunk('IEND', Buffer.alloc(0))
    ]);
    assert.throws(() => validateCoverPng(noTealPng, coverPalette), /onaylı yedigen çizgi rengi bulunamadı: 077780/);
  }

  // Paket kökü ana belge ilişkisi yanlış hedefe yönlendirildiğinde (ilişki türüyle seçilir)
  assert.throws(() => validateDocxXml(mutateXmlPart('_rels/.rels', (doc) => {
    const rel = [...doc.documentElement.children].find((el) => el.getAttribute('Type')?.endsWith('/officeDocument'));
    assert.ok(rel);
    rel.setAttribute('Target', 'word/header1.xml');
  })), /paket kökü ana belge ilişkisi/);

  // Ana belge içerik türü Override kaldırıldığında
  assert.throws(() => validateDocxXml(mutateXmlPart('[Content_Types].xml', (doc) => {
    const ov = [...doc.documentElement.children].find((el) => el.getAttribute('PartName') === '/word/document.xml');
    assert.ok(ov);
    ov.remove();
  })), /paket kökü ana belge ilişkisi: içerik türü geçersiz/);

  // OPC ilişki (.rels) varsayılan içerik türü application/xml yapıldığında
  assert.throws(() => validateDocxXml(mutateXmlPart('[Content_Types].xml', (doc) => {
    const def = [...doc.documentElement.children].find((el) => el.getAttribute('Extension') === 'rels');
    assert.ok(def);
    def.setAttribute('ContentType', 'application/xml');
  })), /OPC ilişki içerik türü geçersiz/);

  // Ana belge styles ilişkisi numbering.xml hedefine saptırıldığında
  assert.throws(() => validateDocxXml(mutateXmlPart('word/_rels/document.xml.rels', (doc) => {
    const rel = [...doc.documentElement.children].find((el) => el.getAttribute('Type')?.endsWith('/styles'));
    assert.ok(rel);
    rel.setAttribute('Target', 'numbering.xml');
  })), /ana belge styles ilişkisi: içerik türü geçersiz/);

  // Ana belge styles ilişkisi silindiğinde
  assert.throws(() => validateDocxXml(mutateXmlPart('word/_rels/document.xml.rels', (doc) => {
    const rel = [...doc.documentElement.children].find((el) => el.getAttribute('Type')?.endsWith('/styles'));
    assert.ok(rel);
    rel.remove();
  })), /ana belge styles ilişkisi: tekil ilişki zorunludur/);

  const normalizeFieldInstr = (el) => (attr(el, 'w:instr') ?? '').trim().replace(/\s+/gu, ' ');

  // İzinli PAGE alanının komutu değiştirildiğinde (DOM üzerinden)
  assert.throws(() => validateDocxXml(mutateXmlPart('word/footer1.xml', (doc) => {
    const field = all(doc, 'w:fldSimple').find((el) => normalizeFieldInstr(el) === 'PAGE');
    assert.ok(field);
    field.setAttributeNS(field.namespaceURI, 'w:instr', ' UNKNOWN ');
  })), /Word alan komutları/);

  // İzinli PAGE alanının önbellekteki görünür sonucuna kurum/kişi metni eklendiğinde (önbellek düğümü yoksa oluşturulur)
  assert.throws(() => validateDocxXml(mutateXmlPart('word/footer1.xml', (doc) => {
    const field = all(doc, 'w:fldSimple').find((el) => normalizeFieldInstr(el) === 'PAGE');
    assert.ok(field);
    let t = all(field, 'w:t')[0];
    if (!t) {
      const run = doc.createElementNS(field.namespaceURI, 'w:r');
      t = doc.createElementNS(field.namespaceURI, 'w:t');
      run.appendChild(t);
      field.appendChild(run);
    }
    t.textContent = 'İlan edilmemiş kurum adı';
  })), /Word alan sonucu sayısal veya boş olmalıdır/);

  // Kilitli PAGE veya SEQ alanları reddedilmeli, açıkça kilitli olmayan (false/0) alanlar kabul edilmelidir.
  assert.throws(() => validateDocxXml(mutateXmlPart('word/footer1.xml', (doc) => {
    const field = all(doc, 'w:fldSimple').find((el) => normalizeFieldInstr(el) === 'PAGE');
    field.setAttributeNS(field.namespaceURI, 'w:fldLock', 'true');
  })), /kilitli Word alanı yasak/);
  assert.throws(() => validateDocxXml(mutateXmlPart('word/document.xml', (doc) => {
    const field = all(doc, 'w:fldSimple').find((el) => normalizeFieldInstr(el) === 'SEQ Şekil \\* ARABIC');
    assert.ok(field);
    field.setAttributeNS(field.namespaceURI, 'w:fldLock', '1');
  })), /kilitli Word alanı yasak/);
  validateDocxXml(mutateXmlPart('word/footer1.xml', (doc) => {
    const field = all(doc, 'w:fldSimple').find((el) => normalizeFieldInstr(el) === 'PAGE');
    field.setAttributeNS(field.namespaceURI, 'w:fldLock', 'false');
  }));

  // Şekil ve Tablo sayaçları başlık etiketinin önüne taşındığında reddedilmelidir.
  assert.throws(() => validateDocxXml(mutateXmlPart('word/document.xml', (doc) => {
    const field = all(doc, 'w:fldSimple').find((el) => normalizeFieldInstr(el) === 'SEQ Şekil \\* ARABIC');
    assert.ok(field);
    const paragraph = field.parentNode;
    const firstRun = children(paragraph, 'w:r')[0];
    paragraph.insertBefore(field, firstRun);
  })), /şekil sayacı Şekil etiketinden sonra/);
  assert.throws(() => validateDocxXml(mutateXmlPart('word/document.xml', (doc) => {
    const field = all(doc, 'w:fldSimple').find((el) => normalizeFieldInstr(el) === 'SEQ Tablo \\* ARABIC');
    assert.ok(field);
    const paragraph = field.parentNode;
    const firstRun = children(paragraph, 'w:r')[0];
    paragraph.insertBefore(field, firstRun);
  })), /tablo sayacı Tablo etiketinden sonra/);

  // Şekil sayacı başlık dışına (kapak paragrafına) taşındığında
  assert.throws(() => validateDocxXml(mutateXmlPart('word/document.xml', (doc) => {
    const field = all(doc, 'w:fldSimple').find((el) => normalizeFieldInstr(el) === 'SEQ Şekil \\* ARABIC');
    const cover = all(doc, 'w:body')[0].firstElementChild;
    assert.ok(field && cover);
    cover.appendChild(field);
  })), /şekil sayacı başlık stilinde olmalıdır/);

  // İzlenen silme değişikliği (w:del / w:delText) eklendiğinde
  assert.throws(() => validateDocxXml(mutateXmlPart('word/document.xml', (doc) => {
    const wNs = doc.documentElement.namespaceURI;
    const del = doc.createElementNS(wNs, 'w:del');
    del.setAttributeNS(wNs, 'w:id', '1');
    del.setAttributeNS(wNs, 'w:author', 'Kişi Adı');
    const run = doc.createElementNS(wNs, 'w:r');
    const dt = doc.createElementNS(wNs, 'w:delText');
    dt.textContent = 'Gizli proje bilgisi';
    run.appendChild(dt);
    del.appendChild(run);
    all(doc, 'w:p')[2].appendChild(del);
  })), /izin verilmeyen öğe w:del/);

  // Zorunlu kaynak notuna w:vanish gizleme biçimi eklendiğinde
  assert.throws(() => validateDocxXml(mutateXmlPart('word/document.xml', (doc) => {
    const wNs = doc.documentElement.namespaceURI;
    const node = all(doc, 'w:t').find((t) => t.textContent.includes('{{KAYNAK_VE_YONTEM_NOTU}}'));
    assert.ok(node);
    const run = node.parentNode;
    const rPr = doc.createElementNS(wNs, 'w:rPr');
    rPr.appendChild(doc.createElementNS(wNs, 'w:vanish'));
    run.insertBefore(rPr, run.firstChild);
  })), /gizli metin biçimi yasak/);

  // Özet tablo hücresine metin ve gridSpan değişmeden izlenen hücre silme (w:cellDel) eklendiğinde reddedilmelidir
  assert.throws(() => validateDocxXml(mutateXmlPart('word/document.xml', (doc) => {
    const wNs = doc.documentElement.namespaceURI;
    const summaryTbl = all(doc, 'w:tbl').find((t) => attr(child(child(t, 'w:tblPr'), 'w:tblStyle')) === spec.tablolar.donem_gorev_ozeti.stil);
    const lastDataCell = children(children(summaryTbl, 'w:tr')[1], 'w:tc').at(-1);
    const cellDel = doc.createElementNS(wNs, 'w:cellDel');
    cellDel.setAttributeNS(wNs, 'w:id', '2');
    cellDel.setAttributeNS(wNs, 'w:author', 'Kişi Adı');
    ensureWordChild(lastDataCell, 'w:tcPr').appendChild(cellDel);
  })), /izin verilmeyen öğe w:cellDel/);

  // İçerik düzenlemeyi engelleyen denetim kilidi (sdtContentLocked) reddedilmeli, kilitsiz denetim kabul edilmelidir
  const wrapPlaceholderInSdt = (doc, lockVal) => {
    const wNs = doc.documentElement.namespaceURI;
    const node = all(doc, 'w:t').find((t) => t.textContent.includes('{{YONETICI_DEGERLENDIRMESI}}'));
    assert.ok(node);
    const run = node.parentNode;
    const paragraph = run.parentNode;
    const sdt = doc.createElementNS(wNs, 'w:sdt');
    const sdtPr = doc.createElementNS(wNs, 'w:sdtPr');
    if (lockVal !== null) {
      const lock = doc.createElementNS(wNs, 'w:lock');
      lock.setAttributeNS(wNs, 'w:val', lockVal);
      sdtPr.appendChild(lock);
    }
    const sdtContent = doc.createElementNS(wNs, 'w:sdtContent');
    paragraph.insertBefore(sdt, run);
    sdtContent.appendChild(run);
    sdt.appendChild(sdtPr);
    sdt.appendChild(sdtContent);
  };
  assert.throws(() => validateDocxXml(mutateXmlPart('word/document.xml', (doc) => {
    wrapPlaceholderInSdt(doc, 'sdtContentLocked');
  })), /içerik düzenlemeyi engelleyen denetim kilidi yasak/);
  validateDocxXml(mutateXmlPart('word/document.xml', (doc) => {
    wrapPlaceholderInSdt(doc, 'unlocked');
  }));

  // Pakette ilan edilmemiş veri parçası (customXml/item1.xml) bulunduğunda
  const withExtraPart = { ...docx, names: [...docx.names, 'customXml/item1.xml'] };
  assert.throws(() => checkPackageParts(withExtraPart), /ilan edilmemiş veya eksik parça/);
});

test('şablon: bölüm, sayfalama, ayar, renk, yazı boyutu, tablo, kapak, numara ve üstveri bozulmaları yakalanır', async () => {
  const body = () => parseDocxXml(docx.text('word/document.xml'), 'word/document.xml');
  const wNs = xml('word/document.xml').documentElement.namespaceURI;
  const { expectedPaths, expectedBg } = await loadAuthorizedCoverExpectations();

  {
    const columns = body();
    const section = checkSectionLayout(columns);
    const cols = child(section, 'w:cols') ?? section.appendChild(columns.createElementNS(section.namespaceURI, 'w:cols'));
    cols.setAttributeNS(section.namespaceURI, 'w:num', '2');
    assert.throws(() => checkSectionLayout(columns), /bölüm tek sütunlu olmalıdır/);
    cols.remove();
    checkSectionLayout(columns);

    const styledBody = body();
    const bodyParagraph = all(styledBody, 'w:p').find((paragraph) => paragraphStyle(paragraph) === 'BilginGovde');
    assert.ok(bodyParagraph);
    const bodyRun = all(bodyParagraph, 'w:r').find((run) => child(run, 'w:t'));
    assert.ok(bodyRun);
    const runProperties = ensureWordChild(bodyRun, 'w:rPr');
    const fonts = ensureWordChild(runProperties, 'w:rFonts');
    fonts.setAttributeNS(fonts.namespaceURI, 'w:asciiTheme', 'majorHAnsi');
    assert.throws(() => checkDirectBodyFonts(styledBody, 'word/document.xml'), /gövde tema yazı tipi çelişiyor/);
    fonts.setAttributeNS(fonts.namespaceURI, 'w:asciiTheme', 'minorHAnsi');
    checkDirectBodyFonts(styledBody, 'word/document.xml');
    const shading = ensureWordChild(runProperties, 'w:shd');
    shading.setAttributeNS(shading.namespaceURI, 'w:fill', paletteColor(spec.stiller.BilginGovde.renk));
    assert.throws(() => checkPalette(styledBody, 'word/document.xml'), /doğrudan metin rengi/);
    shading.remove();
    checkPalette(styledBody, 'word/document.xml');
    const spacing = ensureWordChild(child(bodyParagraph, 'w:pPr'), 'w:contextualSpacing');
    spacing.setAttributeNS(spacing.namespaceURI, 'w:val', '1');
    assert.throws(() => checkDirectParagraphSpacing(styledBody, 'word/document.xml'), /bağlamsal aralık kapalı/);
    spacing.setAttributeNS(spacing.namespaceURI, 'w:val', '0');
    checkDirectParagraphSpacing(styledBody, 'word/document.xml');

    const wrongBorders = parseDocxXml(docx.text(part('styles')), part('styles'));
    const tableStyle = all(wrongBorders, 'w:style').find((node) => attr(node, 'w:styleId') === 'BilginTablo');
    child(child(child(tableStyle, 'w:tblPr'), 'w:tblBorders'), 'w:top').remove();
    assert.throws(() => checkStyles(wrongBorders), /kurumsal tablo kenarlıkları/);
  }

  // Bölüm sırası bozulduğunda
  const wrongSection = body();
  const heading = all(wrongSection, 'w:p').find((p) => paragraphStyle(p) === 'Heading1' && paragraphText(p) === spec.yapi.bolumler[2].baslik);
  const callout = [...heading.parentElement.children].find((node) => placeholders(node, 'word/document.xml').includes('ONE_CIKAN_TESPIT'));
  assert.ok(callout);
  heading.parentNode.insertBefore(heading, callout);
  assert.throws(() => checkSectionPlaceholders(wrongSection), /yonetici_degerlendirmesi: bölüm yer tutucuları/);

  // Son w:sectPr, w:body sonundan kapak paragrafının w:pPr altına taşındığında
  const movedSect = body();
  const sectEl = all(movedSect, 'w:sectPr')[0];
  const firstPPr = child(all(movedSect, 'w:body')[0].firstElementChild, 'w:pPr');
  firstPPr.appendChild(sectEl);
  assert.throws(() => checkSectionLayout(movedSect), /w:body sonunda doğrudan çocuk olmalıdır/);

  // Sıfırdan büyük w:gutter (cilt payı) etkin kenar boşluklarını daralttığında reddedilir
  const withGutter = body();
  const gutterSect = all(withGutter, 'w:sectPr')[0];
  child(gutterSect, 'w:pgMar').setAttributeNS(wNs, 'w:gutter', '720');
  assert.throws(() => checkPageMargins(gutterSect), /cilt payı \(w:gutter\) sıfır olmalıdır/);

  // Gövde içine doğrudan <w:br w:type="page"/> eklendiğinde
  const withPageBreak = body();
  const firstHeading = all(withPageBreak, 'w:p').find((p) => paragraphStyle(p) === 'Heading1');
  const brRun = withPageBreak.createElementNS(wNs, 'w:r');
  const br = withPageBreak.createElementNS(wNs, 'w:br');
  br.setAttributeNS(wNs, 'w:type', 'page');
  brRun.appendChild(br);
  firstHeading.appendChild(brRun);
  assert.throws(() => checkSectionPlaceholders(withPageBreak), /doğrudan sayfa veya sütun kırılması yasak/);

  // Üst bilgi eksik olduğunda ve ilk sayfa üst bilgisine metinsiz çizim eklendiğinde
  const wrongHeader = body();
  const section = all(wrongHeader, 'w:sectPr')[0];
  children(section, 'w:headerReference').find((node) => attr(node, 'w:type') === 'default').remove();
  assert.throws(() => checkHeaderFooter(xml, documentRelationship, section), /kapak ve gövde başvuruları/);

  const pictHeader = parseDocxXml(docx.text('word/header2.xml'), 'word/header2.xml');
  const pictRun = pictHeader.createElementNS(wNs, 'w:r');
  pictRun.appendChild(pictHeader.createElementNS(wNs, 'w:pict'));
  all(pictHeader, 'w:p')[0].appendChild(pictRun);
  assert.throws(() => checkHeaderFooter(
    (name) => name === 'word/header2.xml' ? pictHeader : xml(name),
    documentRelationship,
    all(body(), 'w:sectPr')[0],
    xml(part('settings'))
  ), /kapak üst\/alt bilgisinde görünür içerik yasak/);

  // Belge düzenleme koruması ve çift sayfa üst/alt bilgi kipi reddedilir
  const protectedSettings = parseDocxXml(docx.text('word/settings.xml'), 'word/settings.xml');
  const prot = protectedSettings.createElementNS(wNs, 'w:documentProtection');
  prot.setAttributeNS(wNs, 'w:edit', 'readOnly');
  prot.setAttributeNS(wNs, 'w:enforcement', '1');
  protectedSettings.documentElement.appendChild(prot);
  assert.throws(() => checkDocumentSettings(protectedSettings), /düzenleme koruması yasak/);

  const oddEvenSettings = parseDocxXml(docx.text('word/settings.xml'), 'word/settings.xml');
  oddEvenSettings.documentElement.appendChild(oddEvenSettings.createElementNS(wNs, 'w:evenAndOddHeaders'));
  assert.throws(() => checkDocumentSettings(oddEvenSettings), /çift sayfa üst\/alt bilgi kipi kapalı olmalıdır/);

  // Satır aralığı kuralı exact yapıldığında, doğrudan çelişen paragraf aralığı eklendiğinde ve yinelenen w:styleId bulunduğunda reddedilir
  const wrongLineRule = parseDocxXml(docx.text('word/styles.xml'), 'word/styles.xml');
  const govdeStyle = all(wrongLineRule, 'w:style').find((node) => attr(node, 'w:styleId') === 'BilginGovde');
  child(child(govdeStyle, 'w:pPr'), 'w:spacing').setAttributeNS(wNs, 'w:lineRule', 'exact');
  assert.throws(() => checkStyles(wrongLineRule), /satır aralığı kuralı auto olmalıdır/);

  const ensureDirectSpacing = (doc, paragraph) => {
    let pPr = child(paragraph, 'w:pPr');
    if (!pPr) {
      pPr = doc.createElementNS(wNs, 'w:pPr');
      paragraph.insertBefore(pPr, paragraph.firstChild);
    }
    let spacing = child(pPr, 'w:spacing');
    if (!spacing) {
      spacing = doc.createElementNS(wNs, 'w:spacing');
      pPr.appendChild(spacing);
    }
    return spacing;
  };
  const conflictingSpacing = body();
  const govdeParagraph = all(conflictingSpacing, 'w:p').find((p) => paragraphStyle(p) === 'BilginGovde');
  const directSpacing = ensureDirectSpacing(conflictingSpacing, govdeParagraph);
  directSpacing.setAttributeNS(wNs, 'w:line', '20');
  directSpacing.setAttributeNS(wNs, 'w:lineRule', 'exact');
  assert.throws(() => checkDirectParagraphSpacing(conflictingSpacing, 'word/document.xml'), /BilginGovde doğrudan w:line çelişiyor/);

  const beforeLinesSpacing = body();
  const govdeLinesPara = all(beforeLinesSpacing, 'w:p').find((p) => paragraphStyle(p) === 'BilginGovde');
  const linesSpacingEl = ensureDirectSpacing(beforeLinesSpacing, govdeLinesPara);
  linesSpacingEl.setAttributeNS(wNs, 'w:beforeLines', '300');
  assert.throws(() => checkDirectParagraphSpacing(beforeLinesSpacing, 'word/document.xml'), /BilginGovde doğrudan w:beforeLines/);

  const matchingSpacing = body();
  const govdeMatchParagraph = all(matchingSpacing, 'w:p').find((p) => paragraphStyle(p) === 'BilginGovde');
  const validDirectSpacing = ensureDirectSpacing(matchingSpacing, govdeMatchParagraph);
  validDirectSpacing.setAttributeNS(wNs, 'w:line', '276');
  validDirectSpacing.setAttributeNS(wNs, 'w:lineRule', 'auto');
  checkDirectParagraphSpacing(matchingSpacing, 'word/document.xml');

  const wrongHAnsiTheme = parseDocxXml(docx.text('word/styles.xml'), 'word/styles.xml');
  const govdeThemeStyle = all(wrongHAnsiTheme, 'w:style').find((node) => attr(node, 'w:styleId') === 'BilginGovde');
  child(child(govdeThemeStyle, 'w:rPr'), 'w:rFonts').setAttributeNS(wNs, 'w:hAnsiTheme', 'majorHAnsi');
  assert.throws(() => checkStyles(wrongHAnsiTheme), /yazı rolü \(hAnsiTheme\)/);

  const zeroNumStyles = parseDocxXml(docx.text('word/styles.xml'), 'word/styles.xml');
  const zeroNumNumbering = parseDocxXml(docx.text('word/numbering.xml'), 'word/numbering.xml');
  const h1NumStyle = all(zeroNumStyles, 'w:style').find((node) => attr(node, 'w:styleId') === 'Heading1');
  const h1NumId = child(child(child(h1NumStyle, 'w:pPr'), 'w:numPr'), 'w:numId');
  const origNumId = attr(h1NumId);
  h1NumId.setAttributeNS(wNs, 'w:val', '0');
  all(zeroNumNumbering, 'w:num').find((node) => attr(node, 'w:numId') === origNumId).setAttributeNS(wNs, 'w:numId', '0');
  assert.throws(() => checkNumbering(zeroNumNumbering, zeroNumStyles, body()), /numara kimliği pozitif tamsayı olmalıdır/);

  const dupStyle = parseDocxXml(docx.text('word/styles.xml'), 'word/styles.xml');
  const headingStyle = all(dupStyle, 'w:style').find((node) => attr(node, 'w:styleId') === 'Heading1');
  const fakeHeading = headingStyle.cloneNode(true);
  child(child(fakeHeading, 'w:rPr'), 'w:sz').setAttributeNS(wNs, 'w:val', '2');
  headingStyle.parentNode.insertBefore(fakeHeading, headingStyle);
  assert.throws(() => checkStyles(dupStyle), /yinelenen veya boş Word stil kimliği/);

  // Gövde run'ına doğrudan <w:sz w:val="2"/> eklendiğinde reddedilir
  const wrongSize = body();
  const targetText = all(wrongSize, 'w:t').find((t) => t.textContent.includes('{{YONETICI_DEGERLENDIRMESI}}'));
  const szRPr = wrongSize.createElementNS(wNs, 'w:rPr');
  const szEl = wrongSize.createElementNS(wNs, 'w:sz');
  szEl.setAttributeNS(wNs, 'w:val', '2');
  szRPr.appendChild(szEl);
  targetText.parentNode.insertBefore(szRPr, targetText.parentNode.firstChild);
  assert.throws(() => checkDirectFontSizes(wrongSize, 'word/document.xml'), /doğrudan yazı boyutu geçersiz kılması yasak/);

  // Kapak künyesinde Hazırlayan ve Veri Anı etiketleri yer değiştirdiğinde reddedilir (bölünmüş Word run'larını desteklemek için hücre metnine göre seçilir)
  const swappedCoverLabels = body();
  const replaceCellText = (cell, text) => {
    const texts = all(cell, 'w:t');
    assert.ok(texts.length > 0);
    texts[0].textContent = text;
    for (let i = 1; i < texts.length; i += 1) texts[i].textContent = '';
  };
  const coverCells = all(swappedCoverLabels, 'w:tc');
  const hazirlayanCell = coverCells.find((cell) => paragraphText(cell) === 'Hazırlayan');
  const veriAniCell = coverCells.find((cell) => paragraphText(cell) === 'Veri Anı');
  assert.ok(hazirlayanCell && veriAniCell);
  replaceCellText(hazirlayanCell, 'Veri Anı');
  replaceCellText(veriAniCell, 'Hazırlayan');
  assert.throws(() => checkCoverMetadata(swappedCoverLabels), /kapak künye etiket ve değer eşleşmesi bozulmuş/);

  // Kapak SVG ilişkisi eksik olduğunda veya kapak çizimi 1×1 EMU boyutuna küçültüldüüğünde reddedilir
  const wrongCover = body();
  all(wrongCover, 'asvg:svgBlip')[0].remove();
  assert.throws(() => checkCoverRelationships(wrongCover, documentRelationship), /kapak SVG başvurusu/);

  const tinyWpExtent = body();
  const wpExtentEl = child(all(tinyWpExtent, 'wp:anchor')[0], 'wp:extent');
  wpExtentEl.setAttribute('cx', '1');
  wpExtentEl.setAttribute('cy', '1');
  assert.throws(() => checkCoverRelationships(tinyWpExtent, documentRelationship), /wp:extent genişliği A4 ile eşleşmelidir/);

  const tinyPicExt = body();
  const picExtEl = child(child(all(tinyPicExt, 'pic:spPr')[0], 'a:xfrm'), 'a:ext');
  picExtEl.setAttribute('cx', '1');
  picExtEl.setAttribute('cy', '1');
  assert.throws(() => checkCoverRelationships(tinyPicExt, documentRelationship), /pic:spPr\/a:xfrm\/a:ext genişliği A4 ile eşleşmelidir/);

  // Kapak çizimi sayfa başlangıcından sağa kaydırıldığında reddedilmelidir
  const offsetCover = body();
  const posOffsetH = child(child(all(offsetCover, 'wp:anchor')[0], 'wp:positionH'), 'wp:posOffset');
  posOffsetH.textContent = '3600000';
  assert.throws(() => checkCoverRelationships(offsetCover, documentRelationship), /kapak yatay konumu sayfa başlangıcında/);

  // Sağlam kapak SVG yetkili beklentilerle geçmeli; yollar yorumlandığında, boyut sıfırlandığında, hex viewBox veya katman sırası/dolgu/kalınlık bozulduğunda reddedilmelidir
  const intactSvg = parseDocxXml(docx.text('word/media/kapak-yedigen.svg'), 'word/media/kapak-yedigen.svg');
  checkCoverSvg(intactSvg, expectedPaths, expectedBg);

  const hexViewBoxSvg = parseDocxXml(docx.text('word/media/kapak-yedigen.svg'), 'word/media/kapak-yedigen.svg');
  hexViewBoxSvg.documentElement.setAttribute('viewBox', '0 0 0xD2 297');
  assert.throws(() => checkCoverSvg(hexViewBoxSvg, expectedPaths, expectedBg),
    /kapak SVG viewBox değerleri geçerli SVG sayı sözdiziminde olmalıdır/);

  const commentedSvgDom = parseDocxXml(docx.text('word/media/kapak-yedigen.svg'), 'word/media/kapak-yedigen.svg');
  const svgGroupNode = all(commentedSvgDom, 'svg:g')[0];
  svgGroupNode.parentNode.replaceChild(commentedSvgDom.createComment(serializeDocxXml(svgGroupNode)), svgGroupNode);
  assert.throws(() => parseDocxXml(serializeDocxXml(commentedSvgDom), 'word/media/kapak-yedigen.svg'),
    /gizli XML yorumu yasak/);
  const missingGroupSvg = parseDocxXml(docx.text('word/media/kapak-yedigen.svg'), 'word/media/kapak-yedigen.svg');
  all(missingGroupSvg, 'svg:g')[0].remove();
  assert.throws(() => checkCoverSvg(missingGroupSvg, expectedPaths, expectedBg),
    /kapak SVG kökünde yalnızca zemin dikdörtgeni ve yedigen grubu bulunmalıdır/);

  const zeroRootWidthSvg = parseDocxXml(docx.text('word/media/kapak-yedigen.svg'), 'word/media/kapak-yedigen.svg');
  zeroRootWidthSvg.documentElement.setAttribute('width', '0');
  assert.throws(() => checkCoverSvg(zeroRootWidthSvg, expectedPaths, expectedBg),
    /kapak SVG kök genişliği 210mm olmalıdır/);

  const reorderedBgSvg = parseDocxXml(docx.text('word/media/kapak-yedigen.svg'), 'word/media/kapak-yedigen.svg');
  reorderedBgSvg.documentElement.appendChild(all(reorderedBgSvg, 'svg:rect')[0]);
  assert.throws(() => checkCoverSvg(reorderedBgSvg, expectedPaths, expectedBg),
    /zemin dikdörtgeni yedigen grubundan önce gelmelidir/);

  const filledGroupSvg = parseDocxXml(docx.text('word/media/kapak-yedigen.svg'), 'word/media/kapak-yedigen.svg');
  all(filledGroupSvg, 'svg:g')[0].setAttribute('fill', '#FF5620');
  assert.throws(() => checkCoverSvg(filledGroupSvg, expectedPaths, expectedBg),
    /yedigen grubu dolgusuz \(fill="none"\) olmalıdır/);

  const thickStrokeSvg = parseDocxXml(docx.text('word/media/kapak-yedigen.svg'), 'word/media/kapak-yedigen.svg');
  all(thickStrokeSvg, 'svg:path')[0].setAttribute('stroke-width', '500');
  assert.throws(() => checkCoverSvg(thickStrokeSvg, expectedPaths, expectedBg),
    /SVG yol çizgi kalınlığı onaylı değerle eşleşmelidir/);

  const shiftedSvg = parseDocxXml(docx.text('word/media/kapak-yedigen.svg'), 'word/media/kapak-yedigen.svg');
  all(shiftedSvg, 'svg:g')[0].setAttribute('transform', 'matrix(0.62,0,0,0.62,500,500)');
  assert.throws(() => checkCoverSvg(shiftedSvg, expectedPaths, expectedBg),
    /kapak SVG yedigen yerleşimi onaylı konumdan sapamaz/);

  const zeroWidthBgSvg = parseDocxXml(docx.text('word/media/kapak-yedigen.svg'), 'word/media/kapak-yedigen.svg');
  all(zeroWidthBgSvg, 'svg:rect')[0].setAttribute('width', '0');
  assert.throws(() => checkCoverSvg(zeroWidthBgSvg, expectedPaths, expectedBg),
    /zemin dikdörtgeni onaylı A4 görünüm alanını tam kaplamalıdır/);

  const offsetBgSvg = parseDocxXml(docx.text('word/media/kapak-yedigen.svg'), 'word/media/kapak-yedigen.svg');
  all(offsetBgSvg, 'svg:rect')[0].setAttribute('x', '50');
  assert.throws(() => checkCoverSvg(offsetBgSvg, expectedPaths, expectedBg),
    /zemin dikdörtgeni onaylı A4 görünüm alanını tam kaplamalıdır/);

  // Stil pageBreakBefore aç/kapa ve palet kontrolleri (tema rengi + DrawingML dönüşümü dâhil)
  const styles = parseDocxXml(docx.text('word/styles.xml'), 'word/styles.xml');
  const appendix = all(styles, 'w:style').find((node) => attr(node, 'w:styleId') === 'BilginEkBasligi');
  const pageBreak = child(child(appendix, 'w:pPr'), 'w:pageBreakBefore');
  assert.equal(on(pageBreak), true);
  pageBreak.setAttributeNS(pageBreak.namespaceURI, 'w:val', '0');
  assert.equal(on(pageBreak), false);

  const wrongColor = body();
  const color = all(wrongColor, 'w:color')[0];
  color.setAttributeNS(color.namespaceURI, 'w:val', '123456');
  assert.throws(() => checkPalette(wrongColor, 'word/document.xml'), /izinli olmayan renk 123456/);

  const themeOverride = parseDocxXml(docx.text('word/styles.xml'), 'word/styles.xml');
  const bodyColor = all(themeOverride, 'w:color')[0];
  bodyColor.setAttributeNS(wNs, 'w:themeColor', 'accent2');
  assert.throws(() => checkPalette(themeOverride, 'word/styles.xml'), /tema renk geçersiz kılması yasak/);

  const drawingShade = parseDocxXml(docx.text('word/theme/theme1.xml'), 'word/theme/theme1.xml');
  const srgb = all(drawingShade, 'a:srgbClr')[0];
  const shade = drawingShade.createElementNS(srgb.namespaceURI, 'a:shade');
  shade.setAttribute('val', '0');
  srgb.appendChild(shade);
  assert.throws(() => checkPalette(drawingShade, 'word/theme/theme1.xml'), /DrawingML renk dönüşümü yasak/);

  // Özet tablo w:tblLook kapatıldığında, hücre sütun genişlemesi/kayması, dikey birleştirme veya yer tutucu kayması olduğunda reddedilir
  const wrongTblLook = body();
  const summaryTbl = all(wrongTblLook, 'w:tbl').find((t) => attr(child(child(t, 'w:tblPr'), 'w:tblStyle')) === spec.tablolar.donem_gorev_ozeti.stil);
  const look = child(child(summaryTbl, 'w:tblPr'), 'w:tblLook');
  look.setAttributeNS(wNs, 'w:firstRow', '0');
  assert.throws(() => checkSummaryTable(wrongTblLook), /ilk satır koşullu biçimi etkin olmalıdır/);

  const wrongTblCell = body();
  const cellSummary = all(wrongTblCell, 'w:tbl').find((t) => attr(child(child(t, 'w:tblPr'), 'w:tblStyle')) === spec.tablolar.donem_gorev_ozeti.stil);
  const dataCells = children(children(cellSummary, 'w:tr')[1], 'w:tc');
  all(dataCells[0], 'w:t')[0].textContent = '{{SATIR_PROJE}}{{SATIR_TAM}}';
  all(dataCells[1], 'w:t')[0].textContent = '';
  assert.throws(() => checkSummaryTable(wrongTblCell), /veri satırı yer tutucuları ilgili sütun hücrelerinde olmalıdır/);

  const spannedTbl = body();
  const spannedSummary = all(spannedTbl, 'w:tbl').find((t) => attr(child(child(t, 'w:tblPr'), 'w:tblStyle')) === spec.tablolar.donem_gorev_ozeti.stil);
  const spanCell = children(children(spannedSummary, 'w:tr')[1], 'w:tc')[0];
  let spanTcPr = child(spanCell, 'w:tcPr');
  if (!spanTcPr) {
    spanTcPr = spannedTbl.createElementNS(wNs, 'w:tcPr');
    spanCell.insertBefore(spanTcPr, spanCell.firstChild);
  }
  let gridSpan = child(spanTcPr, 'w:gridSpan');
  if (!gridSpan) {
    gridSpan = spannedTbl.createElementNS(wNs, 'w:gridSpan');
    spanTcPr.appendChild(gridSpan);
  }
  gridSpan.setAttributeNS(wNs, 'w:val', '2');
  assert.throws(() => checkSummaryTable(spannedTbl), /birden fazla sütuna yayılamaz/);

  const vMergedTbl = body();
  const vMergedSummary = all(vMergedTbl, 'w:tbl').find((t) => attr(child(child(t, 'w:tblPr'), 'w:tblStyle')) === spec.tablolar.donem_gorev_ozeti.stil);
  const vMergeStart = vMergedTbl.createElementNS(wNs, 'w:vMerge');
  vMergeStart.setAttributeNS(wNs, 'w:val', 'restart');
  ensureWordChild(children(children(vMergedSummary, 'w:tr')[1], 'w:tc')[1], 'w:tcPr').appendChild(vMergeStart);
  ensureWordChild(children(children(vMergedSummary, 'w:tr')[2], 'w:tc')[1], 'w:tcPr').appendChild(vMergedTbl.createElementNS(wNs, 'w:vMerge'));
  assert.throws(() => checkSummaryTable(vMergedTbl), /dikey birleştirme \(w:vMerge\) yasak/);

  const shiftedTbl = body();
  const shiftedSummary = all(shiftedTbl, 'w:tbl').find((t) => attr(child(child(t, 'w:tblPr'), 'w:tblStyle')) === spec.tablolar.donem_gorev_ozeti.stil);
  const shiftedRow = children(shiftedSummary, 'w:tr')[1];
  const rowProperties = ensureWordChild(shiftedRow, 'w:trPr');
  const gridBefore = child(rowProperties, 'w:gridBefore') ?? rowProperties.appendChild(shiftedTbl.createElementNS(wNs, 'w:gridBefore'));
  gridBefore.setAttributeNS(wNs, 'w:val', '1');
  assert.throws(() => checkSummaryTable(shiftedTbl), /ilk ızgara sütunundan başlamalıdır/);

  const explicitSingleSpan = body();
  const singleSpanSummary = all(explicitSingleSpan, 'w:tbl').find((t) => attr(child(child(t, 'w:tblPr'), 'w:tblStyle')) === spec.tablolar.donem_gorev_ozeti.stil);
  const singleSpan = explicitSingleSpan.createElementNS(wNs, 'w:gridSpan');
  singleSpan.setAttributeNS(wNs, 'w:val', '1');
  ensureWordChild(children(children(singleSpanSummary, 'w:tr')[1], 'w:tc')[0], 'w:tcPr').appendChild(singleSpan);
  checkSummaryTable(explicitSingleSpan);

  for (const [tag, attribute, value, reason] of [
    ['wp:docPr', 'hidden', '1', /kapak çizimi gizlenemez/],
    ['wp:docPr', 'name', 'Özel Kurum', /adı onaylı sabit ad/],
    ['a:fillRect', 'r', '50000', /hedef dikdörtgeni boşluksuz/]
  ]) {
    const modifiedCover = body();
    const property = all(modifiedCover, tag)[0];
    assert.ok(property, 'kapak mutasyonu hedefi bulunmalıdır: ' + tag);
    property.setAttribute(attribute, value);
    assert.throws(() => checkCoverRelationships(modifiedCover, documentRelationship), reason);
  }
  const coverSvg = parseDocxXml(docx.text('word/media/kapak-yedigen.svg'), 'word/media/kapak-yedigen.svg');
  const coverGroup = all(coverSvg, 'svg:g')[0];
  const originalMatrix = coverGroup.getAttribute('transform');
  const hexadecimalMatrix = originalMatrix.replace(/(?<=[,\s])0(?=[,\s])/u, '0x0');
  assert.notEqual(hexadecimalMatrix, originalMatrix);
  coverGroup.setAttribute('transform', hexadecimalMatrix);
  assert.throws(() => checkCoverSvg(coverSvg, expectedPaths, expectedBg), /geçerli ondalık sayılar/);

  // Numaralandırma ve belge üstverileri (core, app, custom) bozulmaları (DOM üzerinden serileştirmeden bağımsız)
  const numberingDoc = parseDocxXml(docx.text('word/numbering.xml'), 'word/numbering.xml');
  const lvlText = child(numberingLevel(numberingDoc, styles, 'Heading1'), 'w:lvlText');
  assert.ok(lvlText);
  lvlText.setAttributeNS(lvlText.namespaceURI, 'w:val', '%1.');
  assert.throws(() => checkNumbering(numberingDoc, styles, body()), /başlık numarası biçimi/);

  const extraCore = parseDocxXml(docx.text('docProps/core.xml'), 'docProps/core.xml');
  const subject = extraCore.createElementNS('http://purl.org/dc/elements/1.1/', 'dc:subject');
  subject.textContent = 'Gizli Proje';
  extraCore.documentElement.appendChild(subject);
  assert.throws(() => checkCoreProperties(extraCore), /izinli olmayan çekirdek özellik/);

  const extraApp = parseDocxXml(docx.text('docProps/app.xml'), 'docProps/app.xml');
  const company = extraApp.createElementNS(extraApp.documentElement.namespaceURI, 'Company');
  company.textContent = 'Örnek Kurum';
  extraApp.documentElement.appendChild(company);
  assert.throws(() => checkExtendedProperties(extraApp), /izinli genişletilmiş özellikler/);

  const dupCustom = parseDocxXml(docx.text('docProps/custom.xml'), 'docProps/custom.xml');
  const clone = dupCustom.documentElement.lastElementChild.cloneNode(true);
  clone.setAttribute('pid', '99');
  dupCustom.documentElement.insertBefore(clone, dupCustom.documentElement.firstElementChild);
  assert.throws(() => checkCustomProperties(dupCustom), /özel özellik adı tekil olmalıdır/);

  const protoCustom = parseDocxXml(docx.text('docProps/custom.xml'), 'docProps/custom.xml');
  const protoProp = protoCustom.documentElement.lastElementChild.cloneNode(true);
  protoProp.setAttribute('pid', '98');
  protoProp.setAttribute('name', '__proto__');
  protoProp.firstElementChild.textContent = 'Gizli Kurum';
  protoCustom.documentElement.appendChild(protoProp);
  assert.throws(() => checkCustomProperties(protoCustom), /izinli olmayan özel özellik adı: __proto__/);

  const missingFmtidCustom = parseDocxXml(docx.text('docProps/custom.xml'), 'docProps/custom.xml');
  missingFmtidCustom.documentElement.lastElementChild.removeAttribute('fmtid');
  assert.throws(() => checkCustomProperties(missingFmtidCustom), /fmtid değeri zorunlu şema kimliğiyle eşleşmelidir/);

  const nonNumericPid = parseDocxXml(docx.text('docProps/custom.xml'), 'docProps/custom.xml');
  nonNumericPid.documentElement.lastElementChild.setAttribute('pid', 'abc');
  assert.throws(() => checkCustomProperties(nonNumericPid), /pid değeri geçerli tamsayı olmalıdır/);

  const reservedPid = parseDocxXml(docx.text('docProps/custom.xml'), 'docProps/custom.xml');
  reservedPid.documentElement.lastElementChild.setAttribute('pid', '1');
  assert.throws(() => checkCustomProperties(reservedPid), /pid değeri geçerli aralıkta/);

  const badRootCustom = parseDocxXml(
    '<GecersizKok xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"/>',
    'docProps/custom.xml'
  );
  assert.throws(() => checkCustomProperties(badRootCustom), /özel belge özellikleri kökü geçersiz/);
});

function buildPngChunk(type, data) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])), 0);
  return Buffer.concat([header, data, crc]);
}

/** Verilen PNG tamponundan belirtilen türdeki yardımcı parçaları ayıklar (yinelenen parça üretmeden sınama kurmak için). */
function stripPngChunks(png, excludedType) {
  const parts = [png.subarray(0, 8)];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    const type = png.toString('latin1', offset + 4, offset + 8);
    if (type !== excludedType) parts.push(png.subarray(offset, chunkEnd));
    offset = chunkEnd;
  }
  return Buffer.concat(parts);
}

function buildSolidA4Png(r, g, b, alpha = null) {
  const width = 210;
  const height = 297;
  const bpp = alpha === null ? 3 : 4;
  const raw = Buffer.alloc(height * (1 + width * bpp));
  for (let y = 0; y < height; y += 1) {
    const start = y * (1 + width * bpp);
    raw[start] = 0;
    for (let x = 0; x < width; x += 1) {
      raw[start + 1 + x * bpp] = r;
      raw[start + 1 + x * bpp + 1] = g;
      raw[start + 1 + x * bpp + 2] = b;
      if (alpha !== null) raw[start + 1 + x * bpp + 3] = alpha;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha === null ? 2 : 6;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    buildPngChunk('IHDR', ihdr),
    buildPngChunk('IDAT', deflateSync(raw)),
    buildPngChunk('IEND', Buffer.alloc(0))
  ]);
}

test('şablon: PNG kapağın görüntü verisi, parça bütünlüğü ve onaylı kapak içeriği zorunludur', () => {
  const png = docx.buffer('word/media/kapak-yedigen.png');
  assert.throws(() => validateCoverPng(png.subarray(0, 24)), /PNG parça aralığı/);
  assert.throws(() => validateCoverPng(png.subarray(0, -12)), /PNG görüntü verisi veya bitişi eksik/);
  const damaged = Buffer.from(png);
  damaged[42] ^= 1;
  assert.throws(() => validateCoverPng(damaged), /PNG parça sağlama toplamı/);
  // IDAT öncesinde tekil ve geçerli (birim 0 veya 1) pHYs kabul edilmeli; yineleme, geçersiz birim, uzunluk veya IDAT sonrası reddedilmelidir.
  const basePng = stripPngChunks(png, 'pHYs');
  const ihdrEnd = 8 + 12 + basePng.readUInt32BE(8);
  const makePhys = (unit, density = 5906) => {
    const data = Buffer.alloc(9);
    data.writeUInt32BE(density, 0);
    data.writeUInt32BE(density, 4);
    data[8] = unit;
    return buildPngChunk('pHYs', data);
  };
  const validPhys = makePhys(1);
  validateCoverPng(Buffer.concat([basePng.subarray(0, ihdrEnd), validPhys, basePng.subarray(ihdrEnd)]));
  validateCoverPng(Buffer.concat([basePng.subarray(0, ihdrEnd), makePhys(0), basePng.subarray(ihdrEnd)]));
  const excessiveDensity = Buffer.concat([basePng.subarray(0, ihdrEnd), makePhys(1, 0x80000000), basePng.subarray(ihdrEnd)]);
  assert.throws(() => validateCoverPng(excessiveDensity), /yoğunluğu 31 bit sınırını aşamaz/);
  const withDuplicatePhys = Buffer.concat([basePng.subarray(0, ihdrEnd), validPhys, validPhys, basePng.subarray(ihdrEnd)]);
  assert.throws(() => validateCoverPng(withDuplicatePhys), /PNG yardımcı parçası yinelenemez: pHYs/);
  const withBadUnitPhys = Buffer.concat([basePng.subarray(0, ihdrEnd), makePhys(2), basePng.subarray(ihdrEnd)]);
  assert.throws(() => validateCoverPng(withBadUnitPhys), /PNG pHYs birim alanı geçersiz/);
  const withPostIdatPhys = Buffer.concat([basePng.subarray(0, -12), validPhys, basePng.subarray(-12)]);
  assert.throws(() => validateCoverPng(withPostIdatPhys), /PNG parça sırası veya türü geçersiz/);
  const badLengthPhys = buildPngChunk('pHYs', Buffer.alloc(4));
  const withBadPhys = Buffer.concat([basePng.subarray(0, ihdrEnd), badLengthPhys, basePng.subarray(ihdrEnd)]);
  assert.throws(() => validateCoverPng(withBadPhys), /PNG yardımcı parça uzunluğu geçersiz/);
  // Düz beyaz, yedigensiz düz lacivert veya onaylı RGB renklerini taşısa da tamamen saydam (alpha=0) RGBA A4 PNG reddedilmelidir.
  assert.throws(() => validateCoverPng(buildSolidA4Png(255, 255, 255)), /PNG kapak zemini onaylı ana lacivert değil/);
  assert.throws(() => validateCoverPng(buildSolidA4Png(0, 48, 135)), /onaylı yedigen çizgi rengi bulunamadı/);
  const buildRgbaCoverPng = (alpha, teal = [7, 119, 128]) => {
    const width = 210;
    const height = 297;
    const raw = Buffer.alloc(height * (1 + width * 4));
    for (let y = 0; y < height; y += 1) {
      const start = y * (1 + width * 4);
      raw[start] = 0;
      for (let x = 0; x < width; x += 1) {
        let [r, g, b] = [0, 48, 135];
        if (y === 10) [r, g, b] = teal;
        else if (y === 20) [r, g, b] = [255, 86, 32];
        raw[start + 1 + x * 4] = r;
        raw[start + 1 + x * 4 + 1] = g;
        raw[start + 1 + x * 4 + 2] = b;
        raw[start + 1 + x * 4 + 3] = alpha;
      }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      buildPngChunk('IHDR', ihdr),
      buildPngChunk('IDAT', deflateSync(raw)),
      buildPngChunk('IEND', Buffer.alloc(0))
    ]);
  };
  validateCoverPng(buildRgbaCoverPng(255));
  assert.throws(() => validateCoverPng(buildRgbaCoverPng(255, [0, 120, 33])), /onaylı yedigen çizgi rengi bulunamadı/);
  assert.throws(() => validateCoverPng(buildRgbaCoverPng(0)), /PNG kapak zemini onaylı ana lacivert değil/);
});

// ------------------------------------------------------------------ rapor model rolleri

test('model rolleri: adaylar iki kayıtta da etkin, gerekli yetenekli ve yeterli bağlamlıdır; görünmeyen model aday değildir', () => {
  const policy = spec.model_politikasi;
  for (const [source, document] of [['varsayılan', DEFAULT_AI_MODEL_REGISTRY], ['operasyonel JSON', operationalRegistry]]) {
    const validated = validateModelRegistry(document);
    assert.equal(validated.ok, true, source);
    const models = validated.registry.models;
    for (const id of [...policy.katalogda_gorulmeyen, ...policy.canli_dogrulama_bekleyen]) assert.ok(models.has(id), `${source}: ${id}`);
    for (const [role, entry] of Object.entries(policy.roller)) {
      assert.ok(entry.adaylar.length > 0, role);
      for (const id of entry.adaylar) {
        const model = models.get(id);
        assert.ok(model?.enabled, `${source}: ${role} → ${id}`);
        for (const capability of entry.gerekli_yetenekler) assert.ok(model.capabilities.includes(capability), `${role} → ${id} ${capability}`);
        assert.ok(model.contextTokens >= entry.en_az_baglam, `${role} → ${id} bağlam`);
        assert.equal(policy.katalogda_gorulmeyen.includes(id), false, `${role}: görünmeyen model aday olamaz (${id})`);
      }
    }
  }
});

function checkModelQualification(policy, measurements = []) {
  for (const [role, entry] of Object.entries(policy.roller)) {
    assert.ok(entry.nitelikli_modeller.every((id) => entry.adaylar.includes(id)), role);
    assert.ok(entry.secili == null || entry.nitelikli_modeller.includes(entry.secili), `${role}: seçili model nitelikli olmalıdır`);
    if (policy.nitelendirme.durum !== 'tamamlandi') {
      assert.deepEqual(entry.nitelikli_modeller, [], `${role}: nitelendirme tamamlanmadan nitelikli model yok`);
      assert.equal(entry.secili, null, role);
    } else {
      assert.ok(Array.isArray(measurements) && measurements.length > 0, `${role}: tamamlanan nitelendirme için ölçüm kaydı zorunludur`);
      // Yönetici listesi rol ölçümlerinden türetilir ve aşağıda iki yazar rolüyle mutabık tutulur.
      if (role === 'rapor_yazari_kullanici_secimi') continue;
      for (const id of entry.nitelikli_modeller) {
        const record = measurements.find((item) => item?.rol === role && item?.model === id && item?.sonuc === 'gecer');
        assert.ok(record, `${role}: ${id} için geçen ölçüm kaydı zorunludur`);
      }
    }
  }
  const writerRoles = ['rapor_yazari_otomatik', 'rapor_yazari_yuksek_kalite'];
  const manual = policy.roller.rapor_yazari_kullanici_secimi;
  assert.equal(manual.secili, null, 'yönetici seçimi rapor bazındadır');
  if (policy.nitelendirme.durum === 'tamamlandi') {
    const autoWriter = policy.roller.rapor_yazari_otomatik.secili;
    assert.ok(typeof autoWriter === 'string' && autoWriter.length > 0,
      'tamamlanan nitelendirmede rapor_yazari_otomatik rolü seçili olmalıdır');
    const writerModels = new Set(writerRoles.flatMap((role) => policy.roller[role].nitelikli_modeller));
    assert.deepEqual(new Set(manual.nitelikli_modeller), writerModels, 'yöneticiye yalnızca nitelikli yazarlar sunulur');
  }
  const reviewer = policy.roller.bagimsiz_denetci.secili;
  for (const role of writerRoles) {
    const writer = policy.roller[role].secili;
    if (writer && reviewer) assert.notEqual(writer, reviewer, role + ': denetçi yazardan farklıdır');
  }
  assert.equal(policy.nitelendirme.kiyas, 'test/fixtures/bilgin-executive-report-benchmark.json');
}

test('model rolleri: ölçüm olmadan hiçbir model nitelikli ya da seçili ilan edilmez; denetçi yazardan bağımsızdır', async () => {
  const benchmark = JSON.parse(await read(spec.model_politikasi.nitelendirme.kiyas));
  // 4I-0'da fikstürün olcumler alanı boştur; 4I-B tamamlandığında ölçüm kaydı ayrı sürümlü dosyadan verilir.
  checkModelQualification(spec.model_politikasi, benchmark.olcumler);
  // Nitelendirme durumu "tamamlandi" yapıldığında geçen ölçüm kaydı olmadan model nitelikli ilan edilemez.
  const emptyPolicy = structuredClone(spec.model_politikasi);
  for (const entry of Object.values(emptyPolicy.roller)) {
    entry.nitelikli_modeller = [];
    entry.secili = null;
  }
  const completedPolicy = structuredClone(emptyPolicy);
  completedPolicy.nitelendirme.durum = 'tamamlandi';
  completedPolicy.roller.rapor_yazari_otomatik.nitelikli_modeller = ['DeepSeek-V4.1-Flash-1017'];
  completedPolicy.roller.rapor_yazari_otomatik.secili = 'DeepSeek-V4.1-Flash-1017';
  assert.throws(() => checkModelQualification(completedPolicy, []), /ölçüm kaydı zorunludur/);
  // Yalnızca yüksek kalite yazarı seçilip zorunlu otomatik yazar boş bırakılarak tamamlanan nitelendirme kabul edilmez.
  const missingAutoWriter = structuredClone(emptyPolicy);
  missingAutoWriter.nitelendirme.durum = 'tamamlandi';
  missingAutoWriter.roller.rapor_yazari_yuksek_kalite.nitelikli_modeller = ['DeepSeek-V4.1-Flash-1017'];
  missingAutoWriter.roller.rapor_yazari_yuksek_kalite.secili = 'DeepSeek-V4.1-Flash-1017';
  assert.throws(() => checkModelQualification(missingAutoWriter, [
    { rol: 'rapor_yazari_yuksek_kalite', model: 'DeepSeek-V4.1-Flash-1017', sonuc: 'gecer' }
  ]), /rapor_yazari_otomatik rolü seçili olmalıdır/);
  // Ayrı ölçüm kaydında geçen sonuç varsa tamamlanan nitelendirme geçer; denetçi yazardan farklı kalır.
  const measured = [{ rol: 'rapor_yazari_otomatik', model: 'DeepSeek-V4.1-Flash-1017', sonuc: 'gecer' }];
  assert.throws(() => checkModelQualification(completedPolicy, measured), /yalnızca nitelikli yazarlar/);
  completedPolicy.roller.rapor_yazari_kullanici_secimi.nitelikli_modeller = ['DeepSeek-V4.1-Flash-1017'];
  checkModelQualification(completedPolicy, measured);
  completedPolicy.roller.rapor_yazari_kullanici_secimi.secili = 'DeepSeek-V4.1-Flash-1017';
  assert.throws(() => checkModelQualification(completedPolicy, measured), /yönetici seçimi rapor bazındadır/);
});

// ------------------------------------------------------------------ belgeler ve 4I-0 sınırı

const ROADMAP = 'docs/BILGIN-4I-UYGULAMA-YOL-HARITASI.md';
const ARCHITECTURE = 'docs/BILGIN-4I-YONETICI-RAPORU-MIMARISI.md';
const ACCEPTANCE = 'docs/BILGIN-4I-KIYAS-VE-KABUL-CERCEVESI.md';

test('belgeler: temel ilke mimari, yol haritası ve kabul çerçevesinde açıkça yazılıdır', async () => {
  for (const file of [ROADMAP, ARCHITECTURE, ACCEPTANCE]) {
    assert.ok((await read(file)).includes('Olgusal doğruluk yazımı sınırlar; yazımın yerine geçmez.'), file);
  }
});

test('belgeler: yol haritası 4I-0…4I-F artımlarını on altı başlıkla, durumları ve 4J sınırıyla kaydeder', async () => {
  const roadmap = await read(ROADMAP);
  const increments = ['4I-0', '4I-A', '4I-B', '4I-C', '4I-D', '4I-E', '4I-F'];
  const LABELS = ['Amaç ve kullanıcı değeri', 'İşlevsel kapsam', 'Yeniden kullanılan altyapı', 'Mimari sınırlar',
    'Beklenen dosya ve bileşenler', 'Gözlenebilir çıktılar', 'Gerekli referans görüntüleri ve varlıklar',
    'İşlevsel ve işlevsel olmayan kabul ölçütleri', 'Güvenlik ve yetki sınamaları', 'Doğal dil kalite gereksinimleri',
    'Regresyon gereksinimleri', 'Başarım ve kaynak', 'Bağımlılıklar', 'Riskler ve geri alma', 'Kapsam dışı', 'Durum ve doğrulama kanıtı'];
  const starts = increments.map((id) => roadmap.indexOf(`\n## ${id} `));
  starts.forEach((start, index) => assert.ok(start > 0, `${increments[index]} bölümü`));
  for (let index = 0; index < increments.length; index += 1) {
    const end = index + 1 < increments.length ? starts[index + 1] : roadmap.indexOf('\n## ', starts[index] + 5);
    const section = roadmap.slice(starts[index], end);
    LABELS.forEach((label, position) => assert.ok(section.includes(`${position + 1}. **${label}**`), `${increments[index]} → ${label}`));
    if (index > 0) assert.match(section, /\*\*Durum: PLANLANDI\.\*\*/, `${increments[index]} henüz uygulanmadı`);
  }
  assert.match(roadmap, /4I-B ve 4I-C belirleyici kalite kapılarıdır/);
  const boundary = roadmap.slice(roadmap.indexOf('\n## Aşama 4J sınırı'));
  for (const item of ['arka plan', 'kalıcı rapor saklama', 'zamanlanmış', 'otomatik teslim', 'saklama ve silme', 'e-posta']) {
    assert.ok(boundary.toLocaleLowerCase('tr-TR').includes(item), `4J sınırı → ${item}`);
  }
  const management = await read('docs/BILGIN-YONETIM-ANALIZI-YOL-HARITASI.md');
  assert.ok(management.includes('(BILGIN-4I-UYGULAMA-YOL-HARITASI.md)'), 'yönetim yol haritası ayrıntılı 4I belgesine bağlanır');
});

/** SQL Server iç içe blok yorumlarını, satır yorumlarını, metin sabitlerini ve sınırlı tanımlayıcıları ayrıştırır. */
function stripSqlCommentsAndLiterals(sql) {
  let out = '';
  const literals = [];
  const identifiers = [];
  let currentLiteral = '';
  let currentIdent = '';
  let blockDepth = 0;
  let inLineComment = false;
  let inString = false;
  let inBracketIdentifier = false;
  let inQuotedIdentifier = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (inLineComment) {
      if (ch === '\n' || ch === '\r') {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (blockDepth > 0) {
      if (ch === '/' && next === '*') {
        blockDepth += 1;
        i += 1;
      } else if (ch === '*' && next === '/') {
        blockDepth -= 1;
        i += 1;
        if (blockDepth === 0) out += ' ';
      }
      continue;
    }
    if (inString) {
      if (ch === "'") {
        if (next === "'") {
          currentLiteral += "'";
          i += 1;
        } else {
          inString = false;
          const idx = literals.length;
          literals.push(currentLiteral);
          currentLiteral = '';
          out += ` __LIT_${idx}__ `;
        }
      } else {
        currentLiteral += ch;
      }
      continue;
    }
    if (inBracketIdentifier) {
      if (ch === ']') {
        if (next === ']') {
          currentIdent += ']';
          i += 1;
        } else {
          inBracketIdentifier = false;
          const idx = identifiers.length;
          identifiers.push(currentIdent);
          currentIdent = '';
          out += ` __IDENT_${idx}__ `;
        }
      } else {
        currentIdent += ch;
      }
      continue;
    }
    if (inQuotedIdentifier) {
      if (ch === '"') {
        if (next === '"') {
          currentIdent += '"';
          i += 1;
        } else {
          inQuotedIdentifier = false;
          const idx = identifiers.length;
          identifiers.push(currentIdent);
          currentIdent = '';
          out += ` __IDENT_${idx}__ `;
        }
      } else {
        currentIdent += ch;
      }
      continue;
    }
    if (ch === '-' && next === '-') {
      inLineComment = true;
      i += 1;
      out += ' ';
    } else if (ch === '/' && next === '*') {
      blockDepth = 1;
      i += 1;
    } else if (ch === "'") {
      inString = true;
      currentLiteral = '';
    } else if ((ch === 'N' || ch === 'n') && next === "'") {
      inString = true;
      currentLiteral = '';
      i += 1;
    } else if (ch === '[') {
      inBracketIdentifier = true;
      currentIdent = '';
    } else if (ch === '"') {
      inQuotedIdentifier = true;
      currentIdent = '';
    } else {
      out += ch;
    }
  }
  return { cleaned: out, literals, identifiers };
}

const REPORT_TABLE_NAME = '(?:bilgin|executive|y[oö]netici|(?:mr_)?ai)[\\p{L}\\d_]{0,24}?(?:rapor|report)';
const REPORT_TARGET_RE = new RegExp(REPORT_TABLE_NAME, 'iu');
const SQL_IDENT_PART = '(?:__IDENT_\\d+__|[#\\p{L}\\p{N}_]+)';
const SQL_IDENT_PART_RE = new RegExp(SQL_IDENT_PART, 'gu');
const SQL_QUALIFIED_TARGET = `${SQL_IDENT_PART}(?:\\s*\\.\\s*${SQL_IDENT_PART}){0,3}`;
const SQL_OBJECT_TYPES = 'TABLE|VIEW|PROC(?:EDURE)?|TRIGGER|SCHEMA|FUNCTION|SYNONYM|TYPE|SEQUENCE';
const SQL_TARGET_LIST = SQL_QUALIFIED_TARGET + '(?:\\s*,\\s*' + SQL_QUALIFIED_TARGET + ')*';
const SQL_OBJECT_DDL_RE = new RegExp(
  '\\b(?:(?:CREATE(?:\\s+OR\\s+ALTER)?|ALTER|DROP)\\s+(?:' + SQL_OBJECT_TYPES
    + ')|TRUNCATE\\s+TABLE|MERGE(?:\\s+INTO)?)\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?(' + SQL_TARGET_LIST + ')',
  'giu'
);
const SQL_INDEX_DDL_RE = new RegExp(
  '\\b(?:CREATE\\s+(?:UNIQUE\\s+)?(?:(?:NON)?CLUSTERED\\s+)?|ALTER\\s+|DROP\\s+)INDEX\\s+(?:IF\\s+EXISTS\\s+)?('
    + SQL_QUALIFIED_TARGET + ')(?:\\s+ON\\s+(' + SQL_QUALIFIED_TARGET + '))?',
  'giu'
);
const SQL_STATEMENT_BREAK = '\\b(?:INSERT|MERGE|UPDATE|DELETE|CREATE|ALTER|DROP|FETCH|BULK|DECLARE|EXEC|EXECUTE|PRINT|RETURN)\\b';
const SQL_SELECT_INTO_RE = new RegExp(
  '\\bSELECT\\b(?:(?!' + SQL_STATEMENT_BREAK + ')[\\s\\S])*?\\bINTO\\s+(?!@)(' + SQL_QUALIFIED_TARGET + ')',
  'giu'
);
const SQL_VAR = '@[\\p{L}\\p{N}_]+';
const SQL_VALUE_ATOM = '(?:__LIT_\\d+__|' + SQL_VAR + ')';
const SQL_VALUE_EXPR = SQL_VALUE_ATOM + '(?:\\s*\\+\\s*' + SQL_VALUE_ATOM + ')*';
const SQL_COMPLETE_VALUE = new RegExp('^' + SQL_VALUE_EXPR + '$', 'iu');
const SQL_EXEC_MODULE = new RegExp('^(?:' + SQL_VAR + '\\s*=\\s*)?(' + SQL_VAR + '|' + SQL_QUALIFIED_TARGET + ')(?=\\s|$)([\\s\\S]*)', 'iu');
const SQL_EVENTS = /\b(?:DECLARE|SELECT|SET(?=\s+@)|EXEC(?:UTE)?|IF|ELSE|BEGIN|END|PRINT|RETURN|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|MERGE|TRUNCATE)\b/giu;

/** Parantez içindeki virgüller tür/ifade öğelerine aittir; yalnızca dış düzeydeki virgüller listeyi böler. */
function splitSqlItems(text) {
  const pieces = [];
  let start = 0;
  let nesting = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '(') nesting += 1;
    else if (text[index] === ')') nesting -= 1;
    else if (text[index] === ',' && nesting === 0) {
      pieces.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  pieces.push(text.slice(start).trim());
  return pieces;
}

/** Bilinen metin sabitlerini ve değişken değerlerini birleştirir; çözümlenemeyen ifadeyi kısmen yorumlamaz. */
function resolveSqlValues(expr, literals, vars) {
  if (!SQL_COMPLETE_VALUE.test(expr?.trim() ?? '')) return [];
  let values = [''];
  for (const atom of expr.trim().split(/\s*\+\s*/u)) {
    const match = /^__LIT_(\d+)__$/u.exec(atom);
    const suffixes = match ? [literals[Number(match[1])]] : vars.get(atom.toLowerCase()) ?? [];
    values = [...new Set(values.flatMap((prefix) => suffixes.map((suffix) => prefix + suffix)))];
  }
  return values;
}

/** Sınırlı tanımlayıcı yer tutucularını (__IDENT_n__) özgün tanımlayıcı metnine çözer. */
function resolveIdentPart(part, identifiers) {
  const m = /^__IDENT_(\d+)__$/u.exec(part.trim());
  if (m) return identifiers[Number(m[1])] ?? '';
  let raw = part.trim();
  if (raw.startsWith('[') && raw.endsWith(']')) raw = raw.slice(1, -1).replace(/\]\]/gu, ']');
  else if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1).replace(/""/gu, '"');
  return raw;
}

/** Nitelikli SQL hedef adının yerel geçici tablo (#... veya [#...]) olup olmadığını sınırlı tanımlayıcılardaki noktaları koruyarak belirler. */
function isLocalTempTarget(qualifiedTarget, identifiers = []) {
  const parts = qualifiedTarget.match(SQL_IDENT_PART_RE);
  if (!parts || parts.length === 0) return false;
  const lastPart = resolveIdentPart(parts.at(-1), identifiers);
  return lastPart.startsWith('#') && !lastPart.startsWith('##');
}

/** Verilen nitelikli SQL hedef adının kalıcı bir rapor şema nesnesine işaret edip etmediğini Türkçe harf katlamasıyla sınar. */
function isPermanentReportTarget(qualifiedTarget, identifiers = []) {
  if (!qualifiedTarget || isLocalTempTarget(qualifiedTarget, identifiers)) return false;
  const resolved = qualifiedTarget.replace(/__IDENT_(\d+)__/gu, (_m, idx) => identifiers[Number(idx)] ?? '');
  return matchesReportName(resolved);
}

function matchesReportName(name) {
  return REPORT_TARGET_RE.test(name) || REPORT_TARGET_RE.test(name.toLocaleLowerCase('tr-TR'));
}

function scanSqlAssignments(kind, text, literals, vars, conditional) {
  const selection = kind === 'SELECT' ? /\b(?:FROM|WHERE|HAVING)\b/iu.exec(text) : null;
  if (selection && /^WHERE\s+1\s*=\s*0\s*$/iu.test(text.slice(selection.index))) return;
  const assignments = splitSqlItems(selection ? text.slice(0, selection.index) : text);
  const declare = /^(@[\p{L}\p{N}_]+)\s+[^=]+?(?:\s*=\s*([\s\S]+))?$/u;
  const assign = /^(@[\p{L}\p{N}_]+)\s*(\+?=)\s*([\s\S]+)$/u;
  for (const item of assignments) {
    const parts = (kind === 'DECLARE' ? declare : assign).exec(item);
    if (!parts) continue;
    const key = parts[1].toLowerCase();
    const before = vars.get(key) ?? [];
    let after = resolveSqlValues(kind === 'DECLARE' ? parts[2] : parts[3], literals, vars);
    if (kind !== 'DECLARE' && parts[2] === '+=') {
      after = before.flatMap((prefix) => after.map((suffix) => prefix + suffix));
    }
    // Satır döndürmeyebilen SELECT veya koşullu atama önceki değeri geçersiz kılamaz.
    vars.set(key, (selection || conditional) ? [...new Set([...before, ...after])] : after);
  }
}

function checkSqlExecution(text, literals, identifiers, vars, depth) {
  const inner = /^\(\s*([\s\S]*?)\s*\)/u.exec(text);
  const containsOperation = (values) => values.some((value) => hasReportSchemaOperation(value, depth + 1));
  if (inner) return containsOperation(resolveSqlValues(inner[1], literals, vars));
  const call = SQL_EXEC_MODULE.exec(text);
  if (!call) return false;
  const moduleNames = call[1].startsWith('@')
    ? (vars.get(call[1].toLowerCase()) ?? [])
    : [(call[1].match(SQL_IDENT_PART_RE) ?? []).map((part) => resolveIdentPart(part, identifiers)).join('.')];
  const positional = [];
  const named = new Map();
  for (const item of splitSqlItems(call[2])) {
    const match = /^@([\p{L}\p{N}_]+)\s*=\s*([\s\S]+)$/u.exec(item);
    if (match) named.set(match[1].toLowerCase(), resolveSqlValues(match[2], literals, vars));
    else positional.push(resolveSqlValues(item, literals, vars));
  }
  for (const name of moduleNames) {
    const leaf = resolveIdentPart(name.split('.').at(-1), []).toLowerCase();
    if (leaf === 'sp_executesql' && containsOperation(named.get('stmt') ?? positional[0] ?? [])) return true;
    if (leaf === 'sp_rename') {
      const types = named.get('objtype') ?? positional[2] ?? [''];
      if (types.some((type) => !['COLUMN', 'INDEX', 'STATISTICS'].includes(type.trim().toUpperCase()))) {
        const names = [
          ...(named.get('objname') ?? positional[0] ?? []),
          ...(named.get('newname') ?? positional[1] ?? [])
        ];
        if (names.some((target) => isPermanentReportTarget(target))) return true;
      }
    }
  }
  return false;
}

/** 4I-0 sınamasında kalıcı rapor hedeflerini ve kaynak sırasındaki bilinen SQL yürütmelerini inceler. */
function hasReportSchemaOperation(sql, depth = 0) {
  if (depth > 4) return false;
  const { cleaned, literals, identifiers } = stripSqlCommentsAndLiterals(sql);
  for (const batch of cleaned.split(/^\s*GO(?:[ \t]+\d+)?[ \t]*$/gim)) {
    const vars = new Map();
    let conditional = false;
    for (const statement of batch.split(';')) {
      for (const match of statement.matchAll(SQL_OBJECT_DDL_RE)) {
        if (splitSqlItems(match[1]).some((target) => isPermanentReportTarget(target, identifiers))) return true;
      }
      for (const match of statement.matchAll(SQL_INDEX_DDL_RE)) {
        if (isPermanentReportTarget(match[1], identifiers) || isPermanentReportTarget(match[2], identifiers)) return true;
      }
      for (const match of statement.matchAll(SQL_SELECT_INTO_RE)) {
        if (isPermanentReportTarget(match[1], identifiers)) return true;
      }
      const events = [...statement.matchAll(SQL_EVENTS)];
      for (const [index, event] of events.entries()) {
        const kind = event[0].toUpperCase();
        const text = statement.slice(event.index + event[0].length, events[index + 1]?.index).trim();
        if (kind === 'IF' || kind === 'ELSE') conditional = true;
        else if (kind === 'END') conditional = false;
        else if (kind === 'DECLARE' || kind === 'SET' || kind === 'SELECT') {
          scanSqlAssignments(kind, text, literals, vars, conditional);
        } else if (kind === 'EXEC' || kind === 'EXECUTE') {
          if (checkSqlExecution(text, literals, identifiers, vars, depth)) return true;
        }
      }
    }
  }
  return false;
}

test('4I-0 sınırı: çalışma zamanı rapor motoru, yükleme hizmeti ya da kalıcılık yoktur; sözleşmeler yalnızca sınanır', async () => {
  const offenders = [];
  const walk = async (directory) => {
    for (const entry of await readdir(path.join(ROOT, directory), { withFileTypes: true })) {
      const relative = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) await walk(relative);
      else if (/\.(m?js|jsx)$/.test(entry.name)) {
        const body = await read(relative);
        if (/bilgin_rapor_stili|bilgin_kurumsal_rapor_sablonu|bilgin-executive-report-benchmark/.test(body)) offenders.push(relative);
      }
    }
  };
  await walk('src');
  assert.deepEqual(offenders, [], '4I-A ve sonrası bu sınamayı bilinçli olarak günceller');
  // SQL yorumları, sütun tanımları, sınırlı tanımlayıcı takma adları, sütun yeniden adlandırmaları ve yerel geçici tablolar yanlış pozitif üretmemeli; kalıcı DDL/INDEX/SELECT INTO/değişkenli dinamik SQL/sp_rename yakalanmalıdır.
  assert.equal(hasReportSchemaOperation('-- No executive report tables are changed here\nSELECT 1;'), false);
  assert.equal(hasReportSchemaOperation("PRINT N'No executive report tables are changed here';"), false);
  assert.equal(hasReportSchemaOperation('/* Örnek /* not */ CREATE TABLE dbo.MR_BilginRaporlar (Id INT); */ SELECT 1;'), false);
  assert.equal(hasReportSchemaOperation("/* EXEC(N'CREATE TABLE dbo.MR_BilginRaporlar (Id INT)'); */ SELECT 1;"), false);
  assert.equal(hasReportSchemaOperation('CREATE TABLE dbo.MR_TrainingTopics (ExecutiveReportWriting bit NOT NULL);'), false);
  assert.equal(hasReportSchemaOperation('CREATE INDEX IX_Training ON dbo.MR_TrainingTopics (ExecutiveReportWriting);'), false);
  assert.equal(hasReportSchemaOperation('CREATE TABLE #MR_BilginRaporlar (Id INT);'), false);
  assert.equal(hasReportSchemaOperation('CREATE TABLE [#MR_ExecutiveReports] (Id INT);'), false);
  assert.equal(hasReportSchemaOperation('CREATE TABLE [#MR_ExecutiveReports.v2] (Id INT);'), false);
  assert.equal(hasReportSchemaOperation('SELECT 1 AS Id INTO #MR_BilginRaporlar;'), false);
  assert.equal(hasReportSchemaOperation("EXEC(N'CREATE TABLE #MR_BilginRaporlar (Id INT)');"), false);
  assert.equal(hasReportSchemaOperation('SELECT 1 AS CheckValue\nINSERT INTO dbo.ExecutiveReportTraining (Id) VALUES (1);'), false);
  assert.equal(hasReportSchemaOperation('SELECT 1 AS [CREATE TABLE dbo.MR_BilginRaporlar];'), false);
  assert.equal(hasReportSchemaOperation("EXEC sp_rename 'dbo.MR_Tasks.OldCol', 'BilginRaporId', 'COLUMN';"), false);
  assert.equal(hasReportSchemaOperation("EXEC sp_rename @objname = N'dbo.MR_Tasks.OldCol', @newname = N'BilginRaporId', @objtype = N'COLUMN';"), false);
  assert.equal(hasReportSchemaOperation('CREATE TABLE dbo.MR_BilginRaporlar (Id INT);'), true);
  assert.equal(hasReportSchemaOperation('CREATE TABLE dbo.MR_Bilgin_Kurumsal_Rapor (Id INT);'), true);
  assert.equal(hasReportSchemaOperation('CREATE TABLE dbo.MR_ExecutiveSummaryReports (Id INT);'), true);
  assert.equal(hasReportSchemaOperation('CREATE TABLE dbo.MR_Bilgin_İş_Rapor (Id INT);'), true);
  assert.equal(hasReportSchemaOperation('CREATE TABLE dbo.[V2;MR_ExecutiveReports] (Id INT);'), true);
  assert.equal(hasReportSchemaOperation('CREATE TABLE dbo.MR_AiReportDrafts (Id INT);'), true);
  assert.equal(hasReportSchemaOperation("EXEC(N'CREATE TABLE dbo.MR_BilginRaporlar (Id INT)');"), true);
  assert.equal(hasReportSchemaOperation("EXEC sp_executesql N'CREATE TABLE dbo.MR_BilginRaporlar (Id INT)';"), true);
  assert.equal(hasReportSchemaOperation("DECLARE @sql NVARCHAR(MAX) = N'CREATE TABLE dbo.MR_BilginRaporlar (Id INT)'; EXEC(@sql);"), true);
  assert.equal(hasReportSchemaOperation("DECLARE @sql NVARCHAR(MAX) = N'CREATE TABLE dbo.MR_BilginRaporlar (Id INT)'; EXEC sp_executesql @sql;"), true);
  assert.equal(hasReportSchemaOperation("DECLARE @sql NVARCHAR(MAX); SET @sql = N'CREATE TABLE '; SET @sql = @sql + N'dbo.MR_ExecutiveSummaryReports (Id INT)'; EXEC(@sql);"), true);
  assert.equal(hasReportSchemaOperation("EXEC sp_rename 'dbo.MR_Tmp', 'MR_BilginRaporlar';"), true);
  assert.equal(hasReportSchemaOperation("EXEC sp_rename @newname = N'MR_BilginRaporlar', @objname = N'dbo.MR_Tmp';"), true);
  assert.equal(hasReportSchemaOperation('CREATE TABLE [dbo].[MR_ExecutiveReport--Archive] (Id INT);'), true);
  assert.equal(hasReportSchemaOperation('CREATE TABLE [dbo].[MR_ExecutiveReport]]Archive] (Id INT);'), true);
  assert.equal(hasReportSchemaOperation('CREATE TABLE\n  dbo.\n  [MR_BilginRaporlar] (Id INT);'), true);
  assert.equal(hasReportSchemaOperation('CREATE NONCLUSTERED INDEX IX_Rapor ON dbo.MR_BilginRaporlar (Id);'), true);
  assert.equal(hasReportSchemaOperation('ALTER TABLE [dbo].[MR_YoneticiRaporlari] ADD Durum NVARCHAR(32);'), true);
  assert.equal(hasReportSchemaOperation('SELECT 1 AS Id INTO dbo.MR_BilginRaporlar;'), true);
  assert.equal(hasReportSchemaOperation('SELECT 1 AS Id INTO [dbo].[MR_ExecutiveReports] FROM dbo.MR_Tasks;'), true);
  for (const sql of [
    'DROP TABLE IF EXISTS dbo.MR_Scratch, dbo.MR_BilginRaporlar;',
    'CREATE TYPE dbo.MR_AIReportDrafts AS TABLE (Id int);',
    'TRUNCATE TABLE dbo.MR_BilginRaporlar;',
    'MERGE INTO dbo.MR_BilginRaporlar AS rapor USING dbo.MR_Scratch AS gecici ON 1 = 0 WHEN MATCHED THEN DELETE;'
  ]) {
    assert.equal(hasReportSchemaOperation(sql), true, sql);
  }
  assert.equal(hasReportSchemaOperation('DROP TABLE IF EXISTS dbo.MR_Scratch, dbo.MR_Other;'), false);
  const reportDdl = "N'CREATE TABLE dbo.MR_AIReportDrafts (Id int)'";
  const safeSql = "N'SELECT 1'";
  const dynamicCases = [
    [true, 'DECLARE @a nvarchar(max), @b nvarchar(max) = ' + reportDdl + '; EXEC(@b);'],
    [true, 'SELECT @a = ' + safeSql + ', @b = ' + reportDdl + '; EXEC [sys].[sp_executesql] @params=N\'\', @stmt=@b;'],
    [true, "DECLARE @modul nvarchar(50) = N'sp_executesql'; EXEC @modul " + reportDdl + ';'],
    [true, 'DECLARE @sql nvarchar(max) = ' + reportDdl + ' EXEC(@sql) SET @sql = ' + safeSql + ';'],
    [false, 'DECLARE @sql nvarchar(max) = ' + safeSql + ' EXEC(@sql) SET @sql = ' + reportDdl + ';'],
    [true, 'DECLARE @sql nvarchar(max) = ' + reportDdl + ' SELECT @sql = ' + safeSql + ' WHERE 1 = 0 EXEC(@sql);'],
    [true, 'DECLARE @sql nvarchar(max) = ' + reportDdl + ' SELECT @sql = ' + safeSql + ' FROM dbo.MR_Scratch EXEC(@sql);'],
    [false, 'DECLARE @sql nvarchar(max) = ' + reportDdl + ' SELECT @sql = ' + safeSql + ' EXEC(@sql);'],
    [false, 'DECLARE @sql nvarchar(max) = ' + reportDdl + "\nGO\nDECLARE @sql nvarchar(max) = CONCAT(N'SELECT ', N'1')\nEXEC(@sql);"],
    [true, "EXEC sys.sp_rename N'dbo.MR_Scratch', N'MR_Other'\nEXEC [sys].[sp_rename] N'dbo.MR_Other', N'MR_AIReportDrafts';"]
  ];
  for (const [result, sql] of dynamicCases) {
    assert.equal(hasReportSchemaOperation(sql), result, sql);
  }
  const sqlFiles = (await readdir(path.join(ROOT, 'database'))).filter((name) => /\.sql$/iu.test(name));
  assert.ok(sqlFiles.includes('MR_Create_Durable_Persistence.sql'), 'temel kalıcılık şema betiği taranmalıdır');
  for (const name of sqlFiles) {
    assert.equal(matchesReportName(name), false, 'yönetici raporu için kalıcılık 4J kapsamındadır: ' + name);
    assert.equal(hasReportSchemaOperation(await read(path.posix.join('database', name))), false,
      'yönetici raporu için kalıcılık 4J kapsamındadır: ' + name);
  }
});
