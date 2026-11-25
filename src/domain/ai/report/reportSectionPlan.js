import { REPORT_DETAIL_LEVELS, REPORT_EVIDENCE_SCHEMA } from './reportRequest.js';

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
const TASK_DONE = 'tamamlandi';
const HIGH_PRIORITIES = new Set(['critical', 'high', 'kritik', 'yuksek']);
const MAX_SECTION_EVIDENCE = 60;
const MIN_SECTION_WORDS = 60;
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

function wordRange(value) {
  return Array.isArray(value) && value.length === 2 && value.every((n) => Number.isSafeInteger(n) && n > 0) && value[0] <= value[1];
}

function stringList(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim());
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
  if (!REPORT_DETAIL_LEVELS.every((level) => wordRange(own(budgets, level)) && typeof own(own(anlati, 'ayrinti_duzeyi'), level) === 'string')) {
    throw new ReportPlanError('STYLE_INVALID', 'anlati.bolum_plani.sozcuk_butcesi');
  }
  const sections = own(own(style, 'yapi'), 'bolumler');
  if (!Array.isArray(sections)) throw new ReportPlanError('STYLE_INVALID', 'yapi.bolumler');
  const writerSections = sections.filter((entry) => own(entry, 'sahip') === MODEL_OWNER).map((entry) => ({
    kimlik: own(entry, 'kimlik'),
    baslik: own(entry, 'baslik'),
    baslikKisi: own(entry, 'baslik_kisi') ?? null,
    zorunlu: own(entry, 'zorunlu') === true
  }));
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
  const writerStyle = Object.freeze({
    surum: String(own(style, 'surum') ?? ''),
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
      tarihAyrimi: String(own(own(own(style, 'kanit'), 'notlar'), 'tarih_ayrimi') ?? ''),
      guvenilmezVeri: String(own(own(own(style, 'kanit'), 'notlar'), 'guvenilmez_veri') ?? '')
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

function evidenceDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/u.test(value) ? value.slice(0, 10) : null;
}

function addDays(day, count) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

/** Paket kökündeki veri anının İstanbul takvim günü (paket ISO yerel saat farkını taşır). */
function snapshotDay(veriAni) {
  return evidenceDay(veriAni);
}

/**
 * Kanıtları yalnızca yapılandırılmış alanlara bakarak sınıflandırır. Not metni ve belge metni
 * sınıflandırmaya katılmaz: güvenilmez metin hiçbir sunucu kararını yönlendiremez.
 */
function classifyEvidence(pkg) {
  const period = pkg.istek.donem;
  const today = snapshotDay(pkg.veri_ani);
  const horizon = today ? addDays(today, 7) : null;
  const items = pkg.kanitlar;
  const tasksByRef = new Map();
  const groups = {
    olcu: [], hareket: [], belge: [], not: [], gorev: [],
    tamamlanan: [], geciken: [], yaklasan: [], oncelikli: [], hareketli: [], bagimli: []
  };
  for (const item of items) {
    if (!isPlainObject(item) || typeof item.id !== 'string') continue;
    if (Object.hasOwn(groups, item.tur)) groups[item.tur].push(item.id);
    if (item.tur !== 'gorev') continue;
    if (typeof item.gorev === 'string') tasksByRef.set(item.gorev, item);
    const done = item.durum === TASK_DONE;
    const finished = evidenceDay(item.gerceklesen_bitis);
    const target = evidenceDay(item.hedef_bitis);
    if (done && (item.donemde_tamamlandi === true || (finished && finished >= period.baslangic && finished <= period.bitis))) {
      groups.tamamlanan.push(item.id);
    }
    if (!done && target && today && target < today) groups.geciken.push(item.id);
    if (!done && target && today && horizon && target >= today && target <= horizon) groups.yaklasan.push(item.id);
    if (!done && (HIGH_PRIORITIES.has(String(item.oncelik ?? '').toLocaleLowerCase('tr-TR')) || item.kilometre_tasi === true)) {
      groups.oncelikli.push(item.id);
    }
    if (item.donemde_hareketli === true) groups.hareketli.push(item.id);
    const deps = own(item, 'bagimliliklar');
    if (isPlainObject(deps) && ((Array.isArray(deps.oncul) && deps.oncul.length) || (Array.isArray(deps.ardil) && deps.ardil.length))) {
      groups.bagimli.push(item.id);
    }
  }
  const noteTask = new Map();
  for (const item of items) {
    if (item?.tur !== 'not') continue;
    const task = typeof item.gorev === 'string' ? tasksByRef.get(item.gorev) : null;
    if (task) noteTask.set(item.id, task.id);
  }
  return { groups, noteTask };
}

function notesFor(taskIds, noteTask, allNotes) {
  const wanted = new Set(taskIds);
  return allNotes.filter((noteId) => wanted.has(noteTask.get(noteId)));
}

function uniqueOrdered(ids, order) {
  const wanted = new Set(ids);
  return order.filter((id) => wanted.has(id)).slice(0, MAX_SECTION_EVIDENCE);
}

function derivedIds(pkg, types = null) {
  return (pkg.turetilmis || []).filter((item) => isPlainObject(item) && (!types || types.includes(item.tur))).map((item) => item.id);
}

/**
 * Kaldırılamaz bütünlük açıklamaları: her biri ZORUNLU bir bölüme bağlanır, böylece isteğe bağlı
 * bir bölümün kapatılması tamlık, çelişki ya da kısmi görünürlük bilgisini bastıramaz.
 */
function integrityDisclosures(pkg, { groups }, riskSectionPlanned) {
  const out = [];
  const tamlik = isPlainObject(pkg.tamlik) ? pkg.tamlik : {};
  const derived = (type) => derivedIds(pkg, [type]);
  if (tamlik.kapsam_gorunurlugu === 'partial' || derived('kismi_gorunurluk_uyarisi').length) {
    out.push({
      kimlik: 'kismi_gorunurluk', bolum: 'yonetici_degerlendirmesi',
      kanitlar: derived('kismi_gorunurluk_uyarisi'),
      yonerge: 'Kapsam görünürlüğü kısmidir: sayılar ve toplamlar yalnızca bu rapor için yetkili görünür görevlerden hesaplanmıştır. Bunu doğal dille açıkça belirt; görünmeyen işler, projeler ya da kişiler hakkında tahmin yürütme ve proje bütünü için oran üretme.'
    });
  }
  const partialActivity = tamlik.hareket === 'partial'
    || pkg.kanitlar.some((item) => isPlainObject(item) && item.kayit_kapsami === 'partial');
  if (partialActivity) {
    out.push({
      kimlik: 'kismi_hareket_kaydi', bolum: 'faaliyetler',
      kanitlar: pkg.kanitlar.filter((item) => isPlainObject(item) && item.kayit_kapsami === 'partial').map((item) => item.id),
      yonerge: 'Hareket kaydı kısmidir: hareket sayıları dönemin bütün etkinliğini göstermez. Bu sınırı belirt; kısmi kayıttan eğilim, düşüş ya da artış yorumu çıkarma.'
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
  (pkg.celiskiler || []).forEach((conflict, index) => {
    if (!isPlainObject(conflict) || !Array.isArray(conflict.kanitlar)) return;
    out.push({
      kimlik: `celiski_${index + 1}`, bolum: 'faaliyetler', kanitlar: [...conflict.kanitlar],
      yonerge: 'Bu kanıtlar birbiriyle çelişiyor. Çelişkiyi zaman sırasıyla açıkça anlat ve en güncel kaydı esas al; değişikliği söyle, hangisinin doğru olduğuna kanıt ötesinde karar verme ve yeni tarih uydurma.'
    });
  });
  const comparisonRequested = pkg.istek.karsilastirma && pkg.istek.karsilastirma !== 'yok';
  if (comparisonRequested && !derived('karsilastirma').length) {
    out.push({
      kimlik: 'karsilastirma_kurulamadi', bolum: 'yonetici_degerlendirmesi', kanitlar: [],
      yonerge: 'Karşılaştırma istendi ancak karşılaştırılabilir yetkili kanıt yok. Karşılaştırmanın kurulamadığını kısaca belirt; fark ya da yüzde üretme.'
    });
  }
  const riskEvidence = [...groups.geciken, ...(pkg.celiskiler || []).flatMap((c) => (Array.isArray(c?.kanitlar) ? c.kanitlar : []))];
  const focus = pkg.istek.odak ?? 'dengeli';
  if (riskEvidence.length && (!riskSectionPlanned || focus === 'basarilar')) {
    out.push({
      kimlik: 'dengeli_sunum', bolum: 'yonetici_degerlendirmesi', kanitlar: [...new Set(riskEvidence)].slice(0, 12),
      yonerge: 'Kanıtta yönetim dikkati gerektiren risk ya da engel var. Odak tercihi ya da kapatılan bölüm ne olursa olsun bu konuyu Yönetici Değerlendirmesi içinde en az bir kez açıkça an.'
    });
  }
  const completed = pkg.kanitlar.find((item) => isPlainObject(item) && item.tur === 'olcu' && item.olcu === 'tamamlanan' && own(item.donem, 'baslangic') === pkg.istek.donem.baslangic);
  const activity = pkg.kanitlar.find((item) => isPlainObject(item) && item.tur === 'olcu' && item.olcu === 'hareket' && own(item.donem, 'baslangic') === pkg.istek.donem.baslangic);
  if (activity && activity.deger === 0 && activity.kayit_kapsami !== 'partial' && (!completed || completed.deger === 0)) {
    out.push({
      kimlik: 'degisiklik_yok', bolum: 'yonetici_degerlendirmesi', kanitlar: [activity.id, ...(completed ? [completed.id] : [])],
      yonerge: 'Dönemde kayda geçen değişiklik yok. Bunu dürüst ve kısa biçimde söyle; dolgu metni, uydurma etkinlik ya da varsayılan ilerleme yazma.'
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
  if (!Array.isArray(kapaliBolumler) || kapaliBolumler.some((id) => !OPTIONAL_WRITER_SECTIONS.includes(id))) {
    throw new ReportPlanError('SECTION_OPTION_INVALID');
  }
  const pkg = evidencePackage;
  const detail = REPORT_DETAIL_LEVELS.includes(pkg.istek.ayrinti) ? pkg.istek.ayrinti : 'standart';
  const scopeType = own(pkg.istek.kapsam, 'tur');
  const classified = classifyEvidence(pkg);
  const { groups, noteTask } = classified;
  const order = pkg.kanitlar.map((item) => item.id);
  const derivedAll = derivedIds(pkg);
  const conflictIds = (pkg.celiskiler || []).flatMap((conflict) => (Array.isArray(conflict?.kanitlar) ? conflict.kanitlar : []));
  const refOrder = [...order, ...derivedAll];

  const allocation = {
    yonetici_degerlendirmesi: [...groups.olcu, ...derivedAll, ...groups.tamamlanan, ...groups.geciken, ...groups.oncelikli, ...conflictIds],
    one_cikan_gelismeler: [...groups.tamamlanan, ...notesFor(groups.tamamlanan, noteTask, groups.not), ...groups.hareketli,
      ...notesFor(groups.hareketli, noteTask, groups.not), ...groups.belge, ...derivedIds(pkg, ['kilometre_tasi_ozeti', 'karsilastirma'])],
    faaliyetler: [...groups.olcu, ...groups.hareket, ...groups.gorev, ...groups.not, ...groups.belge],
    // Açık kritik/yüksek öncelikli işlerin notları engel ve bağımlılık bilgisini çoğu zaman taşır; seçim yalnızca
    // yapılandırılmış alanlara (öncelik + not varlığı) dayanır, not metni sunucu kararını yönlendirmez.
    riskler: [...groups.geciken, ...notesFor(groups.geciken, noteTask, groups.not), ...conflictIds,
      ...notesFor(groups.oncelikli, noteTask, groups.not),
      ...derivedIds(pkg, ['gecikme_payi', 'tarihsiz_tamamlanma_uyarisi', 'kismi_gorunurluk_uyarisi'])],
    oncelikler: [...groups.yaklasan, ...groups.oncelikli, ...groups.bagimli, ...notesFor(groups.yaklasan, noteTask, groups.not)],
    genel_sonuc: [...groups.olcu, ...derivedAll, ...groups.geciken, ...groups.yaklasan]
  };

  const included = writerStyle.bolumler.filter((section) => {
    if (section.zorunlu) return true;
    if (kapaliBolumler.includes(section.kimlik)) return false;
    // Stil kuralı: dönemde verisi olmayan isteğe bağlı bölüm başlığıyla birlikte kaldırılır.
    return allocation[section.kimlik].length > 0;
  });
  const riskPlanned = included.some((section) => section.kimlik === 'riskler');
  const disclosures = integrityDisclosures(pkg, classified, riskPlanned);

  const [styleMin, totalMax] = writerStyle.sozcukButcesi[detail];
  // Dar kanıtta alt sınır orantılı düşer: dolgu metni üretmeye zorlayan bütçe kurulmaz. Üst sınır stil kararıdır.
  const richness = groups.gorev.length + groups.not.length + groups.belge.length + groups.hareket.length + derivedAll.length;
  const totalMin = Math.max(MIN_SECTION_WORDS * 2, roundTo(styleMin * Math.min(1, (richness + 3) / RICH_EVIDENCE_ITEMS), 10));
  const weightSum = included.reduce((sum, section) => sum + writerStyle.agirliklar[section.kimlik], 0);
  const [paraMin, paraMax] = writerStyle.paragrafSozcukAraligi;
  const sections = included.map((section) => {
    const share = writerStyle.agirliklar[section.kimlik] / weightSum;
    const min = Math.max(MIN_SECTION_WORDS, roundTo(totalMin * share, 10));
    const max = Math.max(min, roundTo(totalMax * share, 10));
    return Object.freeze({
      kimlik: section.kimlik,
      baslik: scopeType === 'kisi' && section.baslikKisi ? section.baslikKisi : section.baslik,
      zorunlu: section.zorunlu,
      sozcuk_araligi: Object.freeze([min, max]),
      paragraf_araligi: Object.freeze([Math.max(1, Math.floor(min / paraMax)), Math.max(1, Math.ceil(max / paraMin))]),
      yonerge: SECTION_GUIDANCE[section.kimlik],
      odak_kanitlar: Object.freeze(uniqueOrdered(allocation[section.kimlik], refOrder)),
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
    odak: pkg.istek.odak ?? 'dengeli',
    sozcuk_araligi: Object.freeze([totalMin, totalMax]),
    bolumler: Object.freeze(sections),
    kapali_bolumler: Object.freeze([...new Set(kapaliBolumler)]),
    notlar: pkg.istek.notlar === 'dahil' ? 'dahil' : 'haric'
  });
}
