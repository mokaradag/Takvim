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
import yaml from 'js-yaml';
import { readDocxPackage, readZipEntries } from './helpers/docxPackage.mjs';
import { all, attr, child, children, on, parseDocxXml, validateDocxXml } from './helpers/docxXml.mjs';
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

const { xml, contentType, documentRelationship } = validateDocxXml(docx);
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

test('stil belgesi: kaynak ve yöntem notu ile zorunlu bölümler sunum tercihiyle kapatılamaz', () => {
  const byId = new Map(spec.yapi.bolumler.map((section) => [section.kimlik, section]));
  assert.equal(byId.get('kaynak_ve_yontem').kaldirilamaz, true);
  for (const fixed of ['kaynak_ve_yontem_notu', 'zorunlu_bolumler', 'palet', 'yazi_tipi', 'stiller', 'bolum_sirasi']) {
    assert.ok(spec.ozellestirme.sabit.includes(fixed), fixed);
  }
  for (const id of ['kapak', 'yonetici_degerlendirmesi', 'genel_sonuc', 'kaynak_ve_yontem']) assert.equal(byId.get(id).zorunlu, true, id);
  assert.match(spec.yapi.bolum_kurallari.dengeli_sunum, /gizleyemez/);
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

test('şablon: paket güvenliği ve ana belge ilişkileri doğrulanır, yalnızca kapak medyası vardır', () => {
  assert.deepEqual(docx.names.filter((name) => name.startsWith('word/media/')).sort(), [...spec.gorseller.kapak_yedigeni.medya].sort());
});

function checkHeaderFooter(partXml, relationship, section) {
  assert.ok(on(child(section, 'w:titlePg')), 'kapak farklı ilk sayfadır');
  for (const [kind, rootTag] of [['header', 'w:hdr'], ['footer', 'w:ftr']]) {
    const references = children(section, 'w:' + kind + 'Reference');
    assert.equal(references.length, 2, kind + ': kapak ve gövde başvuruları');
    for (const [mode, index] of [['default', 1], ['first', 2]]) {
      const ref = references.find((item) => attr(item, 'w:type') === mode);
      const part = relationship(attr(ref, 'r:id'), kind);
      assert.equal(part, 'word/' + kind + index + '.xml', kind + ': ' + mode);
      const document = partXml(part);
      assert.equal(all(document, rootTag)[0], document.documentElement, part + ': parça kökü');
      if (mode === 'first') {
        assert.equal(all(document, 'w:t').map((node) => node.textContent).join('').trim(), '', part + ': kapakta boştur');
      }
    }
  }
}

test('şablon: A4 dikey sayfa, kenar boşlukları, üst/alt bilgi uzaklığı ve boş kapak üst/alt bilgisi stil belgesiyle aynıdır', () => {
  const sect = all(xml('word/document.xml'), 'w:sectPr');
  assert.equal(sect.length, 1, 'tek bölüm');
  const size = child(sect[0], 'w:pgSz');
  assert.equal(attr(size, 'w:w'), String(spec.sayfa.genislik_twip));
  assert.equal(attr(size, 'w:h'), String(spec.sayfa.yukseklik_twip));
  assert.notEqual(attr(size, 'w:orient'), 'landscape');
  const margin = child(sect[0], 'w:pgMar');
  for (const [side, key] of [['ust', 'w:top'], ['alt', 'w:bottom'], ['sol', 'w:left'], ['sag', 'w:right']]) {
    assert.equal(attr(margin, key), String(spec.sayfa.kenar_twip[side]), side);
  }
  assert.equal(attr(margin, 'w:header'), String(spec.sayfa.ust_bilgi_twip));
  assert.equal(attr(margin, 'w:footer'), String(spec.sayfa.alt_bilgi_twip));
  checkHeaderFooter(xml, documentRelationship, sect[0]);
  for (const [name, type] of [['header1', 'header'], ['header2', 'header'], ['footer1', 'footer'], ['footer2', 'footer']]) {
    assert.equal(contentType('word/' + name + '.xml'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.' + type + '+xml');
  }
});

test('şablon: stil belgesindeki her Word stili aynı ad, yazı rolü, boyut, renk, aralık ve kenarlıkla tanımlıdır', () => {
  const styles = xml('word/styles.xml');
  const byId = new Map(all(styles, 'w:style').map((element) => [attr(element, 'w:styleId'), element]));
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
    if (entry.satir != null) assert.equal(attr(spacing, 'w:line'), String(Math.round(entry.satir * 240)), `${id} satır`);
    assert.equal(attr(child(pPr, 'w:jc')), entry.hiza ? JC[entry.hiza] : null, `${id} hiza`);
    assert.equal(on(child(pPr, 'w:pageBreakBefore')), Boolean(entry.yeni_sayfa), `${id} yeni sayfa`);
    const borders = child(pPr, 'w:pBdr');
    for (const [key, side] of [['ust_cizgi', 'w:top'], ['sol_cizgi', 'w:left'], ['alt_cizgi', 'w:bottom']]) {
      assert.equal(attr(child(borders, side), 'w:color'), entry[key] ? paletteColor(entry[key]) : null, `${id} ${key}`);
    }
    assert.equal(attr(child(pPr, 'w:shd'), 'w:fill'), entry.golge ? paletteColor(entry.golge) : null, `${id} gölge`);
  }
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
  checkNumbering(xml('word/numbering.xml'), xml('word/styles.xml'), xml('word/document.xml'));
});

test('şablon: yazı tipleri yalnızca tema üzerinden ve etkin profildendir; Nexa denetimsiz ikameye bırakılmaz', () => {
  const profile = spec.yazi_tipi.profiller[spec.yazi_tipi.etkin_profil];
  assert.ok(profile, 'etkin profil tanımlı');
  const theme = xml('word/theme/theme1.xml');
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
  for (const font of all(xml('word/fontTable.xml'), 'w:font')) assert.ok(allowed.has(attr(font, 'w:name')), attr(font, 'w:name'));
  assert.equal(spec.yazi_tipi.etkin_profil, 'calibri_uyumlu', 'Nexa için kurulum ya da lisanslı, doğrulanmış gömme gerekir');
});

function checkPalette(document, name) {
  const wordColors = new Set(all(document, 'w:color'));
  const drawingColors = new Set(all(document, 'a:srgbClr'));
  for (const element of document.getElementsByTagName('*')) {
    const colors = [attr(element, 'w:color'), attr(element, 'w:fill')];
    if (wordColors.has(element)) colors.push(attr(element));
    if (drawingColors.has(element)) colors.push(attr(element, 'val'));
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
      }
      tokens.push([]);
    }
    tokens.at(-1).push(...placeholders(block, 'word/document.xml'));
  }
  assert.equal(tokens.length, sections.length, 'bölüm sayısı');
  for (const [index, section] of sections.entries()) {
    assert.deepEqual(tokens[index], section.yer_tutucular ?? [], section.kimlik + ': bölüm yer tutucuları');
  }
  return tokens.flat();
}

test('şablon: yer tutucular bölünmez, stil belgesiyle bire bir aynıdır ve ilgili bölümde doğru sıradadır', () => {
  const body = checkSectionPlaceholders(xml('word/document.xml'));
  const header = placeholders(xml('word/header1.xml'), 'word/header1.xml');
  assert.deepEqual([...new Set([...body, ...header])].sort(), Object.keys(spec.yer_tutucular).sort());
  assert.deepEqual(header, ['RAPOR_TURU', 'DONEM']);
  for (const part of ['word/header2.xml', 'word/footer1.xml', 'word/footer2.xml']) {
    assert.deepEqual(placeholders(xml(part), part), []);
  }
});

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
  // Belge özelliklerinde de kişi ya da kurum adı yoktur.
  const core = xml('docProps/core.xml');
  assert.equal(all(core, 'dc:title')[0].textContent, spec.sablon.cekirdek.baslik);
  assert.equal(all(core, 'dc:creator')[0].textContent, spec.sablon.cekirdek.olusturan);
  assert.equal(all(core, 'cp:lastModifiedBy')[0].textContent, '');
  checkExtendedProperties(xml('docProps/app.xml'));
});

