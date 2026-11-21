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
import { JSDOM } from 'jsdom';
import yaml from 'js-yaml';
import { readDocxPackage } from './helpers/docxPackage.mjs';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

registerServerOnlyShim();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(ROOT, relative), 'utf8');
const spec = yaml.load(await read('config/ai/bilgin_rapor_stili.yaml'), { schema: yaml.CORE_SCHEMA });
const docx = await readDocxPackage(path.join(ROOT, spec.sablon.dosya));
const { validateModelRegistry } = await import('../src/domain/ai/aiModelRegistry.js');
const { DEFAULT_AI_MODEL_REGISTRY } = await import('../src/server/ai/defaultModelRegistry.js');
const operationalRegistry = JSON.parse(await read('config/ai-model-registry.onprem.json'));

const { DOMParser } = new JSDOM('').window;
const xml = (name) => new DOMParser().parseFromString(docx.text(name), 'application/xml');
const children = (element, tag) => (element ? [...element.childNodes].filter((node) => node.nodeName === tag) : []);
const child = (element, tag) => children(element, tag)[0] ?? null;
const all = (element, tag) => [...element.getElementsByTagName(tag)];
const attr = (element, name = 'w:val') => element?.getAttribute(name) ?? null;
const insideField = (node) => {
  for (let current = node.parentNode; current; current = current.parentNode) if (current.nodeName === 'w:fldSimple') return true;
  return false;
};
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

test('şablon: paket güvenlidir — makro, gömülü nesne, ActiveX ve dış bağlantı yoktur; yalnızca kapak medyası vardır', () => {
  for (const name of docx.names) {
    assert.doesNotMatch(name, /vbaProject|embeddings\/|activeX|oleObject/i, name);
  }
  assert.doesNotMatch(docx.text('[Content_Types].xml'), /macroEnabled|vbaProject|oleObject/i);
  for (const name of docx.names.filter((entry) => entry.endsWith('.rels'))) {
    assert.doesNotMatch(docx.text(name), /TargetMode="External"/, name);
  }
  assert.doesNotMatch(docx.text('word/settings.xml'), /attachedTemplate|w:updateFields/);
  assert.doesNotMatch(docx.text('word/document.xml'), /<w:object|<o:OLEObject|<w:altChunk|<w:hyperlink/);
  assert.deepEqual(docx.names.filter((name) => name.startsWith('word/media/')).sort(), [...spec.gorseller.kapak_yedigeni.medya].sort());
});

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
  assert.ok(child(sect[0], 'w:titlePg'), 'kapak farklı ilk sayfadır');
  const rels = xml('word/_rels/document.xml.rels');
  const target = (id) => all(rels, 'Relationship').find((rel) => rel.getAttribute('Id') === id).getAttribute('Target');
  for (const tag of ['w:headerReference', 'w:footerReference']) {
    const first = children(sect[0], tag).find((ref) => attr(ref, 'w:type') === 'first');
    assert.ok(first, `${tag} first`);
    const part = `word/${target(first.getAttribute('r:id'))}`;
    assert.equal(all(xml(part), 'w:t').map((node) => node.textContent).join('').trim(), '', `${part} kapakta boştur`);
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
    assert.equal(Boolean(child(rPr, 'w:b')), Boolean(entry.kalin), `${id} kalın`);
    assert.equal(Boolean(child(rPr, 'w:i')), Boolean(entry.italik), `${id} italik`);
    assert.equal(attr(child(rPr, 'w:rFonts'), 'w:asciiTheme'), entry.yazi === 'baslik' ? 'majorHAnsi' : 'minorHAnsi', `${id} yazı rolü`);
    assert.equal(attr(child(rPr, 'w:rFonts'), 'w:ascii'), null, `${id} doğrudan yazı tipi adı taşımaz`);
    const spacing = child(pPr, 'w:spacing');
    if (entry.once != null) assert.equal(attr(spacing, 'w:before'), String(Math.round(entry.once * 20)), `${id} önce`);
    if (entry.sonra != null) assert.equal(attr(spacing, 'w:after'), String(Math.round(entry.sonra * 20)), `${id} sonra`);
    if (entry.satir != null) assert.equal(attr(spacing, 'w:line'), String(Math.round(entry.satir * 240)), `${id} satır`);
    assert.equal(attr(child(pPr, 'w:jc')), entry.hiza ? JC[entry.hiza] : null, `${id} hiza`);
    assert.equal(Boolean(child(pPr, 'w:pageBreakBefore')), Boolean(entry.yeni_sayfa), `${id} yeni sayfa`);
    const borders = child(pPr, 'w:pBdr');
    for (const [key, side] of [['ust_cizgi', 'w:top'], ['sol_cizgi', 'w:left'], ['alt_cizgi', 'w:bottom']]) {
      assert.equal(attr(child(borders, side), 'w:color'), entry[key] ? paletteColor(entry[key]) : null, `${id} ${key}`);
    }
    assert.equal(attr(child(pPr, 'w:shd'), 'w:fill'), entry.golge ? paletteColor(entry.golge) : null, `${id} gölge`);
  }
  // Numaralı başlık "01" biçimi ve vurgu rengi; madde işareti lacivert.
  const numbering = xml('word/numbering.xml');
  const abstractFor = (numId) => {
    const num = all(numbering, 'w:num').find((node) => attr(node, 'w:numId') === numId);
    const abstractId = attr(child(num, 'w:abstractNumId'));
    return child(all(numbering, 'w:abstractNum').find((node) => attr(node, 'w:abstractNumId') === abstractId), 'w:lvl');
  };
  const headingLevel = abstractFor(attr(child(child(child(byId.get('Heading1'), 'w:pPr'), 'w:numPr'), 'w:numId')));
  assert.equal(attr(child(headingLevel, 'w:numFmt')), 'decimalZero');
  assert.equal(attr(child(child(headingLevel, 'w:rPr'), 'w:color')), paletteColor(spec.stiller.Heading1.numara_rengi));
  const bulletLevel = abstractFor(attr(child(child(child(byId.get('BilginListeMaddesi'), 'w:pPr'), 'w:numPr'), 'w:numId')));
  assert.equal(attr(child(bulletLevel, 'w:numFmt')), 'bullet');
  assert.equal(attr(child(child(bulletLevel, 'w:rPr'), 'w:color')), paletteColor(spec.stiller.BilginListeMaddesi.madde_rengi));
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
    for (const element of docx.text(name).match(/<w:rFonts\b[^>]*>/g) || []) {
      for (const match of element.matchAll(/w:(?:ascii|hAnsi|cs|eastAsia)="([^"]+)"/g)) assert.ok(allowed.has(match[1]), `${name}: ${match[1]}`);
    }
  }
  for (const font of all(xml('word/fontTable.xml'), 'w:font')) assert.ok(allowed.has(attr(font, 'w:name')), attr(font, 'w:name'));
  assert.equal(spec.yazi_tipi.etkin_profil, 'calibri_uyumlu', 'Nexa yalnızca kurulum/lisans doğrulanınca açılır');
});

