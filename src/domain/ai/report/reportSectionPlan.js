import { isIsoDay } from '../isoDay.js';
import { parseIsoTimestampNanos, REPORT_DETAIL_LEVELS, REPORT_EVIDENCE_SCHEMA, snapshotBusinessDay } from './reportRequest.js';

/**
 * Bilgin Aşama 4I-B — belirlenimci yönetici raporu bölüm planı (`4i-yazim-1`, saf).
 *
 * Sunucu; hangi bölümün yazılacağına, bölüme hangi kanıtların ayrıldığına, sözcük bütçesine ve
 * kaldırılamaz bütünlük açıklamalarına karar verir. Model bu kararları değiştiremez; yalnızca
 * plandaki bölümler için özgün düzyazı üretir. Kurumsal bölüm tanımları, başlıklar ve sözcük
 * bütçeleri çağıranın verdiği kanonik stil belgesinden okunur; bu modül stil kurallarını
 * yinelemez ve dosya okumaz.
 */

export const REPORT_WRITING_CONTRACT = '4i-yazim-1';
/** Bölüm başına izin verilen en çok paragraf sayısı (planlayıcı ve taslak ayrıştırıcısında ortak sınır). */
export const MAX_PARAGRAPHS_PER_SECTION = 14;
/**
 * Stil belgesindeki toplam sözcük bütçesi için üst tavan: taslak ayrıştırıcısının ham karakter (200.000)
 * ve bölüm başı paragraf×karakter (14×4.000) sınırlarına sığmayan ulaşılamaz bütçeleri reddeder.
 */
export const MAX_STYLE_WORD_BUDGET = 12_000;

/** Sunucunun yazdığı (modelin yazmadığı) bölümler yazar planına hiç girmez. */
const MODEL_OWNER = 'model';
/** Kullanıcının kapatabileceği isteğe bağlı model bölümleri; zorunlu bölümler kapatılamaz. */
export const OPTIONAL_WRITER_SECTIONS = Object.freeze(['riskler', 'oncelikler']);
const KNOWN_WRITER_SECTIONS = Object.freeze([
  'yonetici_degerlendirmesi', 'one_cikan_gelismeler', 'faaliyetler', 'riskler', 'oncelikler', 'genel_sonuc'
]);
const SECTION_GUIDANCE = Object.freeze({
  yonetici_degerlendirmesi: 'Raporun özetidir: dönemin ana sonucunu ve yönetimin bilmesi gereken en önemli iki üç konuyu anlamlarıyla, kısa ve bütünlüklü biçimde değerlendir. Ayrıntıları burada sıralama; ayrıntılı anlatım ilgili bölümdedir.',
  one_cikan_gelismeler: 'Dönemin başarılarını ve en anlamlı ilerlemelerini, aralarındaki ilişkiyi kurarak anlat. Risk ve engellerin ayrıntısı Riskler bölümündedir (bölüm planlanmışsa); rutin güncellemeleri önemli gelişme gibi sunma.',
  faaliyetler: 'Yapılan işi ve ilerlemeyi proje ve iş akışı düzeyinde anlat; görev kayıtlarını ve notları birlikte değerlendir, kayıt alanlarını tek tek cümleye çevirme. Önceki bölümlerde ayrıntısıyla anlatılan gelişmeyi yeniden anlatma; yalnızca iş akışındaki yerini belirt.',
  riskler: 'Kanıtla desteklenen riskleri, engelleri ve bağımlılıkları; olası etkilerini ve izlenmesi gereken noktaları ölçülü dille yaz. Daha önce anlatılan olguyu yinelemek yerine etkisine ve izlemeye odaklan. Kanıtta olmayan risk üretme, kişiye suç atfetme.',
  oncelikler: 'Kanıttaki yaklaşan terminlerden, açık kritik işlerden ve bağımlılıklardan çıkan, uygulanabilir sonraki dönem önceliklerini yaz; kanıta bağlanmayan genel öneri verme.',
  genel_sonuc: 'Raporu yeni olgu eklemeden, önceki bölümleri tekrarlamadan, yönetim için net bir değerlendirmeyle kısaca kapat.'
});
const SPARSE_GUIDANCE = 'Kanıt dar: bu bölümü tek kısa paragrafla yaz. Önceki bölümlerde söyleneni yineleme; bu bölüme özgü yeni bir değerlendirme yoksa ilgili konuyu tek cümleyle anlamına bağla.';
/** Bilinen açık görev durumları; `null` veya bilinmeyen durumlar açık görev sayılmaz. */
const KNOWN_OPEN_TASK_STATUSES = Object.freeze(new Set(['baslamadi', 'devam_ediyor', 'acik', 'beklemede', 'engelli']));
/** Görev durumunun açık bir anlık durum olduğunu doğrular (planlayıcı ve istem izdüşümünde ortak kural). */
export function isKnownOpenTaskStatus(value) {
  return typeof value === 'string' && KNOWN_OPEN_TASK_STATUSES.has(value);
}
const HIGH_PRIORITIES = new Set(['critical', 'high', 'kritik', 'yuksek', 'yüksek']);
/** 4I-A `isDueWithin(..., 7)` ile aynı kapsayıcı 7 takvim günü penceresi (`bugün .. bugün + 6`). */
const DUE_SOON_WINDOW_DAYS = 7;
const MAX_SECTION_EVIDENCE = 60;
/** Plan iletisinin 32 KiB tavanını aşmaması için ayrı ayrı listelenen en çok çelişki sayısı. */
const MAX_INDIVIDUAL_CONFLICT_DISCLOSURES = 8;
const MIN_SECTION_WORDS = 60;
const SPARSE_MIN_SECTION_WORDS = 30;
/** Bu sayıda ya da daha az anlatı kanıtı (görev, not, belge, hareket, türetim) seyrek kanıttır. */
const SPARSE_EVIDENCE_ITEMS = 4;
/** Seyrek kanıtta bile anlatının toplam üst sınırı bu değerin altına inmez. */
const MIN_TOTAL_WORDS = 250;
/** Alt sözcük sınırının tam uygulandığı anlatı kanıtı sayısı (görev, not, belge, hareket ve türetim). */
const RICH_EVIDENCE_ITEMS = 12;

