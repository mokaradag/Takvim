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
  assert.match(styleSpec.yapi.bolum_kurallari.dengeli_sunum, /gizleyemez/);
}

test('stil belgesi: kaynak ve yöntem notu ile zorunlu bölümler sunum tercihiyle kapatılamaz', () => {
  checkMandatorySections(spec);
  for (const id of ['one_cikan_gelismeler', 'faaliyetler']) {
    const mutated = structuredClone(spec);
    mutated.yapi.bolumler.find((section) => section.kimlik === id).zorunlu = false;
    assert.throws(() => checkMandatorySections(mutated), new RegExp('zorunlu bölüm kapatılamaz: ' + id));
  }
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
  const JC = { iki_yana: 'both', orta: 'center', sag: 'right' };
  for (const [id, entry] of Object.entries(spec.stiller)) {
    const element = byId.get(id);
    assert.ok(element, `stil yok: ${id}`);
    assert.equal(attr(child(element, 'w:name')), entry.ad, id);
    if (entry.tur === 'tablo') {
      assert.equal(attr(element, 'w:type'), 'table', id);
      const conditional = (type) => children(element, 'w:tblStylePr').find((node) => attr(node, 'w:type') === type);
      assert.equal(attr(child(child(conditional('firstRow'), 'w:tcPr'), 'w:shd'), 'w:fill'), paletteColor(entry.baslik_satiri_zemini), id);
      assert.equal(attr(child(child(conditional('lastRow'), 'w:tcPr'), 'w:shd'), 'w:fill'), paletteColor(entry.toplam_satiri_zemini), id);
      assert.equal(attr(child(child(child(element, 'w:tblPr'), 'w:tblBorders'), 'w:insideH'), 'w:color'), paletteColor(entry.cizgi), id);
      continue;
    }
    assert.equal(attr(element, 'w:type'), 'paragraph', id);
    const rPr = child(element, 'w:rPr');
    const pPr = child(element, 'w:pPr');
    assert.equal(attr(child(rPr, 'w:sz')), String(Math.round(entry.boyut * 2)), `${id} boyut`);
    assert.equal(attr(child(rPr, 'w:color')), paletteColor(entry.renk), `${id} renk`);
    assert.equal(on(child(rPr, 'w:b')), Boolean(entry.kalin), `${id} kalın`);
    assert.equal(on(child(rPr, 'w:i')), Boolean(entry.italik), `${id} italik`);
    assert.equal(attr(child(rPr, 'w:rFonts'), 'w:asciiTheme'), entry.yazi === 'baslik' ? 'majorHAnsi' : 'minorHAnsi', `${id} yazı rolü`);
    assert.equal(attr(child(rPr, 'w:rFonts'), 'w:ascii'), null, `${id} doğrudan yazı tipi adı taşımaz`);
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
    const spacing = child(child(paragraph, 'w:pPr'), 'w:spacing');
    if (!spacing) continue;
    const before = attr(spacing, 'w:before');
    const after = attr(spacing, 'w:after');
    const line = attr(spacing, 'w:line');
    const lineRule = attr(spacing, 'w:lineRule');
    assert.ok(before === null || before === expectedBefore, `${name}: BilginGovde doğrudan w:before çelişiyor`);
    assert.ok(after === null || after === expectedAfter, `${name}: BilginGovde doğrudan w:after çelişiyor`);
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

function checkNumbering(numbering, styles, body) {
  const levelFor = (style) => {
    const element = all(styles, 'w:style').find((node) => attr(node, 'w:styleId') === style);
    const properties = child(child(element, 'w:pPr'), 'w:numPr');
    const numId = attr(child(properties, 'w:numId'));
    const level = attr(child(properties, 'w:ilvl')) ?? '0';
    assert.equal(level, '0', style + ': numara düzeyi');
    const num = all(numbering, 'w:num').find((node) => attr(node, 'w:numId') === numId);
    assert.ok(num, style + ': numara tanımı yok');
    assert.equal(children(num, 'w:lvlOverride').length, 0, style + ': düzey geçersiz kılınamaz');
    const abstractId = attr(child(num, 'w:abstractNumId'));
    const definition = all(numbering, 'w:abstractNum').find((node) => attr(node, 'w:abstractNumId') === abstractId);
    return children(definition, 'w:lvl').find((node) => attr(node, 'w:ilvl') === level);
  };
  const headingLevel = levelFor('Heading1');
  assert.equal(attr(child(headingLevel, 'w:numFmt')), 'decimalZero');
  assert.equal(attr(child(headingLevel, 'w:start')), '1', 'başlık numarası 01 ile başlar');
  assert.equal(attr(child(headingLevel, 'w:lvlText')), '%1', 'başlık numarası biçimi');
  assert.equal(attr(child(child(headingLevel, 'w:rPr'), 'w:color')), paletteColor(spec.stiller.Heading1.numara_rengi));
  for (const heading of all(body, 'w:p').filter((paragraph) => paragraphStyle(paragraph) === 'Heading1')) {
    assert.equal(child(child(heading, 'w:pPr'), 'w:numPr'), null, 'başlık numarası paragrafta değiştirilemez');
  }
  const bulletLevel = levelFor('BilginListeMaddesi');
  assert.equal(attr(child(bulletLevel, 'w:numFmt')), 'bullet');
  assert.equal(attr(child(child(bulletLevel, 'w:rPr'), 'w:color')), paletteColor(spec.stiller.BilginListeMaddesi.madde_rengi));
}

test('şablon: bölüm numaraları 01 ile başlar, sıra ve madde işareti stillerden gelir', () => {
  checkNumbering(xml(part('numbering')), xml(part('styles')), xml(part('officeDocument')));
});

test('şablon: yazı tipleri yalnızca tema üzerinden ve etkin profildendir; Nexa denetimsiz ikameye bırakılmaz', () => {
  const profile = spec.yazi_tipi.profiller[spec.yazi_tipi.etkin_profil];
  assert.ok(profile, 'etkin profil tanımlı');
  const theme = xml(part('theme'));
  const latin = (tag) => all(all(theme, tag)[0], 'a:latin')[0].getAttribute('typeface');
  assert.equal(latin('a:majorFont'), profile.baslik);
  assert.equal(latin('a:minorFont'), profile.govde);
  const allowed = new Set([profile.baslik, profile.govde]);
  for (const name of docx.names.filter((entry) => /^word\/.*\.xml$/.test(entry))) {
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

function checkPalette(document, name) {
  const wordColors = new Set(all(document, 'w:color'));
  const drawingColors = new Set(all(document, 'a:srgbClr'));
  const themeOverrideAttrs = ['w:themeColor', 'w:themeTint', 'w:themeShade', 'w:themeFill', 'w:themeFillTint', 'w:themeFillShade'];
  for (const element of document.getElementsByTagName('*')) {
    for (const overrideAttr of themeOverrideAttrs) {
      assert.equal(attr(element, overrideAttr), null, name + ': tema renk geçersiz kılması yasak (' + overrideAttr + ')');
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
}

test('şablon: kullanılan her renk kurumsal paletten ya da nötrlerdendir (kapak yedigeni dâhil)', () => {
  for (const name of docx.names.filter((entry) => /\.(xml|svg)$/.test(entry))) checkPalette(xml(name), name);
});

function placeholders(element, name) {
  return all(element, 'w:t').flatMap((node) => {
    const text = node.textContent;
    assert.doesNotMatch(text.replace(PLACEHOLDER, ''), /\{\{|\}\}/, name + ': bölünmüş yer tutucu');
    return [...text.matchAll(PLACEHOLDER)].map((match) => match[1]);
  });
}

function checkSectionPlaceholders(document) {
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
        assert.equal(paragraphText(block), section.baslik, 'bölüm başlığı ve belge sırası');
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
    assert.equal(on(child(child(paragraph, 'w:pPr'), 'w:pageBreakBefore')), false,
      'ilk gövde başlığı dışında doğrudan pageBreakBefore yasak');
  }
  assert.equal(tokens.length, sections.length, 'bölüm sayısı');
  for (const [index, section] of sections.entries()) {
    assert.deepEqual(tokens[index], section.yer_tutucular ?? [], section.kimlik + ': bölüm yer tutucuları');
  }
  return tokens.flat();
}

test('şablon: yer tutucular bölünmez, stil belgesiyle bire bir aynıdır ve ilgili bölümde doğru sıradadır', () => {
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
    seen.add(key);
  }
  assert.equal(child(root, 'dc:title')?.textContent, spec.sablon.cekirdek.baslik);
  assert.equal(child(root, 'dc:creator')?.textContent, spec.sablon.cekirdek.olusturan);
  assert.equal(child(root, 'cp:lastModifiedBy')?.textContent, '');
  assert.equal(child(root, 'dc:language')?.textContent, spec.yazi_tipi.dil);
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
    const seen = new Set();
    for (const node of all(xml(name), 'w:t')) {
      if (insideField(node)) continue;
      const rest = node.textContent.replace(PLACEHOLDER, '').trim();
      if (!rest) continue;
      assert.ok(allowed.has(rest), `${name}: ilan edilmemiş metin "${rest}"`);
      seen.add(rest);
    }
    assert.deepEqual([...allowed].filter((text) => !seen.has(text)), [], `${name}: ilan edilen ama şablonda olmayan metin`);
  }
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
  const expectedColumnCount = spec.tablolar.donem_gorev_ozeti.sutunlar.length;
  const gridCols = children(child(summary[0], 'w:tblGrid'), 'w:gridCol');
  assert.equal(gridCols.length, expectedColumnCount, 'özet tablo ızgara sütun sayısı');
  const tblLook = child(child(summary[0], 'w:tblPr'), 'w:tblLook');
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
    properties[name] = element.textContent;
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

/** Yetkili HEPT_PATHS tanımından ve kurumsal paletten beklenen kapak SVG yol ve zemin renklerini türetir. */
async function loadAuthorizedCoverExpectations() {
  const ui = await read(spec.gorseller.kapak_yedigeni.kaynak);
  const block = ui.slice(ui.indexOf('const HEPT_PATHS = ['), ui.indexOf('];', ui.indexOf('const HEPT_PATHS = [')));
  const paths = [...block.matchAll(/\{ tone: '(teal|orange)', d: '([^']+)' \}/g)];
  assert.equal(paths.length, 5, 'yetkili beş yedigen yolu');
  const expectedPaths = paths.map(([, tone, d]) => ({
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
  const viewBox = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/u).map(Number);
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
    const values = matrixMatch[1].split(/[\s,]+/u).map(Number);
    assert.equal(values.length, APPROVED_COVER_MATRIX.length, 'kapak SVG yedigen dönüşüm matrisi geçersiz');
    for (let i = 0; i < APPROVED_COVER_MATRIX.length; i += 1) {
      assert.ok(Number.isFinite(values[i]) && Math.abs(values[i] - APPROVED_COVER_MATRIX[i]) < 1e-3,
        'kapak SVG yedigen yerleşimi onaylı konumdan sapamaz');
    }
  }
}

function checkCoverRelationships(document, relationship) {
  const anchors = all(document, 'wp:anchor');
  assert.equal(anchors.length, 1, 'tek kapak çizimi');
  const [anchor] = anchors;
  assert.ok(['1', 'true'].includes(attr(anchor, 'behindDoc')), 'kapak çizimi metnin arkasındadır');
  assert.ok(['0', 'false'].includes(attr(anchor, 'simplePos')), 'kapak çizimi sayfa göreli konumlandırma kullanmalıdır');
  const posH = child(anchor, 'wp:positionH');
  const posV = child(anchor, 'wp:positionV');
  assert.equal(posH?.getAttribute('relativeFrom'), 'page', 'kapak yatay konumu sayfaya göre olmalıdır');
  assert.equal(posV?.getAttribute('relativeFrom'), 'page', 'kapak dikey konumu sayfaya göre olmalıdır');
  assert.equal(Number(child(posH, 'wp:posOffset')?.textContent?.trim()), 0, 'kapak yatay konumu sayfa başlangıcında (0 EMU) olmalıdır');
  assert.equal(Number(child(posV, 'wp:posOffset')?.textContent?.trim()), 0, 'kapak dikey konumu sayfa başlangıcında (0 EMU) olmalıdır');
  assert.equal(anchor.parentNode?.parentNode?.parentNode, all(document, 'w:body')[0].firstElementChild,
    'kapak çizimi ilk paragraftadır');
  const wpExtent = child(anchor, 'wp:extent');
  assert.equal(Number(wpExtent?.getAttribute('cx')), APPROVED_COVER_EXTENT_EMU.cx, 'kapak wp:extent genişliği A4 ile eşleşmelidir');
  assert.equal(Number(wpExtent?.getAttribute('cy')), APPROVED_COVER_EXTENT_EMU.cy, 'kapak wp:extent yüksekliği A4 ile eşleşmelidir');
  const picSpPr = all(anchor, 'pic:spPr')[0];
  const picXfrm = child(picSpPr, 'a:xfrm');
  const picOff = child(picXfrm, 'a:off');
  assert.equal(Number(picOff?.getAttribute('x')), 0, 'kapak pic:spPr/a:xfrm/a:off x konumu 0 olmalıdır');
  assert.equal(Number(picOff?.getAttribute('y')), 0, 'kapak pic:spPr/a:xfrm/a:off y konumu 0 olmalıdır');
  const picExt = child(picXfrm, 'a:ext');
  assert.equal(Number(picExt?.getAttribute('cx')), APPROVED_COVER_EXTENT_EMU.cx, 'kapak pic:spPr/a:xfrm/a:ext genişliği A4 ile eşleşmelidir');
  assert.equal(Number(picExt?.getAttribute('cy')), APPROVED_COVER_EXTENT_EMU.cy, 'kapak pic:spPr/a:xfrm/a:ext yüksekliği A4 ile eşleşmelidir');
  const png = all(anchor, 'a:blip');
  const svg = all(anchor, 'asvg:svgBlip');
  assert.equal(png.length, 1, 'kapak PNG başvurusu');
  assert.equal(svg.length, 1, 'kapak SVG başvurusu');
  assert.ok(png[0].contains(svg[0]), 'kapak PNG ve SVG aynı çizimdedir');
  assert.equal(relationship(attr(png[0], 'r:embed'), 'image'), 'word/media/kapak-yedigen.png');
  assert.equal(relationship(attr(svg[0], 'r:embed'), 'image'), 'word/media/kapak-yedigen.svg');
}

test('şablon: çok parçalı, çakışan, tutarsız, kayıtsız baytlı veya bozuk ZIP girdileri reddedilir', async () => {
  const original = await readFile(path.join(ROOT, spec.sablon.dosya));
  const end = original.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const central = original.readUInt32LE(end + 16);
  const local = original.readUInt32LE(central + 42);
  const next = central + 46 + original.readUInt16LE(central + 28)
    + original.readUInt16LE(central + 30) + original.readUInt16LE(central + 32);
  assert.equal(readZipEntries(original).size, docx.names.length);
  for (const [mutate, expected] of [
    [(copy) => copy.writeUInt16LE(1, end + 4), /çok parçalı ZIP/],
    [(copy) => copy.writeUInt16LE(1, central + 34), /çok parçalı ZIP girdisi/],
    [(copy) => { copy[local + 30] ^= 1; }, /yerel başlığı merkezî dizinle uyuşmuyor/],
    [(copy) => {
      const checksum = (copy.readUInt32LE(central + 16) ^ 1) >>> 0;
      copy.writeUInt32LE(checksum, central + 16);
      copy.writeUInt32LE(checksum, local + 14);
    }, /girdi sağlama toplamı uyuşmuyor/],
    [(copy) => {
      // İkinci kayda aynı ada sahip merkezî kayıt yazılır.
      original.copy(copy, next, central, next);
    }, /yinelenen ZIP parça adı/],
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

  // Yerel veya merkezî başlıkta ek alan kaydının uzunluğu kendi alanını aştığında reddedilmeli, geçerli ek alan kabul edilmelidir.
  const buildSingleEntryZip = (localExtra, centralExtra) => {
    const name = Buffer.from('test.txt', 'utf8');
    const data = Buffer.from('merhaba', 'utf8');
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
    const centralOffset = localHeader.length + name.length + localExtra.length + data.length;
    const centralLen = centralHeader.length + name.length + centralExtra.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(centralLen, 12);
    eocd.writeUInt32LE(centralOffset, 16);
    return Buffer.concat([localHeader, name, localExtra, data, centralHeader, name, centralExtra, eocd]);
  };
  const validExtra = Buffer.from([0x55, 0x54, 0x04, 0x00, 0x01, 0x02, 0x03, 0x04]);
  const overflowExtra = Buffer.from([0x55, 0x54, 0x10, 0x00, 0x01, 0x02, 0x03, 0x04]);
  assert.equal(readZipEntries(buildSingleEntryZip(validExtra, validExtra)).get('test.txt').toString('utf8'), 'merhaba');
  assert.throws(() => readZipEntries(buildSingleEntryZip(overflowExtra, Buffer.alloc(0))), /ZIP ek alan kayıt uzunluğu sınırı aşıyor/);
  assert.throws(() => readZipEntries(buildSingleEntryZip(Buffer.alloc(0), overflowExtra)), /ZIP ek alan kayıt uzunluğu sınırı aşıyor/);
});

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

  // Dış ilişki (DOM üzerinden serileştirmeden bağımsız mutasyon)
  assert.throws(() => validateDocxXml(mutateXmlPart('_rels/.rels', (doc) => {
    const rel = [...doc.documentElement.children].find((el) => el.getAttribute('Id') === 'rId1');
    assert.ok(rel);
    rel.setAttribute('TargetMode', 'External');
  })), /dış ilişki yasak/);

  // Paket kökü ana belge ilişkisi yanlış hedefe yönlendirildiğinde
  assert.throws(() => validateDocxXml(mutateXmlPart('_rels/.rels', (doc) => {
    const rel = [...doc.documentElement.children].find((el) => el.getAttribute('Target') === 'word/document.xml');
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

  // İzinli PAGE alanının komutu değiştirildiğinde (DOM üzerinden)
  assert.throws(() => validateDocxXml(mutateXmlPart('word/footer1.xml', (doc) => {
    const field = all(doc, 'w:fldSimple').find((el) => (attr(el, 'w:instr') ?? '').trim() === 'PAGE');
    assert.ok(field);
    field.setAttributeNS(field.namespaceURI, 'w:instr', ' UNKNOWN ');
  })), /Word alan komutları/);

  // İzinli PAGE alanının önbellekteki görünür sonucuna kurum/kişi metni eklendiğinde
  assert.throws(() => validateDocxXml(mutateXmlPart('word/footer1.xml', (doc) => {
    const field = all(doc, 'w:fldSimple').find((el) => (attr(el, 'w:instr') ?? '').trim() === 'PAGE');
    const t = all(field, 'w:t')[0];
    assert.ok(t);
    t.textContent = 'İlan edilmemiş kurum adı';
  })), /Word alan sonucu sayısal veya boş olmalıdır/);

  // Kilitli PAGE veya SEQ alanları reddedilmeli, açıkça kilitli olmayan (false/0) alanlar kabul edilmelidir.
  assert.throws(() => validateDocxXml(mutateXmlPart('word/footer1.xml', (doc) => {
    const field = all(doc, 'w:fldSimple').find((el) => (attr(el, 'w:instr') ?? '').trim() === 'PAGE');
    field.setAttributeNS(field.namespaceURI, 'w:fldLock', 'true');
  })), /kilitli Word alanı yasak/);
  assert.throws(() => validateDocxXml(mutateXmlPart('word/document.xml', (doc) => {
    const field = all(doc, 'w:fldSimple').find((el) => (attr(el, 'w:instr') ?? '').includes('SEQ Şekil'));
    field.setAttributeNS(field.namespaceURI, 'w:fldLock', '1');
  })), /kilitli Word alanı yasak/);
  validateDocxXml(mutateXmlPart('word/footer1.xml', (doc) => {
    const field = all(doc, 'w:fldSimple').find((el) => (attr(el, 'w:instr') ?? '').trim() === 'PAGE');
    field.setAttributeNS(field.namespaceURI, 'w:fldLock', 'false');
  }));

  // Şekil ve Tablo sayaçları başlık etiketinin önüne taşındığında reddedilmelidir.
  assert.throws(() => validateDocxXml(mutateXmlPart('word/document.xml', (doc) => {
    const field = all(doc, 'w:fldSimple').find((el) => (attr(el, 'w:instr') ?? '').includes('SEQ Şekil'));
    const paragraph = field.parentNode;
    const firstRun = children(paragraph, 'w:r')[0];
    paragraph.insertBefore(field, firstRun);
  })), /şekil sayacı Şekil etiketinden sonra/);
  assert.throws(() => validateDocxXml(mutateXmlPart('word/document.xml', (doc) => {
    const field = all(doc, 'w:fldSimple').find((el) => (attr(el, 'w:instr') ?? '').includes('SEQ Tablo'));
    const paragraph = field.parentNode;
    const firstRun = children(paragraph, 'w:r')[0];
    paragraph.insertBefore(field, firstRun);
  })), /tablo sayacı Tablo etiketinden sonra/);

  // Şekil sayacı başlık dışına (kapak paragrafına) taşındığında
  assert.throws(() => validateDocxXml(mutateXmlPart('word/document.xml', (doc) => {
    const field = all(doc, 'w:fldSimple').find((el) => (attr(el, 'w:instr') ?? '').includes('SEQ Şekil'));
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
    child(lastDataCell, 'w:tcPr').appendChild(cellDel);
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

  // Bölüm sırası bozulduğunda
  const wrongSection = body();
  const heading = all(wrongSection, 'w:p').find((p) => paragraphStyle(p) === 'Heading1' && paragraphText(p) === spec.yapi.bolumler[2].baslik);
  const callout = heading.previousElementSibling;
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

  const conflictingSpacing = body();
  const govdeParagraph = all(conflictingSpacing, 'w:p').find((p) => paragraphStyle(p) === 'BilginGovde');
  const directSpacing = conflictingSpacing.createElementNS(wNs, 'w:spacing');
  directSpacing.setAttributeNS(wNs, 'w:line', '20');
  directSpacing.setAttributeNS(wNs, 'w:lineRule', 'exact');
  child(govdeParagraph, 'w:pPr').appendChild(directSpacing);
  assert.throws(() => checkDirectParagraphSpacing(conflictingSpacing, 'word/document.xml'), /BilginGovde doğrudan w:line çelişiyor/);

  const matchingSpacing = body();
  const govdeMatchParagraph = all(matchingSpacing, 'w:p').find((p) => paragraphStyle(p) === 'BilginGovde');
  const validDirectSpacing = matchingSpacing.createElementNS(wNs, 'w:spacing');
  validDirectSpacing.setAttributeNS(wNs, 'w:line', '276');
  validDirectSpacing.setAttributeNS(wNs, 'w:lineRule', 'auto');
  child(govdeMatchParagraph, 'w:pPr').appendChild(validDirectSpacing);
  checkDirectParagraphSpacing(matchingSpacing, 'word/document.xml');

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

  // Kapak künyesinde Hazırlayan ve Veri Anı etiketleri yer değiştirdiğinde reddedilir
  const swappedCoverLabels = body();
  const labelNodes = all(swappedCoverLabels, 'w:t');
  const hazirlayanNode = labelNodes.find((t) => t.textContent === 'Hazırlayan');
  const veriAniNode = labelNodes.find((t) => t.textContent === 'Veri Anı');
  assert.ok(hazirlayanNode && veriAniNode);
  hazirlayanNode.textContent = 'Veri Anı';
  veriAniNode.textContent = 'Hazırlayan';
  assert.throws(() => checkCoverMetadata(swappedCoverLabels), /kapak künye etiket ve değer eşleşmesi bozulmuş/);

  // Kapak SVG ilişkisi eksik olduğunda veya kapak çizimi 1×1 EMU boyutuna küçültüldüğünde reddedilir
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

  // Sağlam kapak SVG yetkili beklentilerle geçmeli; yollar yorumlandığında, boyut sıfırlandığında, katman sırası/dolgu/kalınlık bozulduğunda reddedilmelidir
  const intactSvg = parseDocxXml(docx.text('word/media/kapak-yedigen.svg'), 'word/media/kapak-yedigen.svg');
  checkCoverSvg(intactSvg, expectedPaths, expectedBg);

  const commentedSvgDom = parseDocxXml(docx.text('word/media/kapak-yedigen.svg'), 'word/media/kapak-yedigen.svg');
  const svgGroupNode = all(commentedSvgDom, 'svg:g')[0];
  svgGroupNode.parentNode.replaceChild(commentedSvgDom.createComment(serializeDocxXml(svgGroupNode)), svgGroupNode);
  const commentedSvg = parseDocxXml(serializeDocxXml(commentedSvgDom), 'word/media/kapak-yedigen.svg');
  assert.throws(() => checkCoverSvg(commentedSvg, expectedPaths, expectedBg),
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
  const gridSpan = spannedTbl.createElementNS(wNs, 'w:gridSpan');
  gridSpan.setAttributeNS(wNs, 'w:val', '2');
  child(spanCell, 'w:tcPr').appendChild(gridSpan);
  assert.throws(() => checkSummaryTable(spannedTbl), /birden fazla sütuna yayılamaz/);

  const vMergedTbl = body();
  const vMergedSummary = all(vMergedTbl, 'w:tbl').find((t) => attr(child(child(t, 'w:tblPr'), 'w:tblStyle')) === spec.tablolar.donem_gorev_ozeti.stil);
  const vMergeStart = vMergedTbl.createElementNS(wNs, 'w:vMerge');
  vMergeStart.setAttributeNS(wNs, 'w:val', 'restart');
  child(children(children(vMergedSummary, 'w:tr')[1], 'w:tc')[1], 'w:tcPr').appendChild(vMergeStart);
  child(children(children(vMergedSummary, 'w:tr')[2], 'w:tc')[1], 'w:tcPr').appendChild(vMergedTbl.createElementNS(wNs, 'w:vMerge'));
  assert.throws(() => checkSummaryTable(vMergedTbl), /dikey birleştirme \(w:vMerge\) yasak/);

  const shiftedTbl = body();
  const shiftedSummary = all(shiftedTbl, 'w:tbl').find((t) => attr(child(child(t, 'w:tblPr'), 'w:tblStyle')) === spec.tablolar.donem_gorev_ozeti.stil);
  const shiftedRow = children(shiftedSummary, 'w:tr')[1];
  const gridBefore = shiftedTbl.createElementNS(wNs, 'w:gridBefore');
  gridBefore.setAttributeNS(wNs, 'w:val', '1');
  child(shiftedRow, 'w:trPr').appendChild(gridBefore);
  assert.throws(() => checkSummaryTable(shiftedTbl), /ilk ızgara sütunundan başlamalıdır/);

  const explicitSingleSpan = body();
  const singleSpanSummary = all(explicitSingleSpan, 'w:tbl').find((t) => attr(child(child(t, 'w:tblPr'), 'w:tblStyle')) === spec.tablolar.donem_gorev_ozeti.stil);
  const singleSpan = explicitSingleSpan.createElementNS(wNs, 'w:gridSpan');
  singleSpan.setAttributeNS(wNs, 'w:val', '1');
  child(children(children(singleSpanSummary, 'w:tr')[1], 'w:tc')[0], 'w:tcPr').appendChild(singleSpan);
  checkSummaryTable(explicitSingleSpan);

  // Numaralandırma ve belge üstverileri (core, app, custom) bozulmaları (DOM üzerinden serileştirmeden bağımsız)
  const numberingDoc = parseDocxXml(docx.text('word/numbering.xml'), 'word/numbering.xml');
  const lvlText = all(numberingDoc, 'w:lvlText').find((el) => attr(el, 'w:val') === '%1');
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
  const makePhys = (unit) => {
    const data = Buffer.alloc(9);
    data.writeUInt32BE(5906, 0);
    data.writeUInt32BE(5906, 4);
    data[8] = unit;
    return buildPngChunk('pHYs', data);
  };
  const validPhys = makePhys(1);
  validateCoverPng(Buffer.concat([basePng.subarray(0, ihdrEnd), validPhys, basePng.subarray(ihdrEnd)]));
  validateCoverPng(Buffer.concat([basePng.subarray(0, ihdrEnd), makePhys(0), basePng.subarray(ihdrEnd)]));
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
  const buildRgbaCoverPng = (alpha) => {
    const width = 210;
    const height = 297;
    const raw = Buffer.alloc(height * (1 + width * 4));
    for (let y = 0; y < height; y += 1) {
      const start = y * (1 + width * 4);
      raw[start] = 0;
      for (let x = 0; x < width; x += 1) {
        let [r, g, b] = [0, 48, 135];
        if (y === 10) [r, g, b] = [7, 119, 128];
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
      for (const id of entry.nitelikli_modeller) {
        const record = measurements.find((item) => item?.rol === role && item?.model === id && item?.sonuc === 'gecer');
        assert.ok(record, `${role}: ${id} için geçen ölçüm kaydı zorunludur`);
      }
    }
  }
  const reviewer = policy.roller.bagimsiz_denetci.secili;
  for (const role of ['rapor_yazari_otomatik', 'rapor_yazari_yuksek_kalite']) {
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
  const completedPolicy = structuredClone(spec.model_politikasi);
  completedPolicy.nitelendirme.durum = 'tamamlandi';
  completedPolicy.roller.rapor_yazari_otomatik.nitelikli_modeller = ['DeepSeek-V4.1-Flash-1017'];
  completedPolicy.roller.rapor_yazari_otomatik.secili = 'DeepSeek-V4.1-Flash-1017';
  assert.throws(() => checkModelQualification(completedPolicy, []), /ölçüm kaydı zorunludur/);
  // Ayrı ölçüm kaydında geçen sonuç varsa tamamlanan nitelendirme geçer; denetçi yazardan farklı kalır.
  checkModelQualification(completedPolicy, [
    { rol: 'rapor_yazari_otomatik', model: 'DeepSeek-V4.1-Flash-1017', sonuc: 'gecer' }
  ]);
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

/** SQL Server iç içe blok yorumlarını, satır yorumlarını ve metin sabitlerini doğrusal taramayla temizler. */
function stripSqlCommentsAndLiterals(sql) {
  let out = '';
  let blockDepth = 0;
  let inLineComment = false;
  let inString = false;
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
          i += 1;
        } else {
          inString = false;
          out += ' ';
        }
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
    } else if ((ch === 'N' || ch === 'n') && next === "'") {
      inString = true;
      i += 1;
    } else {
      out += ch;
    }
  }
  return out;
}

const REPORT_TABLE_NAME = '(?:bilgin\\w{0,8}(?:rapor|report)|y[oö]netici\\w{0,3}rapor|executive\\w{0,3}report)';
const REPORT_DDL_RE = new RegExp(
  `\\b(?:CREATE|ALTER|DROP)\\s+(?:TABLE|VIEW|INDEX|UNIQUE\\s+INDEX|NONCLUSTERED\\s+INDEX|CLUSTERED\\s+INDEX|PROC(?:EDURE)?|TRIGGER|SCHEMA)\\s+[^;\\r\\n]*${REPORT_TABLE_NAME}`,
  'iu'
);
const REPORT_SELECT_INTO_RE = new RegExp(
  `\\bSELECT\\b[^;]*?\\bINTO\\s+(?!#|@)(?:(?:\\[[^\\]]+\\]|\\w+)\\.)?(?:\\[[^\\]]*${REPORT_TABLE_NAME}[^\\]]*\\]|\\w*${REPORT_TABLE_NAME}\\w*)`,
  'iu'
);

/** SQL yorumlarını ve metin sabitlerini temizleyerek yalnızca gerçek şema işlemlerini rapor adlarına göre denetler. */
function hasReportSchemaOperation(sql) {
  const cleaned = stripSqlCommentsAndLiterals(sql);
  return REPORT_DDL_RE.test(cleaned) || REPORT_SELECT_INTO_RE.test(cleaned);
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
  const reportFileName = /bilgin.{0,8}(?:rapor|report)|(?:y[oö]netici.{0,3}rapor|executive.{0,3}report)/iu;
  // SQL yorumları (iç içe blok yorumlar dâhil) ve PRINT tanı iletileri yanlış pozitif üretmemeli; gerçek DDL ve SELECT INTO yakalanmalıdır.
  assert.equal(hasReportSchemaOperation('-- No executive report tables are changed here\nSELECT 1;'), false);
  assert.equal(hasReportSchemaOperation("PRINT N'No executive report tables are changed here';"), false);
  assert.equal(hasReportSchemaOperation('/* Örnek /* not */ CREATE TABLE dbo.MR_BilginRaporlar (Id INT); */ SELECT 1;'), false);
  assert.equal(hasReportSchemaOperation('CREATE TABLE dbo.MR_BilginRaporlar (Id INT);'), true);
  assert.equal(hasReportSchemaOperation('ALTER TABLE [dbo].[MR_YoneticiRaporlari] ADD Durum NVARCHAR(32);'), true);
  assert.equal(hasReportSchemaOperation('SELECT 1 AS Id INTO dbo.MR_BilginRaporlar;'), true);
  assert.equal(hasReportSchemaOperation('SELECT 1 AS Id INTO [dbo].[MR_ExecutiveReports] FROM dbo.MR_Tasks;'), true);
  for (const name of await readdir(path.join(ROOT, 'database'))) {
    if (!/^MR_Upgrade_\d{4}_.*\.sql$/u.test(name)) continue;
    assert.doesNotMatch(name, reportFileName, 'yönetici raporu için kalıcılık 4J kapsamındadır: ' + name);
    assert.equal(hasReportSchemaOperation(await read(path.posix.join('database', name))), false,
      'yönetici raporu için kalıcılık 4J kapsamındadır: ' + name);
  }
});