test('şablon: kullanılan her renk kurumsal paletten ya da nötrlerdendir (kapak yedigeni dâhil)', () => {
  for (const name of docx.names.filter((entry) => /\.(xml|svg)$/.test(entry))) {
    const text = docx.text(name);
    const found = [
      ...[...text.matchAll(/w:(?:color|fill)="([^"]+)"/g)].map((match) => match[1]),
      ...[...text.matchAll(/srgbClr val="([^"]+)"/g)].map((match) => match[1]),
      ...[...text.matchAll(/(?:stroke|fill)="#([0-9A-Fa-f]{6})"/g)].map((match) => match[1])
    ];
    for (const value of found) {
      if (value === 'auto') continue;
      assert.ok(ALLOWED_COLORS.has(value.toUpperCase()), `${name}: izinli olmayan renk ${value}`);
    }
  }
});

test('şablon: yer tutucular bölünmez, stil belgesiyle bire bir aynıdır ve bölümlerinde belge sırasıyla durur', () => {
  const tokens = new Map();
  for (const name of ['word/document.xml', 'word/header1.xml', 'word/header2.xml', 'word/footer1.xml', 'word/footer2.xml']) {
    const found = [];
    for (const node of all(xml(name), 'w:t')) {
      const text = node.textContent;
      for (const match of text.matchAll(PLACEHOLDER)) found.push(match[1]);
      assert.doesNotMatch(text.replace(PLACEHOLDER, ''), /\{\{|\}\}/, `${name}: bölünmüş yer tutucu "${text}"`);
    }
    tokens.set(name, found);
  }
  const everything = new Set([...tokens.values()].flat());
  assert.deepEqual([...everything].sort(), Object.keys(spec.yer_tutucular).sort());
  const expectedOrder = spec.yapi.bolumler.flatMap((section) => section.yer_tutucular || []);
  assert.deepEqual(tokens.get('word/document.xml'), expectedOrder, 'gövde yer tutucuları bölüm sırasıyla');
  assert.deepEqual(tokens.get('word/header1.xml'), ['RAPOR_TURU', 'DONEM']);
  assert.deepEqual([...tokens.get('word/header2.xml'), ...tokens.get('word/footer1.xml'), ...tokens.get('word/footer2.xml')], []);
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
});

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
  assert.ok(child(child(headerRow, 'w:trPr'), 'w:tblHeader'), 'başlık satırı her sayfada yinelenir');
  assert.deepEqual(children(headerRow, 'w:tc').map((cell) => paragraphText(cell)), spec.tablolar.donem_gorev_ozeti.sutunlar);
});

test('şablon: sürüm ve kimlik belge özellikleri stil belgesiyle aynıdır', () => {
  const custom = xml('docProps/custom.xml');
  const properties = Object.fromEntries(all(custom, 'property').map((node) => [node.getAttribute('name'), node.textContent]));
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
  assert.doesNotMatch(svg, /<script|foreignObject|href=|\son[a-z]+=/i);
  const png = docx.buffer('word/media/kapak-yedigen.png');
  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
  // A4 oranlı kapak görseli (en ≈ boy × 210/297).
  const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  assert.ok(Math.abs(width / height - 210 / 297) < 0.002, `${width}×${height}`);
  assert.match(docx.text('word/document.xml'), /behindDoc="1"/);
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
  const writer = policy.roller.rapor_yazari_otomatik.secili;
  const reviewer = policy.roller.bagimsiz_denetci.secili;
  if (writer && reviewer) assert.notEqual(writer, reviewer);
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
  const upgrades = (await readdir(path.join(ROOT, 'database'))).filter((name) => /^MR_Upgrade_\d{4}_/.test(name)).sort();
  assert.equal(upgrades.at(-1), 'MR_Upgrade_0019_Creation_Allocations.sql', '4I-0 yeni veritabanı geçişi eklemez');
});