function checkExtendedProperties(document) {
  const root = document.documentElement;
  assert.equal(root, all(document, 'ep:Properties')[0], 'genişletilmiş belge özellikleri kökü');
  assert.equal(root.children.length, 2, 'şablonda yalnızca izinli genişletilmiş özellikler bulunur');
  assert.equal(child(root, 'ep:Application')?.textContent, spec.sablon.cekirdek.olusturan);
  assert.equal(child(root, 'ep:DocSecurity')?.textContent, '0');
}

test('şablon: numaralı bölüm başlıkları ve ek başlığı stil belgesindeki sırayla yazılıdır; tablo sütunları aynıdır', () => {
  const paragraphs = all(xml('word/document.xml'), 'w:p');
  const headings = paragraphs.filter((paragraph) => paragraphStyle(paragraph) === 'Heading1').map(paragraphText);
  assert.deepEqual(headings, spec.yapi.bolumler.filter((section) => section.numarali).map((section) => section.baslik));
  const appendix = paragraphs.filter((paragraph) => paragraphStyle(paragraph) === 'BilginEkBasligi').map(paragraphText);
  assert.deepEqual(appendix, spec.yapi.bolumler.filter((section) => section.baslik && section.numarali === false).map((section) => section.baslik));
  const tables = all(xml('word/document.xml'), 'w:tbl');
  const summary = tables.filter((table) => attr(child(child(table, 'w:tblPr'), 'w:tblStyle')) === spec.tablolar.donem_gorev_ozeti.stil);
  assert.equal(summary.length, 1);
  const headerRow = children(summary[0], 'w:tr')[0];
  assert.ok(on(child(child(headerRow, 'w:trPr'), 'w:tblHeader')), 'başlık satırı her sayfada yinelenir');
  assert.deepEqual(children(headerRow, 'w:tc').map((cell) => paragraphText(cell)), spec.tablolar.donem_gorev_ozeti.sutunlar);
});