/** Planı kurarken gerçekleşen sözleşme ihlali; içerik değil yalnızca kararlı kod taşır. */
export class ReportPlanError extends Error {
  constructor(code, detail = null) {
    super('Yönetici raporu bölüm planı kurulamadı.');
    this.name = 'ReportPlanError';
    this.code = code;
    this.detail = detail;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function own(obj, key) {
  return isPlainObject(obj) && Object.hasOwn(obj, key) ? obj[key] : undefined;
}

function wordRange(value, maxUpper = Infinity) {
  return Array.isArray(value)
    && value.length === 2
    && value.every((n) => Number.isSafeInteger(n) && n > 0 && n <= maxUpper)
    && value[0] <= value[1];
}

function stringList(value) {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (let i = 0; i < value.length; i += 1) {
    if (!Object.hasOwn(value, i) || typeof value[i] !== 'string' || !value[i].trim()) return false;
  }
  return true;
}

/**
 * Kanonik stil belgesinden yazarın gereksindiği alt kümeyi doğrular ve dondurur.
 * Eksik ya da bozuk stil kapalı reddedilir: yazar varsayılan kurala sessizce düşmez.
 *
 * @param {object} style - `bilgin-rapor-stili` belgesinin ayrıştırılmış hâli.
 * @returns {object} Dondurulmuş yazar stil alt kümesi.
 */
export function requireWriterStyle(style) {
  if (!isPlainObject(style) || own(style, 'sema') !== 'bilgin-rapor-stili') throw new ReportPlanError('STYLE_INVALID', 'sema');
  const rawSurum = own(style, 'surum');
  if (rawSurum !== undefined && rawSurum !== null && typeof rawSurum !== 'string' && typeof rawSurum !== 'number') {
    throw new ReportPlanError('STYLE_INVALID', 'surum');
  }
  const contract = own(own(style, 'surumleme'), 'yazim_sozlesmesi_surumu');
  if (contract !== REPORT_WRITING_CONTRACT) throw new ReportPlanError('STYLE_INVALID', 'yazim_sozlesmesi_surumu');
  if (own(own(style, 'surumleme'), 'kanit_paketi_sema_surumu') !== REPORT_EVIDENCE_SCHEMA) {
    throw new ReportPlanError('STYLE_INVALID', 'kanit_paketi_sema_surumu');
  }
  const anlati = own(style, 'anlati');
  const paragraph = own(anlati, 'paragraf');
  const plan = own(anlati, 'bolum_plani');
  const budgets = own(plan, 'sozcuk_butcesi');
  const weights = own(plan, 'agirliklar');
  if (!isPlainObject(anlati) || typeof own(anlati, 'ton') !== 'string' || !stringList(own(anlati, 'zorunlu_nitelikler'))
    || !stringList(own(anlati, 'yasaklar')) || typeof own(anlati, 'belirsizlik_dili') !== 'string'
    || !wordRange(own(paragraph, 'cumle_araligi')) || !wordRange(own(paragraph, 'ortak_sozcuk_araligi'))) {
    throw new ReportPlanError('STYLE_INVALID', 'anlati');
  }
  if (!REPORT_DETAIL_LEVELS.every((level) => wordRange(own(budgets, level), MAX_STYLE_WORD_BUDGET) && typeof own(own(anlati, 'ayrinti_duzeyi'), level) === 'string')) {
    throw new ReportPlanError('STYLE_INVALID', 'anlati.bolum_plani.sozcuk_butcesi');
  }
  const sections = own(own(style, 'yapi'), 'bolumler');
  if (!Array.isArray(sections)) throw new ReportPlanError('STYLE_INVALID', 'yapi.bolumler');
  const writerSections = sections.filter((entry) => own(entry, 'sahip') === MODEL_OWNER).map((entry) => {
    const rawBaslikKisi = own(entry, 'baslik_kisi');
    if (rawBaslikKisi !== undefined && rawBaslikKisi !== null && (typeof rawBaslikKisi !== 'string' || !rawBaslikKisi.trim())) {
      throw new ReportPlanError('STYLE_INVALID', 'yapi.bolumler.baslik_kisi');
    }
    const rawZorunlu = own(entry, 'zorunlu');
    if (typeof rawZorunlu !== 'boolean') {
      throw new ReportPlanError('STYLE_INVALID', 'yapi.bolumler.zorunlu');
    }
    return {
      kimlik: own(entry, 'kimlik'),
      baslik: own(entry, 'baslik'),
      baslikKisi: rawBaslikKisi ?? null,
      zorunlu: rawZorunlu
    };
  });
  const ids = writerSections.map((entry) => entry.kimlik);
  if (ids.length !== KNOWN_WRITER_SECTIONS.length || ids.some((id, index) => id !== KNOWN_WRITER_SECTIONS[index])
    || writerSections.some((entry) => typeof entry.baslik !== 'string' || !entry.baslik.trim())) {
    throw new ReportPlanError('STYLE_INVALID', 'yapi.bolumler');
  }
  if (writerSections.some((entry) => OPTIONAL_WRITER_SECTIONS.includes(entry.kimlik) === entry.zorunlu)) {
    throw new ReportPlanError('STYLE_INVALID', 'yapi.bolumler.zorunlu');
  }
  if (!KNOWN_WRITER_SECTIONS.every((id) => Number.isSafeInteger(own(weights, id)) && own(weights, id) > 0)) {
    throw new ReportPlanError('STYLE_INVALID', 'anlati.bolum_plani.agirliklar');
  }
  const classes = own(own(style, 'kanit'), 'iddia_siniflari');
  const classNames = ['nesnel_olgu', 'desteklenen_yorum', 'editoryal_dil', 'desteksiz_maddi_iddia'];
  if (!classNames.every((name) => typeof own(own(classes, name), 'islem') === 'string')) {
    throw new ReportPlanError('STYLE_INVALID', 'kanit.iddia_siniflari');
  }
  const rules = own(own(style, 'yapi'), 'bolum_kurallari');
  if (typeof own(rules, 'dengeli_sunum') !== 'string' || typeof own(rules, 'bos_bolum') !== 'string') {
    throw new ReportPlanError('STYLE_INVALID', 'yapi.bolum_kurallari');
  }
  const rawNotlar = own(own(style, 'kanit'), 'notlar');
  if (rawNotlar !== undefined && rawNotlar !== null && !isPlainObject(rawNotlar)) {
    throw new ReportPlanError('STYLE_INVALID', 'kanit.notlar');
  }
  const rawTarihAyrimi = own(rawNotlar, 'tarih_ayrimi');
  const rawGuvenilmezVeri = own(rawNotlar, 'guvenilmez_veri');
  if ((rawTarihAyrimi !== undefined && rawTarihAyrimi !== null && typeof rawTarihAyrimi !== 'string')
    || (rawGuvenilmezVeri !== undefined && rawGuvenilmezVeri !== null && typeof rawGuvenilmezVeri !== 'string')) {
    throw new ReportPlanError('STYLE_INVALID', 'kanit.notlar');
  }
  const writerStyle = Object.freeze({
    surum: String(rawSurum ?? ''),
    ton: anlati.ton,
    zorunluNitelikler: Object.freeze([...anlati.zorunlu_nitelikler]),
    yasaklar: Object.freeze([...anlati.yasaklar]),
    belirsizlikDili: anlati.belirsizlik_dili,
    cumleAraligi: Object.freeze([...paragraph.cumle_araligi]),
    paragrafSozcukAraligi: Object.freeze([...paragraph.ortak_sozcuk_araligi]),
    ayrintiDuzeyi: Object.freeze(Object.fromEntries(REPORT_DETAIL_LEVELS.map((level) => [level, anlati.ayrinti_duzeyi[level]]))),
    sozcukButcesi: Object.freeze(Object.fromEntries(REPORT_DETAIL_LEVELS.map((level) => [level, Object.freeze([...budgets[level]])]))),
    agirliklar: Object.freeze(Object.fromEntries(KNOWN_WRITER_SECTIONS.map((id) => [id, weights[id]]))),
    bolumler: Object.freeze(writerSections.map((entry) => Object.freeze(entry))),
    iddiaSiniflari: Object.freeze(Object.fromEntries(classNames.map((name) => [name, classes[name].islem]))),
    dengeliSunum: rules.dengeli_sunum,
    bosBolum: rules.bos_bolum,
    notKurallari: Object.freeze({
      tarihAyrimi: rawTarihAyrimi ?? '',
      guvenilmezVeri: rawGuvenilmezVeri ?? ''
    })
  });
  VALIDATED_STYLES.add(writerStyle);
  return writerStyle;
}

/** Yalnızca bu modülün doğruladığı alt küme kimliğiyle tanınır; benzer biçimli sahte nesne doğrulamayı atlayamaz. */
const VALIDATED_STYLES = new WeakSet();

/**
 * Ham stil belgesini doğrular ya da daha önce doğrulanmış alt kümeyi olduğu gibi döndürür.
 *
 * @param {object} style - Ham stil belgesi ya da `requireWriterStyle` çıktısı.
 * @returns {object} Doğrulanmış yazar stil alt kümesi.
 */
export function resolveWriterStyle(style) {
  return VALIDATED_STYLES.has(style) ? style : requireWriterStyle(style);
}

/**
 * Kanıt tarih alanını (ör. `hedef_bitis`) sıkı biçimde doğrular: yalnızca tam ISO günü (`YYYY-AA-GG`)
 * veya saat dilimli geçerli ISO zaman damgası kabul edilir; kuyruk çöpü taşıyan önekler reddedilir.
 */
export function parseStrictEvidenceDay(value) {
  if (typeof value !== 'string') return null;
  if (isIsoDay(value)) return value;
  if (parseIsoTimestampNanos(value) !== null) return snapshotBusinessDay(value);
  return null;
}

function evidenceDay(value) {
  return parseStrictEvidenceDay(value);
}

function addDays(day, count) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

/** Paket kökündeki veri anının İstanbul takvim günü (4I-A sözleşmesiyle aynı dönüşüm). */
function snapshotDay(veriAni) {
  return snapshotBusinessDay(veriAni) ?? evidenceDay(veriAni);
}

function isReportPeriodItem(item, reportPeriod) {
  if (!isPlainObject(item)) return false;
  const itemPeriod = own(item, 'donem');
  if (!isPlainObject(itemPeriod)) return true;
  if (!isPlainObject(reportPeriod)) return false;
  return itemPeriod.baslangic === reportPeriod.baslangic && itemPeriod.bitis === reportPeriod.bitis;
}

function hasHighPriority(value) {
  if (typeof value !== 'string') return false;
  const raw = value.trim();
  if (!raw) return false;
  return HIGH_PRIORITIES.has(raw.toLocaleLowerCase('en-US')) || HIGH_PRIORITIES.has(raw.toLocaleLowerCase('tr-TR'));
}

function isPositiveOverdueShare(item) {
  if (!isPlainObject(item) || item.tur !== 'gecikme_payi') return false;
  if (Number.isFinite(item.deger)) return item.deger > 0;
  if (!isPlainObject(item.deger)) return false;
  return (Number.isFinite(item.deger.geciken) && item.deger.geciken > 0)
    || (Number.isFinite(item.deger.oran_yuzde) && item.deger.oran_yuzde > 0);
}

/**
 * Kanıtları yalnızca yapılandırılmış alanlara bakarak sınıflandırır. Not metni ve belge metni
 * sınıflandırmaya katılmaz: güvenilmez metin hiçbir sunucu kararını yönlendiremez.
 */
function classifyEvidence(pkg) {
  const today = snapshotDay(pkg.veri_ani);
  // 4I-A `isDueWithin(fact, today, 7)` ile aynı kapsayıcı 7 günlük pencere (`today .. today + 6`).
  const horizon = today ? addDays(today, DUE_SOON_WINDOW_DAYS - 1) : null;
  const items = pkg.kanitlar;
  const tasksByRef = new Map();
  const itemTypeById = new Map();
  const groups = {
    olcu: [], hareket: [], belge: [], not: [], gorev: [],
    tamamlanan: [], geciken: [], engelli: [], yaklasan: [], oncelikli: [], hareketli: [], bagimli: [], acikBagimli: [],
    gecikenOlcu: [], yaklasanOlcu: [], gecikmePayi: []
  };
  for (const item of items) {
    if (!isPlainObject(item) || typeof item.id !== 'string') continue;
    itemTypeById.set(item.id, item.tur);
    if (Object.hasOwn(groups, item.tur)) groups[item.tur].push(item.id);
    if (item.tur === 'olcu' && Number.isFinite(item.deger) && item.deger > 0) {
      if (item.olcu === 'geciken') groups.gecikenOlcu.push(item.id);
      if (item.olcu === 'yaklasan_7_gun') groups.yaklasanOlcu.push(item.id);
    }
    if (item.tur !== 'gorev') continue;
    if (typeof item.gorev === 'string' && !tasksByRef.has(item.gorev)) tasksByRef.set(item.gorev, item);
    // Dönem tamamlaması yalnızca üreticinin yetkili `donemde_tamamlandi` işaretinden okunur (yeniden açılan işler dâhil).
    if (item.donemde_tamamlandi === true) {
      groups.tamamlanan.push(item.id);
    }
    if (item.donemde_hareketli === true) groups.hareketli.push(item.id);
    const deps = own(item, 'bagimliliklar');
    const hasDeps = isPlainObject(deps)
      && ((Array.isArray(deps.oncul) && deps.oncul.length > 0) || (Array.isArray(deps.ardil) && deps.ardil.length > 0));
    if (hasDeps) groups.bagimli.push(item.id);

    // Kesit sonrası değişen görevlerin güncel durumu kesit anını güvenilir biçimde yansıtmaz; anlık sınıflandırmaya girmez.
    if (item.kesit_sonrasi_degisti === true) continue;
    const knownOpen = isKnownOpenTaskStatus(item.durum);
    if (item.durum === 'engelli') groups.engelli.push(item.id);
    const target = evidenceDay(item.hedef_bitis);
    if (knownOpen && target && today && target < today) groups.geciken.push(item.id);
    if (knownOpen && target && today && horizon && target >= today && target <= horizon) groups.yaklasan.push(item.id);
    if (knownOpen && (hasHighPriority(item.oncelik) || item.kilometre_tasi === true)) {
      groups.oncelikli.push(item.id);
    }
  }
  // Yalnızca açık bir iş içeren bağımlılıklar sonraki dönem önceliği ya da açık risk olarak değerlendirilir;
  // iki ucu da tamamlanmış geçmiş zincirler tek başına isteğe bağlı öncelik/risk bölümünü açmaz.
  // Hem ardıl hem öncül uçlar denetlenir: karşılıksız öncül bağlantısı da açık bağımlılık sayılır.
  for (const item of items) {
    if (!isPlainObject(item) || item.tur !== 'gorev' || !groups.bagimli.includes(item.id)) continue;
    if (item.kesit_sonrasi_degisti === true) continue;
    const deps = own(item, 'bagimliliklar');
    const openSelf = isKnownOpenTaskStatus(item.durum);
    const peerRefs = [
      ...(Array.isArray(deps?.oncul) ? deps.oncul : []),
      ...(Array.isArray(deps?.ardil) ? deps.ardil : [])
    ];
    const hasOpenPeer = peerRefs.some((ref) => {
      const peer = typeof ref === 'string' ? tasksByRef.get(ref) : null;
      return Boolean(peer && isKnownOpenTaskStatus(peer.durum) && peer.kesit_sonrasi_degisti !== true);
    });
    if (openSelf || hasOpenPeer) groups.acikBagimli.push(item.id);
  }
  for (const finding of pkg.turetilmis || []) {
    if (!isPlainObject(finding) || typeof finding.id !== 'string') continue;
    itemTypeById.set(finding.id, 'turetilmis');
    if (isPositiveOverdueShare(finding)) groups.gecikmePayi.push(finding.id);
  }
  const noteTask = new Map();
  for (const item of items) {
    if (item?.tur !== 'not') continue;
    const task = typeof item.gorev === 'string' ? tasksByRef.get(item.gorev) : null;
    if (task) noteTask.set(item.id, task.id);
  }
  return { groups, noteTask, itemTypeById };
}

function notesFor(taskIds, noteTask, allNotes) {
  const wanted = new Set(taskIds);
  return allNotes.filter((noteId) => wanted.has(noteTask.get(noteId)));
}

/**
 * Bölümün odak kanıtlarını 60 sınırına indirgerken anlatısal/özet kanıtları (not, belge, ölçü,
 * hareket, türetim) rutin görev yığınından önce korur; seçilen küme paketteki kararlı sırada döner.
 */
function uniqueOrdered(ids, order, itemTypeById) {
  const wanted = new Set(ids);
  const ordered = order.filter((id) => wanted.has(id));
  if (ordered.length <= MAX_SECTION_EVIDENCE) return ordered;
  const narrativePriority = ordered.filter((id) => itemTypeById.get(id) !== 'gorev');
  const tasks = ordered.filter((id) => itemTypeById.get(id) === 'gorev');
  const picked = new Set([
    ...narrativePriority.slice(0, MAX_SECTION_EVIDENCE),
    ...tasks.slice(0, Math.max(0, MAX_SECTION_EVIDENCE - Math.min(narrativePriority.length, MAX_SECTION_EVIDENCE)))
  ]);
  return ordered.filter((id) => picked.has(id));
}

function derivedIds(pkg, types = null) {
  return (pkg.turetilmis || []).filter((item) => isPlainObject(item) && (!types || types.includes(item.tur))).map((item) => item.id);
}

/** İlk görülen kanıt sırasını korur; bir kanıta çelişen zamanlar atanmışsa kronoloji kurulamaz. */
export function distinctConflictEvidence(references, chronology) {
  const positions = new Map();
  references.forEach((id, index) => { if (!positions.has(id)) positions.set(id, index); });
  const aligned = Array.isArray(chronology) && chronology.length === references.length
    && Array.from(references).every((id, index) => Object.hasOwn(chronology, index)
      && chronology[index] === chronology[positions.get(id)]);
  return {
    references: [...positions.keys()],
    chronology: aligned ? [...positions.values()].map((index) => chronology[index]) : null
  };
}

/**
 * Kaldırılamaz bütünlük açıklamaları: her biri ZORUNLU bir bölüme bağlanır, böylece isteğe bağlı
 * bir bölümün kapatılması tamlık, çelişki ya da kısmi görünürlük bilgisini bastıramaz.
 */
function integrityDisclosures(pkg, { groups, noteTask }, riskSectionPlanned) {
  const out = [];
  const tamlik = isPlainObject(pkg.tamlik) ? pkg.tamlik : {};
  const reportPeriod = own(pkg.istek, 'donem');
  const derived = (type) => derivedIds(pkg, [type]);
  if (tamlik.kapsam_gorunurlugu === 'partial' || derived('kismi_gorunurluk_uyarisi').length) {
    out.push({
      kimlik: 'kismi_gorunurluk', bolum: 'yonetici_degerlendirmesi',
      kanitlar: derived('kismi_gorunurluk_uyarisi'),
      yonerge: 'Kapsam görünürlüğü kısmidir: sayılar ve toplamlar yalnızca bu rapor için yetkili görünür görevlerden hesaplanmıştır. Bunu doğal dille açıkça belirt; görünmeyen işler, projeler ya da kişiler hakkında tahmin yürütme ve proje bütünü için oran üretme.'
    });
  }
  const isPartialActivityItem = (item) => isPlainObject(item)
    && (item.tur === 'hareket' || (item.tur === 'olcu' && item.olcu === 'hareket'))
    && (item.kayit_kapsami === 'partial' || (item.tur === 'olcu' && item.tamlik === 'partial'));
  const reportPeriodPartialActivityItems = pkg.kanitlar.filter((item) => isPartialActivityItem(item) && isReportPeriodItem(item, reportPeriod));
  const comparisonPartialActivityItems = pkg.kanitlar.filter((item) => isPartialActivityItem(item) && !isReportPeriodItem(item, reportPeriod));
  const partialActivity = tamlik.hareket === 'partial' || reportPeriodPartialActivityItems.length > 0;
  if (partialActivity) {
    out.push({
      kimlik: 'kismi_hareket_kaydi', bolum: 'faaliyetler',
      kanitlar: reportPeriodPartialActivityItems.map((item) => item.id),
      yonerge: 'Hareket kaydı kısmidir: hareket sayıları dönemin bütün etkinliğini göstermez. Bu sınırı belirt; kısmi kayıttan eğilim, düşüş ya da artış yorumu çıkarma.'
    });
  }
  if (comparisonPartialActivityItems.length > 0) {
    out.push({
      kimlik: 'kismi_karsilastirma_hareket_kaydi', bolum: 'faaliyetler',
      kanitlar: comparisonPartialActivityItems.map((item) => item.id),
      yonerge: 'Karşılaştırma döneminin hareket kaydı kısmidir; bu sınırı yalnızca karşılaştırma dönemiyle ilişkilendir ve rapor döneminin kendi hareket kapsamıyla karıştırma.'
    });
  }
  if (tamlik.bagimliliklar === 'partial') {
    out.push({
      kimlik: 'kismi_bagimlilik_kapsami', bolum: 'faaliyetler', kanitlar: [],
      yonerge: 'Bağımlılık kaydının kapsamı kısmidir: pakette bağımlılık bağlantısı görünmemesi bağımlılık olmadığı anlamına gelmez. Bu sınırı kısaca belirt; görünmeyen bağımlılıklar hakkında tahmin yürütme.'
    });
  }
  const clippedNotes = pkg.kanitlar.filter((item) => isPlainObject(item) && item.tur === 'not' && item.kirpildi === true).map((item) => item.id);
  const clippedCount = Number.isSafeInteger(own(own(tamlik, 'not_ozeti'), 'kirpilan')) ? tamlik.not_ozeti.kirpilan : 0;
  if (clippedCount > 0 || clippedNotes.length > 0) {
    out.push({
      kimlik: 'kirpilan_not', bolum: 'faaliyetler', kanitlar: clippedNotes.slice(0, MAX_SECTION_EVIDENCE),
      yonerge: 'Bazı görev notları uzunluk sınırı nedeniyle kırpılmıştır. Kırpılan notun kalan içeriği hakkında varsayım yapma ve ilgili değerlendirmede bu sınırı kısaca belirt.'
    });
  }
  if (Number.isSafeInteger(tamlik.tarihsiz_tamamlanan) && tamlik.tarihsiz_tamamlanan > 0) {
    out.push({
      kimlik: 'tarihsiz_tamamlanan', bolum: 'faaliyetler',
      kanitlar: [...derived('tarihsiz_tamamlanma_uyarisi'),
        ...pkg.kanitlar.filter((item) => isPlainObject(item) && item.olcu === 'history.undatedDone').map((item) => item.id)],
      yonerge: `Gerçekleşen bitiş tarihi kayıtlı olmayan ${tamlik.tarihsiz_tamamlanan} tamamlanmış görev var. Bunları belirt; hangi dönemde bittiklerini, zamanında ya da gecikmeli bittiklerini iddia etme.`
    });
  }
  if (tamlik.paket_kesildi === true) {
    out.push({
      kimlik: 'paket_kesildi', bolum: 'yonetici_degerlendirmesi', kanitlar: [],
      yonerge: 'Kanıt paketi boyut sınırları nedeniyle bütün kayıtları içermiyor. Değerlendirmenin seçilmiş kanıta dayandığını ölçülü biçimde belirt; pakette olmayan iş için "yok" ya da "yapılmadı" deme.'
    });
  }
  if (tamlik.kesit_tutarli === false) {
    out.push({
      kimlik: 'kesit_tutarsiz', bolum: 'yonetici_degerlendirmesi', kanitlar: [],
      yonerge: 'Veri kesiti sırasında bazı kayıtlar değişti; anlık durum sayılarını kesin kesit gibi sunma ve bu sınırı belirt.'
    });
  }
  const validConflicts = (pkg.celiskiler || []).filter((conflict) => isPlainObject(conflict) && Array.isArray(conflict.kanitlar));
  const itemById = new Map(pkg.kanitlar.filter((item) => isPlainObject(item) && typeof item.id === 'string').map((item) => [item.id, item]));
  // Çelişki zamanları yalnızca geçerli ISO anı (nanosaniye) ya da kesin takvim günü (YYYY-AA-GG) olarak ayrıştırılır;
  // aynı anın farklı saat dilimi yazımları (`Z` ve `+03:00`) tek anahtara indirgenir ve kuyruk çöpü reddedilir.
  const parseConflictTime = (ts) => {
    if (typeof ts !== 'string') return null;
    const trimmed = ts.trim();
    if (!trimmed) return null;
    if (isIsoDay(trimmed)) return { kind: 'day', value: trimmed };
    const nanos = parseIsoTimestampNanos(trimmed);
    return nanos !== null ? { kind: 'ns', value: nanos } : null;
  };
  // Kronolojik öncelik yalnızca karşılaştırılan TÜM kayıtlarda geçerli zaman bulunup
  // en az iki farklı zaman noktası VE tekil bir en güncel kayıt olduğunda verilir;
  // tarihsiz kayıt, seyrek dizi boşluğu ya da en son zamanı paylaşan iki kayıt varsa tek kayıt esas alınamaz.
  const hasUniqueLatestTime = (rawList) => {
    if (!Array.isArray(rawList) || rawList.length < 2) return false;
    const parsed = Array.from(rawList, (entry) => parseConflictTime(entry));
    if (parsed.some((entry) => entry === null)) return false;
    const kind = parsed[0].kind;
    if (parsed.some((entry) => entry.kind !== kind)) return false;
    const distinct = new Set(parsed.map((entry) => String(entry.value)));
    if (distinct.size < 2) return false;
    let maxVal = parsed[0].value;
    let maxCount = 1;
    for (let i = 1; i < parsed.length; i += 1) {
      const current = parsed[i].value;
      if (current > maxVal) {
        maxVal = current;
        maxCount = 1;
      } else if (current === maxVal) {
        maxCount += 1;
      }
    }
    return maxCount === 1;
  };
  const hasOrderableConflictTime = (conflict) => {
    // Farklı görevlere ait iki güncel notun yazım zamanı farkı (`notlar_arasi_celiski`) durum değişimi kanıtı değildir.
    if (conflict.tur === 'notlar_arasi_celiski') return false;
    const evidence = distinctConflictEvidence(conflict.kanitlar, conflict.kronoloji);
    if (Array.isArray(conflict.kronoloji)) return hasUniqueLatestTime(evidence.chronology);
    const writeTimes = evidence.references
      .map((id) => itemById.get(id))
      .map((item) => (isPlainObject(item) ? (item.kayit_zamani ?? null) : null));
    return hasUniqueLatestTime(writeTimes);
  };
  const orderedConflictGuidance = 'Bu kanıtlar birbiriyle çelişiyor. Çelişkiyi zaman sırasıyla açıkça anlat ve en güncel kaydı esas al; değişikliği söyle, hangisinin doğru olduğuna kanıt ötesinde karar verme ve yeni tarih uydurma.';
  const undatedConflictGuidance = 'Bu kanıtlar birbiriyle çelişiyor ancak kayıtlar arasında kesin bir zaman sırası bulunmuyor. Zaman sırası uydurmadan karşıt bildirimleri eşit mesafeyle aktar; kanıt ötesinde taraf seçme ve yeni tarih uydurma.';
  validConflicts.slice(0, MAX_INDIVIDUAL_CONFLICT_DISCLOSURES).forEach((conflict, index) => {
    const ordered = hasOrderableConflictTime(conflict);
    out.push({
      kimlik: `celiski_${index + 1}`, bolum: 'faaliyetler', kanitlar: [...conflict.kanitlar],
      yonerge: index === 0
        ? (ordered ? orderedConflictGuidance : undatedConflictGuidance)
        : (ordered
          ? 'Aynı çelişki kuralıyla bu kanıt çiftini de zaman sırasıyla ve taraf seçmeden işle.'
          : 'Aynı çelişki kuralıyla bu kanıt çiftinde zaman sırası uydurmadan karşıt bildirimleri taraf seçmeden aktar.')
    });
  });
  if (validConflicts.length > MAX_INDIVIDUAL_CONFLICT_DISCLOSURES) {
    const remaining = validConflicts.slice(MAX_INDIVIDUAL_CONFLICT_DISCLOSURES);
    const remainingOrdered = remaining.filter(hasOrderableConflictTime);
    const remainingNeutral = remaining.filter((c) => !hasOrderableConflictTime(c));
    if (remainingOrdered.length > 0) {
      const orderedRefs = [...new Set(remainingOrdered.flatMap((c) => c.kanitlar))].slice(0, MAX_SECTION_EVIDENCE);
      out.push({
        kimlik: 'celiski_diger', bolum: 'faaliyetler', kanitlar: orderedRefs,
        yonerge: `Pakette ayrıca kesin zaman sırası belirli ${remainingOrdered.length} çelişki kaydı daha var (toplam ${validConflicts.length}); bunları zaman sırasıyla ve taraf seçmeden işle.`
      });
    }
    if (remainingNeutral.length > 0) {
      const neutralRefs = [...new Set(remainingNeutral.flatMap((c) => c.kanitlar))].slice(0, MAX_SECTION_EVIDENCE);
      out.push({
        kimlik: remainingOrdered.length > 0 ? 'celiski_diger_zamansiz' : 'celiski_diger',
        bolum: 'faaliyetler',
        kanitlar: neutralRefs,
        yonerge: `Pakette ayrıca kesin zaman sırası bulunmayan ${remainingNeutral.length} çelişki kaydı daha var (toplam ${validConflicts.length}); zaman sırası uydurmadan karşıt bildirimleri eşit mesafeyle ve taraf seçmeden aktar.`
      });
    }
  }
  const comparisonRequested = pkg.istek.karsilastirma && pkg.istek.karsilastirma !== 'yok';
  if (comparisonRequested && !derived('karsilastirma').length) {
    out.push({
      kimlik: 'karsilastirma_kurulamadi', bolum: 'yonetici_degerlendirmesi', kanitlar: [],
      yonerge: 'Karşılaştırma istendi ancak karşılaştırılabilir yetkili kanıt yok. Karşılaştırmanın kurulamadığını kısaca belirt; fark ya da yüzde üretme.'
    });
  }
  const riskEvidence = [
    ...groups.geciken,
    ...groups.engelli,
    ...groups.gecikenOlcu,
    ...groups.gecikmePayi,
    ...validConflicts.flatMap((c) => c.kanitlar)
  ];
  const priorityNotes = notesFor(groups.oncelikli, noteTask, groups.not);
  const openDepEvidence = groups.acikBagimli;
  const noteOrDepRiskEvidence = [...priorityNotes, ...openDepEvidence];
  const overdueMeasures = pkg.kanitlar.filter((item) => isPlainObject(item) && typeof item.id === 'string' && item.tur === 'olcu' && item.olcu === 'geciken');
  const unknownOverdueMeasures = overdueMeasures.filter((item) => item.deger === null || item.tamlik === 'partial');
  const overdueUnknown = unknownOverdueMeasures.length > 0;
  const unknownOverdueIds = unknownOverdueMeasures.map((item) => item.id);
  const scopeRestricted = tamlik.kapsam_gorunurlugu === 'partial' || tamlik.paket_kesildi === true || tamlik.kesit_tutarli === false;
  const focus = pkg.istek.odak ?? 'dengeli';
  // Kanonik stil kuralı: maddi risk, gecikme, engelli iş ya da çelişki varsa Riskler bölümü açık olsa da Yönetici Değerlendirmesi'nde anılır.
  if (riskEvidence.length) {
    out.push({
      kimlik: 'dengeli_sunum', bolum: 'yonetici_degerlendirmesi', kanitlar: [...new Set(riskEvidence)].slice(0, 12),
      yonerge: 'Kanıtta yönetim dikkati gerektiren risk, gecikme, engelli iş ya da çelişki var. Odak tercihi ya da kapatılan bölüm ne olursa olsun bu konuyu Yönetici Değerlendirmesi içinde en az bir kez açıkça an.'
    });
  } else if (noteOrDepRiskEvidence.length > 0) {
    // Riskler bölümü açık ya da kapalı olsun, öncelikli iş notundaki olası engel veya açık bağımlılık Yönetici Değerlendirmesi'ne koşullu taşınır.
    const parts = overdueUnknown
      ? ['Geciken iş sayısı kanıtta bilinmiyor ya da kısmi durumda; gecikme olmadığını varsayma ve bu sınırı açıkça belirt.']
      : ['Yapılandırılmış görev kayıtlarında gecikme ya da çelişki görünmüyor.'];
    if (priorityNotes.length > 0) {
      parts.push('Öncelikli işlere ait notlarda açıkça bir engel ya da risk bildiriliyorsa bunu kesinleşmiş olgu gibi değil yalnızca not bildirimi olarak kısaca aktar; olağan ilerleme bildiren notları risk gibi sunma.');
    }
    if (openDepEvidence.length > 0) {
      parts.push('Açık bağımlılıkları kesinleşmiş engel değil bağımlılık gözlemi olarak ayrı ve ölçülü biçimde değerlendir.');
    }
    const refs = [...new Set([...noteOrDepRiskEvidence, ...unknownOverdueIds])].slice(0, 12);
    out.push({
      kimlik: 'dengeli_sunum', bolum: 'yonetici_degerlendirmesi', kanitlar: refs,
      yonerge: parts.join(' ')
    });
  } else if (focus === 'riskler' && !riskSectionPlanned) {
    if (overdueUnknown) {
      out.push({
        kimlik: 'risk_odagi_gecikme_bilinmiyor', bolum: 'yonetici_degerlendirmesi', kanitlar: unknownOverdueIds,
        yonerge: 'Rapor risk odağıyla istendi ancak geciken iş sayısı kanıtta bilinmiyor ya da kısmi durumda. Gecikme olmadığını varsayma; gecikme ölçüsünün belirlenemediğini açıkça belirt.'
      });
    } else {
      const scopeQualifier = scopeRestricted
        ? ' Bu saptamayı yalnızca görünür ve pakete giren kayıtlarla sınırla; görünmeyen işler hakkında risk olmadığı sonucu çıkarma.'
        : '';
      out.push({
        kimlik: 'risk_odagi_risk_yok', bolum: 'yonetici_degerlendirmesi', kanitlar: [],
        yonerge: (groups.not.length > 0
          ? 'Rapor risk odağıyla istendi ancak yapılandırılmış görünür kayıtlarda gecikme ya da kayıtlı çelişki yok. Görev notlarında bildirilen bir engel de yoksa bunu açık ve kısa biçimde söyle; varsa yalnızca not bildirimi olarak aktar, odak tercihi nedeniyle risk üretme.'
          : 'Rapor risk odağıyla istendi ancak görünür kanıtta yönetim dikkati gerektiren gecikme, çelişki ya da kayıtlı engel yok. Bunu açık ve kısa biçimde söyle; odak tercihi nedeniyle risk üretme.')
          + scopeQualifier
      });
    }
  }
  const completedMeasures = pkg.kanitlar.filter((item) => isPlainObject(item) && typeof item.id === 'string' && item.tur === 'olcu' && item.olcu === 'tamamlanan' && isReportPeriodItem(item, reportPeriod));
  const activityMeasures = pkg.kanitlar.filter((item) => isPlainObject(item) && typeof item.id === 'string' && item.tur === 'olcu' && item.olcu === 'hareket' && isReportPeriodItem(item, reportPeriod));
  const hasPositiveReportPeriodSummary = pkg.kanitlar.some((item) => (
    isPlainObject(item)
    && item.tur === 'hareket'
    && isReportPeriodItem(item, reportPeriod)
    && isPlainObject(item.donem_ozeti)
    && (
      (Number.isFinite(item.donem_ozeti.toplam_hareket) && item.donem_ozeti.toplam_hareket > 0)
      || (Number.isFinite(item.donem_ozeti.tamamlanan_gorev) && item.donem_ozeti.tamamlanan_gorev > 0)
      || (Number.isFinite(item.donem_ozeti.olusturulan_gorev) && item.donem_ozeti.olusturulan_gorev > 0)
    )
  ));
  const completedExplicitZero = completedMeasures.length > 0
    && completedMeasures.every((item) => item.deger === 0 && item.tamlik !== 'partial');
  const completionCompatibleWithZero = completedMeasures.length === 0 || completedExplicitZero;
  const activityExplicitZero = activityMeasures.length > 0
    && activityMeasures.every((item) => item.deger === 0 && item.kayit_kapsami !== 'partial' && item.tamlik !== 'partial');
  if (activityExplicitZero
    && !hasPositiveReportPeriodSummary
    && !partialActivity && tamlik.kapsam_gorunurlugu !== 'partial'
    && tamlik.paket_kesildi !== true && tamlik.kesit_tutarli !== false
    && groups.tamamlanan.length === 0 && groups.hareketli.length === 0
    && completionCompatibleWithZero) {
    out.push({
      kimlik: 'degisiklik_yok', bolum: 'yonetici_degerlendirmesi',
      kanitlar: [...activityMeasures.map((item) => item.id), ...completedMeasures.map((item) => item.id)],
      yonerge: completedExplicitZero
        ? 'Dönemde kayda geçen değişiklik ve tamamlanan görev yok. Bunu dürüst ve kısa biçimde söyle; dolgu metni, uydurma etkinlik ya da varsayılan ilerleme yazma.'
        : 'Dönemde hareket kaydına geçen bir değişiklik bulunmuyor. Bunu dürüst ve kısa biçimde söyle; dolgu metni, uydurma etkinlik ya da varsayılan ilerleme yazma.'
    });
  }
  return out;
}

function roundTo(value, step) {
  return Math.max(step, Math.round(value / step) * step);
}

/**
 * Kanıt paketi ve rapor seçeneklerinden belirlenimci bölüm planını kurar.
 *
 * @param {object} evidencePackage - Doğrulanmış `4i-kanit-1` kanıt paketi.
 * @param {object} style - `requireWriterStyle` ile doğrulanmış (ya da ham) stil belgesi.
 * @param {{ kapaliBolumler?: string[] }} [options] - Kullanıcının kapattığı isteğe bağlı bölümler.
 * @returns {object} Dondurulmuş bölüm planı.
 */
export function buildReportSectionPlan(evidencePackage, style, { kapaliBolumler = [] } = {}) {
  const writerStyle = resolveWriterStyle(style);
  if (!isPlainObject(evidencePackage) || evidencePackage.sema !== REPORT_EVIDENCE_SCHEMA
    || !isPlainObject(evidencePackage.istek) || !Array.isArray(evidencePackage.kanitlar)) {
    throw new ReportPlanError('EVIDENCE_INVALID');
  }
  const hasAnyEvidenceId = evidencePackage.kanitlar.some((item) => isPlainObject(item) && typeof item.id === 'string')
    || (Array.isArray(evidencePackage.turetilmis) && evidencePackage.turetilmis.some((item) => isPlainObject(item) && typeof item.id === 'string'));
  if (!hasAnyEvidenceId) {
    throw new ReportPlanError('EVIDENCE_EMPTY');
  }
  if (!Array.isArray(kapaliBolumler)) {
    throw new ReportPlanError('SECTION_OPTION_INVALID');
  }
  // Seyrek dizilerdeki boş yuvalar `.some()` tarafından atlanmamalıdır; her dizin açıkça doğrulanır.
  for (let i = 0; i < kapaliBolumler.length; i += 1) {
    if (!Object.hasOwn(kapaliBolumler, i) || !OPTIONAL_WRITER_SECTIONS.includes(kapaliBolumler[i])) {
      throw new ReportPlanError('SECTION_OPTION_INVALID');
    }
  }
  const pkg = evidencePackage;
  const detail = REPORT_DETAIL_LEVELS.includes(pkg.istek.ayrinti) ? pkg.istek.ayrinti : 'standart';
  const scopeType = own(pkg.istek.kapsam, 'tur');
  const reportPeriod = own(pkg.istek, 'donem');
  const classified = classifyEvidence(pkg);
  const { groups, noteTask, itemTypeById } = classified;
  const order = pkg.kanitlar
    .filter((item) => isPlainObject(item) && typeof item.id === 'string')
    .map((item) => item.id);
  const derivedAll = derivedIds(pkg);
  const conflictIds = (pkg.celiskiler || []).flatMap((conflict) => (Array.isArray(conflict?.kanitlar) ? conflict.kanitlar : []));
  const refOrder = [...order, ...derivedAll];

  const highlightsPrimary = [...groups.tamamlanan, ...notesFor(groups.tamamlanan, noteTask, groups.not), ...groups.hareketli,
    ...notesFor(groups.hareketli, noteTask, groups.not), ...groups.belge, ...derivedIds(pkg, ['kilometre_tasi_ozeti', 'karsilastirma'])];
  // Belge ya da karşılaştırma olsa da görev satırları yokken dönem toplamları öne çıkan gelişmelere girer.
  const highlightsAggregates = groups.tamamlanan.length > 0
    ? []
    : [
      ...pkg.kanitlar.filter((item) => {
        if (!isPlainObject(item) || typeof item.id !== 'string' || !isReportPeriodItem(item, reportPeriod)) return false;
        if (item.tur === 'olcu' && item.olcu === 'tamamlanan' && Number.isFinite(item.deger) && item.deger > 0) return true;
        if (item.tur === 'hareket' && isPlainObject(item.donem_ozeti)) {
          const completedCount = item.donem_ozeti.tamamlanan_gorev;
          const createdCount = item.donem_ozeti.olusturulan_gorev;
          return (Number.isFinite(completedCount) && completedCount > 0) || (Number.isFinite(createdCount) && createdCount > 0);
        }
        return false;
      }).map((item) => item.id)
    ];
  const highlights = [...highlightsAggregates, ...highlightsPrimary];

  const allocation = {
    yonetici_degerlendirmesi: [...groups.olcu, ...derivedAll, ...groups.tamamlanan, ...groups.geciken, ...groups.engelli, ...groups.oncelikli, ...conflictIds],
    one_cikan_gelismeler: highlights.length > 0 ? highlights : groups.not,
    faaliyetler: [...groups.olcu, ...groups.hareket, ...groups.gorev, ...groups.not, ...groups.belge],
    // Açık engelli/kritik/yüksek öncelikli işlerin notları, açık bağımlılıklar ve pozitif gecikme ölçüsü/payı risk bölümünü besler;
    // veri kalitesi/tamlık uyarıları kendi zorunlu bölümlerinde bildirildiğinden isteğe bağlı Riskler bölümünü tek başına açmaz.
    riskler: [...groups.geciken, ...groups.engelli, ...groups.gecikenOlcu, ...groups.gecikmePayi,
      ...notesFor([...groups.geciken, ...groups.engelli], noteTask, groups.not), ...conflictIds,
      ...groups.acikBagimli, ...notesFor(groups.oncelikli, noteTask, groups.not)],
    oncelikler: [...groups.yaklasan, ...groups.yaklasanOlcu, ...groups.oncelikli, ...groups.acikBagimli, ...notesFor(groups.yaklasan, noteTask, groups.not)],
    genel_sonuc: [...groups.olcu, ...derivedAll, ...groups.geciken, ...groups.engelli, ...groups.yaklasan]
  };

  const included = writerStyle.bolumler.filter((section) => {
    if (section.zorunlu) return true;
    if (kapaliBolumler.includes(section.kimlik)) return false;
    // Stil kuralı: dönemde verisi olmayan isteğe bağlı bölüm başlığıyla birlikte kaldırılır.
    return allocation[section.kimlik].length > 0;
  });
  const riskPlanned = included.some((section) => section.kimlik === 'riskler');
  const disclosures = integrityDisclosures(pkg, classified, riskPlanned);

  const [styleMin, styleMax] = writerStyle.sozcukButcesi[detail];
  // Bütçe kanıt yoğunluğuyla orantılıdır: dar kanıtta hem alt hem üst sınır düşer, ancak stil tavanını (`styleMax`) asla aşmaz.
  const richness = groups.gorev.length + groups.not.length + groups.belge.length + groups.hareket.length + derivedAll.length;
  const sparse = richness <= SPARSE_EVIDENCE_ITEMS;
  const rawSectionFloor = sparse ? SPARSE_MIN_SECTION_WORDS : MIN_SECTION_WORDS;
  const perSectionCap = Math.max(1, Math.floor(styleMax / Math.max(1, included.length)));
  const compactBudget = styleMax < included.length * 10;
  const step = compactBudget ? 1 : 10;
  const sectionFloor = compactBudget
    ? Math.max(1, Math.min(rawSectionFloor, perSectionCap))
    : Math.max(10, Math.min(rawSectionFloor, perSectionCap));
  const totalMin = Math.min(styleMax, Math.max(sectionFloor * 2, roundTo(styleMin * Math.min(1, (richness + 3) / RICH_EVIDENCE_ITEMS), step)));
  const minTotalCap = Math.min(MIN_TOTAL_WORDS, styleMax);
  let totalMax = Math.min(styleMax, Math.max(totalMin, minTotalCap, roundTo(styleMax * Math.min(1, (richness + 2) / RICH_EVIDENCE_ITEMS), step)));
  const weightSum = included.reduce((sum, section) => sum + writerStyle.agirliklar[section.kimlik], 0);
  const [paraMin, paraMax] = writerStyle.paragrafSozcukAraligi;

  // Bölüm sözcük aralıkları ile toplam bütçenin çelişmemesi için yuvarlama ve taban farkları uzlaştırılır:
  // sum(min) <= totalMax <= styleMax ve sum(max) >= totalMin değişmezleri her geçerli stilde korunur.
  const rawRanges = included.map((section) => {
    const share = writerStyle.agirliklar[section.kimlik] / weightSum;
    const min = Math.max(sectionFloor, roundTo(totalMin * share, step));
    const max = Math.max(min, roundTo(totalMax * share, step));
    return { section, weight: writerStyle.agirliklar[section.kimlik], min, max };
  });
  let sumMin = rawRanges.reduce((sum, item) => sum + item.min, 0);
  if (sumMin > styleMax) {
    // Dar bütçede bölüm alt sınırlarının toplamı stil tavanını aşamaz; en büyük paylardan başlayarak aşağı çekilir.
    const byMinDesc = [...rawRanges].sort((a, b) => b.min - a.min || a.weight - b.weight);
    let excess = sumMin - styleMax;
    let cursor = 0;
    while (excess > 0) {
      const entry = byMinDesc[cursor % byMinDesc.length];
      if (entry.min > 1) {
        const drop = Math.min(entry.min - 1, excess);
        entry.min -= drop;
        if (entry.max > styleMax) entry.max = styleMax;
        if (entry.max < entry.min) entry.max = entry.min;
        excess -= drop;
      } else if (byMinDesc.every((e) => e.min <= 1)) {
        break;
      }
      cursor += 1;
    }
    sumMin = rawRanges.reduce((sum, item) => sum + item.min, 0);
  }
  if (totalMax < sumMin) totalMax = Math.min(styleMax, sumMin);
  let sumMax = rawRanges.reduce((sum, item) => sum + item.max, 0);
  if (sumMax > styleMax && compactBudget) {
    const byMaxDesc = [...rawRanges].sort((a, b) => b.max - a.max);
    let excess = sumMax - styleMax;
    let cursor = 0;
    while (excess > 0) {
      const entry = byMaxDesc[cursor % byMaxDesc.length];
      if (entry.max > entry.min) {
        const drop = Math.min(entry.max - entry.min, excess);
        entry.max -= drop;
        excess -= drop;
      } else if (byMaxDesc.every((e) => e.max <= e.min)) {
        break;
      }
      cursor += 1;
    }
    sumMax = rawRanges.reduce((sum, item) => sum + item.max, 0);
  }
  if (sumMax < totalMin) {
    const byWeightDesc = [...rawRanges].sort((a, b) => b.weight - a.weight);
    let deficit = totalMin - sumMax;
    let cursor = 0;
    while (deficit > 0) {
      const add = Math.min(step, deficit);
      byWeightDesc[cursor % byWeightDesc.length].max += add;
      deficit -= add;
      cursor += 1;
    }
    sumMax = totalMin;
  }

  const sections = rawRanges.map(({ section, min, max }) => {
    const paraLow = sparse ? 1 : Math.min(MAX_PARAGRAPHS_PER_SECTION, Math.max(1, Math.floor(min / paraMax)));
    const paraHigh = sparse ? 1 : Math.min(MAX_PARAGRAPHS_PER_SECTION, Math.max(paraLow, Math.ceil(max / paraMin)));
    const focusEvidence = uniqueOrdered(allocation[section.kimlik], refOrder, itemTypeById);
    const isEmptyMandatoryContentSection = section.zorunlu
      && (section.kimlik === 'one_cikan_gelismeler' || section.kimlik === 'faaliyetler')
      && focusEvidence.length === 0;
    const baseGuidance = isEmptyMandatoryContentSection
      ? `${writerStyle.bosBolum} Bu bölüm için görünür kanıtta aktarılacak bir gelişme ya da kayıt yok; bunu kapsam sınırını koruyarak tek kısa ifadeyle belirt ve yeni etkinlik uydurma.`
      : SECTION_GUIDANCE[section.kimlik];
    return Object.freeze({
      kimlik: section.kimlik,
      baslik: scopeType === 'kisi' && section.baslikKisi ? section.baslikKisi : section.baslik,
      zorunlu: section.zorunlu,
      sozcuk_araligi: Object.freeze([min, max]),
      paragraf_araligi: Object.freeze([paraLow, paraHigh]),
      yonerge: sparse ? `${baseGuidance} ${SPARSE_GUIDANCE}` : baseGuidance,
      odak_kanitlar: Object.freeze(focusEvidence),
      zorunlu_aciklamalar: Object.freeze(disclosures.filter((entry) => entry.bolum === section.kimlik)
        .map((entry) => Object.freeze({ ...entry, kanitlar: Object.freeze([...new Set(entry.kanitlar)]) }))),
      one_cikan_tespit: section.kimlik === 'yonetici_degerlendirmesi'
    });
  });
  if (!sections.length) throw new ReportPlanError('PLAN_EMPTY');
  return Object.freeze({
    sozlesme: REPORT_WRITING_CONTRACT,
    stil_surumu: writerStyle.surum,
    ayrinti: detail,
    ayrinti_yonergesi: writerStyle.ayrintiDuzeyi[detail],
    kanit_yogunlugu: sparse ? 'seyrek' : 'normal',
    odak: pkg.istek.odak ?? 'dengeli',
    sozcuk_araligi: Object.freeze([totalMin, totalMax]),
    bolumler: Object.freeze(sections),
    kapali_bolumler: Object.freeze([...new Set(kapaliBolumler)]),
    notlar: pkg.istek.notlar === 'dahil' ? 'dahil' : 'haric'
  });
}