test('şablon: sürüm ve kimlik belge özellikleri stil belgesiyle aynıdır', () => {
  const custom = xml('docProps/custom.xml');
  const properties = Object.fromEntries(all(custom, 'custom:property').map((node) => [node.getAttribute('name'), node.textContent]));
  assert.deepEqual(properties, spec.sablon.belge_ozellikleri);
});

test('şablon: kapak yedigeni uygulamadaki yetkili yedigen yollarını aynen kullanır ve etkin içerik taşımaz', async () => {
  const ui = await read(spec.gorseller.kapak_yedigeni.kaynak);
  const block = ui.slice(ui.indexOf('const HEPT_PATHS = ['), ui.indexOf('];', ui.indexOf('const HEPT_PATHS = [')));
  const paths = [...block.matchAll(/\{ tone: '(teal|orange)', d: '([^']+)' \}/g)];
  assert.equal(paths.length, 5, 'yetkili beş yedigen yolu');
  const svg = docx.text('word/media/kapak-yedigen.svg');
  for (const [, tone, d] of paths) {
    const stroke = paletteColor(spec.gorseller.kapak_yedigeni.renk_eslemesi[tone]);
    assert.ok(svg.includes(`<path d="${d}" stroke="#${stroke}"`), `yol ve renk korunur (${tone})`);
  }
  assert.ok(svg.includes(`fill="#${paletteColor(spec.gorseller.kapak_yedigeni.zemin)}"`));
  checkCoverSvg(xml('word/media/kapak-yedigen.svg'));
  assert.equal(contentType('word/media/kapak-yedigen.svg'), 'image/svg+xml');
  assert.equal(contentType('word/media/kapak-yedigen.png'), 'image/png');
  validateCoverPng(docx.buffer('word/media/kapak-yedigen.png'));
  checkCoverRelationships(xml('word/document.xml'), documentRelationship);
});

function checkCoverSvg(document) {
  const allowed = {
    svg: ['width', 'height', 'viewBox'],
    rect: ['fill', 'height', 'width', 'x', 'y'],
    g: ['fill', 'stroke-linejoin', 'transform'],
    path: ['d', 'stroke', 'stroke-width']
  };
  assert.equal(all(document, 'svg:svg')[0], document.documentElement, 'SVG kök öğesi');
  assert.equal([...document.childNodes].filter((node) => node.nodeType === 7).length, 0, 'SVG işlem yönergesi yasak');
  for (const element of document.getElementsByTagName('*')) {
    const attributes = allowed[element.localName];
    assert.ok(element.namespaceURI === document.documentElement.namespaceURI && Array.isArray(attributes), 'SVG öğesi yasak');
    for (const { localName, namespaceURI, value } of element.attributes) {
      if (namespaceURI === 'http://www.w3.org/2000/xmlns/') continue;
      assert.ok(namespaceURI === null && attributes.includes(localName), 'SVG özniteliği yasak');
      if (localName === 'fill' || localName === 'stroke') {
        assert.match(value, /^(?:none|#[0-9A-Fa-f]{6})$/u, 'SVG boya değeri yerel renk olmalıdır');
      }
    }
  }
  assert.equal(document.documentElement.textContent.trim(), '', 'SVG serbest metin taşımaz');
}

function checkCoverRelationships(document, relationship) {
  const anchors = all(document, 'wp:anchor');
  assert.equal(anchors.length, 1, 'tek kapak çizimi');
  const [anchor] = anchors;
  assert.ok(['1', 'true'].includes(attr(anchor, 'behindDoc')), 'kapak çizimi metnin arkasındadır');
  assert.equal(anchor.parentNode?.parentNode?.parentNode, all(document, 'w:body')[0].firstElementChild,
    'kapak çizimi ilk paragraftadır');
  const png = all(anchor, 'a:blip');
  const svg = all(anchor, 'asvg:svgBlip');
  assert.equal(png.length, 1, 'kapak PNG başvurusu');
  assert.equal(svg.length, 1, 'kapak SVG başvurusu');
  assert.ok(png[0].contains(svg[0]), 'kapak PNG ve SVG aynı çizimdedir');
  assert.equal(relationship(attr(png[0], 'r:embed'), 'image'), 'word/media/kapak-yedigen.png');
  assert.equal(relationship(attr(svg[0], 'r:embed'), 'image'), 'word/media/kapak-yedigen.svg');
}

test('şablon: çok parçalı, çakışan, tutarsız veya bozuk ZIP girdileri reddedilir', async () => {
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
});

test('şablon: geçersiz OOXML, dış ilişki, ana belge türü ve yerel olmayan alan komutu reddedilir', () => {
  for (const [name, before, after, expected] of [
    ['word/header2.xml', '</w:hdr>', '', /bozuk XML/],
    ['_rels/.rels', 'Id="rId1"', "Id='rId1' TargetMode='External'", /dış ilişki yasak/],
    ['_rels/.rels', 'Target="word/document.xml"', 'Target="word/header1.xml"', /paket kökü ana belge ilişkisi/],
    ['[Content_Types].xml', /<Override PartName="\/word\/document\.xml"[^>]*\/>/u, '', /ana belge içerik türü/],
    ['word/footer1.xml', 'w:instr=" PAGE "', 'w:instr=" UNKNOWN "', /Word alan komutları/]
  ]) {
    const original = docx.text(name);
    const changed = original.replace(before, after);
    assert.notEqual(changed, original, name + ': sınama değişikliği uygulandı');
    const copy = { ...docx, text: (part) => part === name ? changed : docx.text(part) };
    assert.throws(() => validateDocxXml(copy), expected);
  }
});

test('şablon: bölüm, kapak, numara ve üstveri sınamaları bozulmaları yakalar', () => {
  const body = () => parseDocxXml(docx.text('word/document.xml'), 'word/document.xml');
  const wrongSection = body();
  const heading = all(wrongSection, 'w:p').find((p) => paragraphStyle(p) === 'Heading1' && paragraphText(p) === spec.yapi.bolumler[2].baslik);
  const callout = heading.previousElementSibling;
  heading.parentNode.insertBefore(heading, callout);
  assert.throws(() => checkSectionPlaceholders(wrongSection), /yonetici_degerlendirmesi: bölüm yer tutucuları/);
  const wrongHeader = body();
  const section = all(wrongHeader, 'w:sectPr')[0];
  children(section, 'w:headerReference').find((node) => attr(node, 'w:type') === 'default').remove();
  assert.throws(() => checkHeaderFooter(xml, documentRelationship, section), /kapak ve gövde başvuruları/);
  const wrongCover = body();
  all(wrongCover, 'asvg:svgBlip')[0].remove();
  assert.throws(() => checkCoverRelationships(wrongCover, documentRelationship), /kapak SVG başvurusu/);
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
  const numbering = docx.text('word/numbering.xml').replace('w:val="%1"', 'w:val="%1."');
  assert.throws(() => checkNumbering(parseDocxXml(numbering, 'word/numbering.xml'), styles, body()), /başlık numarası biçimi/);
  const properties = docx.text('docProps/app.xml').replace('</Properties>', '<Company>Örnek Kurum</Company></Properties>');
  assert.throws(() => checkExtendedProperties(parseDocxXml(properties, 'docProps/app.xml')), /izinli genişletilmiş özellikler/);
});

test('şablon: PNG kapağın görüntü verisi ve parça bütünlüğü zorunludur', () => {
  const png = docx.buffer('word/media/kapak-yedigen.png');
  assert.throws(() => validateCoverPng(png.subarray(0, 24)), /PNG parça aralığı/);
  assert.throws(() => validateCoverPng(png.subarray(0, -12)), /PNG görüntü verisi veya bitişi eksik/);
  const damaged = Buffer.from(png);
  damaged[42] ^= 1;
  assert.throws(() => validateCoverPng(damaged), /PNG parça sağlama toplamı/);
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

test('model rolleri: ölçüm olmadan hiçbir model nitelikli ya da seçili ilan edilmez; denetçi yazardan bağımsızdır', () => {
  const policy = spec.model_politikasi;
  for (const [role, entry] of Object.entries(policy.roller)) {
    assert.ok(entry.nitelikli_modeller.every((id) => entry.adaylar.includes(id)), role);
    assert.ok(entry.secili == null || entry.nitelikli_modeller.includes(entry.secili), `${role}: seçili model nitelikli olmalıdır`);
    if (policy.nitelendirme.durum !== 'tamamlandi') {
      assert.deepEqual(entry.nitelikli_modeller, [], `${role}: nitelendirme tamamlanmadan nitelikli model yok`);
      assert.equal(entry.secili, null, role);
    }
  }
  const reviewer = policy.roller.bagimsiz_denetci.secili;
  for (const role of ['rapor_yazari_otomatik', 'rapor_yazari_yuksek_kalite']) {
    const writer = policy.roller[role].secili;
    if (writer && reviewer) assert.notEqual(writer, reviewer, role + ': denetçi yazardan farklıdır');
  }
  assert.equal(policy.nitelendirme.kiyas, 'test/fixtures/bilgin-executive-report-benchmark.json');
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
  const reportMigration = /bilgin.{0,8}(?:rapor|report)|(?:y[oö]netici.{0,3}rapor|executive.{0,3}report)/iu;
  for (const name of await readdir(path.join(ROOT, 'database'))) {
    if (!/^MR_Upgrade_\d{4}_.*\.sql$/u.test(name)) continue;
    const migration = await read(path.posix.join('database', name));
    assert.doesNotMatch(name + '\n' + migration, reportMigration, 'yönetici raporu için kalıcılık 4J kapsamındadır: ' + name);
  }
});
