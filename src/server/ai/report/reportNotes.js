import 'server-only';
import { formatIstanbulTimestamp, REPORT_EVIDENCE_LIMITS } from '../../../domain/ai/report/reportRequest.js';
import { istanbulDay } from '../tools/rota/taskFacts.js';
import { readReportNoteAuditHistory, readReportTaskNotes } from '../tools/rota/rotaToolStore.js';

/**
 * Bilgin Aşama 4I-A — Yönetici raporu için zengin, sınırlı ve yetkili görev notu okuması.
 *
 * Sohbetin Aşama H not sözleşmesini (`NOTE_LIMITS.tasks = 10`, 400 karakter, ileti başı `includeText`)
 * değiştirmez; yalnızca rapor isteğinde açık `notlar: dahil` rızası verildiğinde çalışır.
 *
 * Tarihsel zaman kuralı:
 *   - `MR_AuditLog.OccurredAt` yalnızca o olayla yazılan YENİ (`sonra`) açıklamanın kayıt zamanıdır.
 *   - Değiştirilen ÖNCEKİ (`önce`) metne değiştirme olayının zamanı ASLA atanmaz; onu oluşturan daha
 *     eski bir denetim kaydı yoksa `kayit_zamani: null`, `kayit_zamani_durumu: 'bilinmiyor'` yazılır.
 *   - `MR_Tasks.UpdatedAt` hiçbir zaman not yazım zamanı sayılmaz; denetim kaydı olmayan güncel
 *     açıklama `kaynak: 'MR_Tasks'`, `kayit_zamani: null`, `kayit_zamani_durumu: 'bilinmiyor'` taşır.
 *   - Metin içindeki "haftaya", "dün", "gelecek hafta" gibi göreli ifadeler takvim tarihine çevrilmez.
 */

// C0/C1 denetim karakterleri ile görünmez biçim/yönlendirme karakterleri (\p{Cf}) temizlenir;
// sekme, satır sonu ve satır/paragraf ayırıcıları tek boşluğa indirgenir.
// eslint-disable-next-line no-control-regex -- not metnindeki geçersiz denetim karakterleri bilinçli olarak temizlenir
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const FORMAT_CHARS_RE = /\p{Cf}/gu;
const LINE_AND_TAB_RE = /[\t\r\n\u2028\u2029]+/gu;

/**
 * Not metninde yapay zekâya veya rapor yazarına doğrudan yönelen gömülü yönerge kalıplarını tanır.
 * Sıradan mühendislik buyruklarını ("test cihazını kontrol edin", "tüm kurallar uygulandı")
 * engellemez ve notu sansürlemez; yalnızca yazara güvenilmez yönerge işareti taşır.
 */
const PROMPT_INJECTION_PATTERNS = Object.freeze([
  /(?:önceki|yukarıdaki|tüm|bütün)\s+(?:bütün\s+|tüm\s+)?(?:talimat\p{L}*|yönerge\p{L}*|kural\p{L}*|sistem\s+mesaj\p{L}*)\s+(?:yoksay|unut|görmezden\s+gel|devre\s+dışı\s+bırak|atla|geçersiz\s+kıl|ihmal\s+et)/iu,
  /raporu\s+yazan\s+yapay\s+zek[aâ]/iu,
  /(?:yapay\s+zek[aâ]|asistan|model)\s*[:\-]\s*(?:bu\s+görevi|riskleri|bütün|tüm)/iu,
  /(?:riskleri\s+atla|tamamland[ıi]\s+olarak\s+yaz|bütün\s+projelerin\s+görevlerini\s+listele|bütün\s+direktörlüğü\s+göster)/iu,
  /(?:ignore|disregard|forget|override)\s+(?:all\s+(?:of\s+)?|the\s+|everything\s+)?(?:previous|prior|above|system)\b(?:\s+(?:instructions?|prompts?|rules?|directives?))?/iu,
  /(?:system\s+prompt|you\s+are\s+now|act\s+as\s+(?:system|admin)|new\s+instructions?\s*:)/iu
]);

// Açık tamamlama tümcesini yakalar; soru, koşul ve aynı görevi niteleyen bekleyen kayıtlar yardımcı işlevle elenir.
const COMPLETED_CLAIM_RE = /(?:^|[.!?;]\s*)(?:görev\s+|iş\s+)?(?:tamamen\s+)?(?:tamamland[ıi]|bitti|kapand[ıi])(?=\s*(?:[.!?;,]|$))/iu;
const NEGATED_ABSENCE_RE = /(?:engel|risk|sorun|gecikme|eksik|bloker|pürüz)\s+yok(?![\p{L}])/giu;
const PENDING_QUALIFIER_RE = /(?:bekleniyor|bekliyor|haftaya|ertelendi|sürüyor|devam\s+ediyor|eksik(?![\p{L}])|(?<![\p{L}])yok(?![\p{L}])|başlamad[ıi]|kesin\s+değil|planland[ıi])/iu;
const OTHER_TASK_SUBJECT_RE = /(?:^|\s)(?:(?:bir\s+)?sonraki|sıradaki|diğer|başka|yeni|ikinci|üçüncü)\s+(?:görev|iş|adım|aşama|faz|paket|madde|kart|kalem)\p{L}*/iu;
const BLOCKED_OR_NOT_DONE_RE = /(?:henüz\s+başlamad[ıi]|ertelendi|durduruldu|iptal\s+edildi|tamamlanmad[ıi]|bitmedi|teslim\s+edilmedi|hazır\s+değil)/iu;
const SCHEDULED_DATE_RE = /(?:(?:\d{1,2}[./-]\d{1,2}|\d{4}-\d{2}-\d{2}|(?:ocak|şubat|mart|nisan|mayıs|haziran|temmuz|ağustos|eylül|ekim|kasım|aralık)|hafta|gün|tarih)[^.!?;,\n]{0,40}(?:planland[ıi]|hedeflendi|belirlendi)|(?:planland[ıi]|hedeflendi|belirlendi)(?=\s*(?:[.!?;,]|$)))/iu;
// "gecikme yok / bulunmuyor / beklenmiyor / olmadı", "gecikmeden / gecikmeksizin" ve "gecikme riski / olasılığı / ihtimali" erteleme sayılmaz.
const POSTPONED_OR_NEGATED_RE = /(?:ertelendi|iptal\s+edildi|gecikti|gecikiyor|gecikme(?!(?:\s+(?:yok|bulunmuyor|beklenmiyor|olmad[ıi]|risk\p{L}*|olas[ıi]l[ıi]\p{L}*|ihtimal\p{L}*|tehlike\p{L}*)|den(?![\p{L}])|ksizin(?![\p{L}])))|yeni\s+tarih\s+(?:ilan\s+edilmedi|belirsiz|yok))/iu;
// Gecikmiş görev uyuşmazlığı yalnızca gecikmeyi açıkça reddeden ifadelerde kurulur; tek başına "risk yok" yeterli değildir.
const EXPLICIT_NO_DELAY_CLAIM_RE = /(?:gecikme\s+(?:yok|bulunmuyor|beklenmiyor|olmad[ıi])|zamanında\s+(?:tamamlanacak|teslim\s+edilecek|ilerliyor)|takvimde\s+sapma\s+yok)/iu;
const DELAY_ACKNOWLEDGED_RE = /(?:gecikti|gecikiyor|gecikme\s+var|ertelendi)/iu;
// Tümce ve cümle ayırıcılar soru işaretini (?) sonda korur ve sayısal tarih içindeki noktaları (12.11) bölmez.
const SENTENCE_SPLIT_RE = /(?:(?:\.(?!\d)|(?<!\d)\.)|[!;\n])+|(?<=\?)\s*/u;
const CLAUSE_SPLIT_RE = /(?:(?:\.(?!\d)|(?<!\d)\.)|[!;,\n])+|(?<=\?)\s*/u;
const CONTRASTIVE_CONJUNCTION_SPLIT_RE = /(?:^|\s)(?:ama|fakat|ancak|lakin)(?=\s|$)/iu;
const TURKISH_QUESTION_PARTICLE_RE = /(?:^|\s)(?:m[ıiuü](?:d[ıiuü]r)?|acaba)(?=$|[\s?!.,;:])/iu;
const TURKISH_CONDITIONAL_RE = /(?:^|\s)(?:eğer(?=$|[\s,])|ise(?![\p{L}])|(?:değil|hazır|olur|olmaz|kalır|kalmaz|gerekir|var|yok|tamamlanır|tamamlanmaz|biter|bitmez|gecik(?:ir|mez)|durur)s[ae](?:k|m|n|n[ıiuü]z|l[ae]r)?(?![\p{L}]))/iu;
// "hazır değildir/değildi" olumsuz sayılır; "hazır" sonrasında herhangi bir "değil..." eki varsa olumlu eşleşmez.
const READINESS_CLAUSE_RE = /(?:^|[\s:])((?:[\p{L}\d_-]+\s+){0,4}?)(?:(test|entegrasyon|üretim|canlı|staging|preprod|qa|uat|geliştirme|dev)\s+)?ortam(?:[ıi])?\s+hazır(?![\p{L}])(?:(\s+değil(?:d[ıiuü]r|di)?(?![\p{L}]))|(?!\s+değil))/iu;
const READINESS_CLAUSE_GLOBAL_RE = /(?:^|[\s:])(?:(?:test|entegrasyon|üretim|canlı|staging|preprod|qa|uat|geliştirme|dev)\s+)?ortam(?:[ıi])?\s+hazır(?![\p{L}])(?:\s+değil(?:d[ıiuü]r|di)?(?![\p{L}]))?/giu;
const GENERIC_SUBJECT_WORDS = new Set(['bu', 'şu', 'mevcut', 'ilgili', 'tüm', 'bütün', 'genel', 'ortak', 'test', 'entegrasyon', 'yeni', 'eski', 'diğer', 'için', 'ile', 've', 'veya', 'da', 'de']);

function compareAscii(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  return a < b ? -1 : (a > b ? 1 : 0);
}

function isInterrogativeClause(clause) {
  return clause.endsWith('?') || TURKISH_QUESTION_PARTICLE_RE.test(clause);
}

function isConditionalClause(clause) {
  return TURKISH_CONDITIONAL_RE.test(clause);
}

function declarativeClauses(lowerText, splitter = CLAUSE_SPLIT_RE) {
  const out = [];
  for (const raw of String(lowerText || '').split(splitter)) {
    const clause = raw.trim();
    if (!clause) continue;
    if (isInterrogativeClause(clause) || isConditionalClause(clause)) continue;
    out.push(clause);
  }
  return out;
}

/** JSON anlık görüntüsünü ayrıştırır; okunamayan veya kesilmiş metinlerde `readable: false` döner. */
function parseJsonSnapshot(raw) {
  if (raw == null) return { readable: true, obj: {} };
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { readable: true, obj: parsed };
    }
    return { readable: false, obj: {} };
  } catch {
    return { readable: false, obj: {} };
  }
}

function extractDescriptionField(snapshot) {
  let raw;
  if (Object.hasOwn(snapshot, 'Description') && snapshot.Description !== undefined) {
    raw = snapshot.Description;
  } else if (Object.hasOwn(snapshot, 'description') && snapshot.description !== undefined) {
    raw = snapshot.description;
  } else {
    return { valid: true, value: null };
  }
  if (raw === null) {
    // Uppercase Description: null iken lowercase description metin taşıyorsa SQL COALESCE ile aynı yedek kullanılır.
    if (Object.hasOwn(snapshot, 'description') && typeof snapshot.description === 'string') {
      return { valid: true, value: snapshot.description };
    }
    return { valid: true, value: null };
  }
  if (typeof raw !== 'string') {
    return { valid: false, value: null };
  }
  return { valid: true, value: raw };
}

/** Ham not metnini temizler; yalnızca boşluk veya görünmez biçim karakterlerinden oluşan metinler `null` döner. */
export function normalizeNoteText(raw) {
  if (raw == null) return null;
  const cleaned = String(raw)
    .replace(FORMAT_CHARS_RE, '')
    .replace(CONTROL_CHARS_RE, ' ')
    .replace(LINE_AND_TAB_RE, ' ')
    .replace(/[【】]/gu, (mark) => (mark === '【' ? '(' : ')'))
    .replace(/\[(\s*[REF]\d{1,3}\s*)\]/giu, '($1)')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** Metni Unicode kod noktası sınırına göre kırpar (Türkçe karakterleri veya vekil çiftlerini bölmez). */
export function clipNoteText(text, maxChars = REPORT_EVIDENCE_LIMITS.maxNoteChars) {
  if (maxChars <= 0) return { text: '', clipped: Boolean(text) };
  const codePoints = Array.from(text);
  if (codePoints.length <= maxChars) return { text, clipped: false };
  return {
    text: codePoints.slice(0, maxChars).join('').trimEnd(),
    clipped: true
  };
}

/** Yinelenme karşılaştırması için Türkçe küçük harfli, boşlukları sıkıştırılmış anahtar. */
function duplicateKey(text) {
  return String(text || '')
    .toLocaleLowerCase('tr-TR')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Bir not metnindeki tüm ortam hazırlığı tümcelerini kutup (`positive`/`negative`) ve
 * çok sözcüklü normalleştirilmiş özne anahtarıyla çıkarır; soru ve koşul tümcelerini atlar.
 */
function extractReadinessClaims(lowerText) {
  const claims = [];
  for (const clause of declarativeClauses(lowerText, CLAUSE_SPLIT_RE)) {
    for (const subClause of clause.split(CONTRASTIVE_CONJUNCTION_SPLIT_RE)) {
      const part = subClause.trim();
      if (!part) continue;
      const match = READINESS_CLAUSE_RE.exec(part);
      if (!match) continue;
      const prefixTokens = (match[1] || '')
        .trim()
        .split(/\s+/u)
        .filter((token) => token.length > 0 && !GENERIC_SUBJECT_WORDS.has(token));
      const envType = (match[2] || '').trim();
      const subjectTokens = [...prefixTokens];
      if (envType && !GENERIC_SUBJECT_WORDS.has(envType)) {
        subjectTokens.push(envType);
      }
      const subject = subjectTokens.join(' ');
      const polarity = match[3] ? 'negative' : 'positive';
      claims.push({ subject, polarity });
    }
  }
  return claims;
}

/** Görev düzeyinde olumsuz/tamamlanmamış iddia olup olmadığını yalnızca ortam hazırlığı ve başka görev öznelerini dışlayarak denetler. */
function hasTaskLevelNotDoneClaim(lowerText) {
  for (const clause of declarativeClauses(lowerText, CLAUSE_SPLIT_RE)) {
    for (const subClause of clause.split(CONTRASTIVE_CONJUNCTION_SPLIT_RE)) {
      const part = subClause.trim();
      if (!part) continue;
      // Başka bir görevin ("sonraki görev", "diğer görev") durumunu anlatan yan tümce bu görevle çelişki üretmez.
      if (OTHER_TASK_SUBJECT_RE.test(part)) continue;
      // Yalnızca ortam hazırlığı parçasını çıkar; aynı tümcedeki bağımsız görev durumu bildirimini koru.
      const withoutReadiness = part.replace(READINESS_CLAUSE_GLOBAL_RE, ' ').trim();
      if (!withoutReadiness) continue;
      if (BLOCKED_OR_NOT_DONE_RE.test(withoutReadiness)) return true;
    }
  }
  return false;
}

/** Açık bir görevin notunda soru/koşul olmayan ve aynı görev için bekleyen niteleyiciyle sınırlandırılmamış tamamlanma iddiası arar. */
function hasUnqualifiedCompletionClaim(lowerText) {
  const sentences = declarativeClauses(lowerText, SENTENCE_SPLIT_RE);
  let hasCompletionSentence = false;
  for (const sentence of sentences) {
    if (COMPLETED_CLAIM_RE.test(sentence)) {
      const stripped = sentence.replace(NEGATED_ABSENCE_RE, ' ');
      if (PENDING_QUALIFIER_RE.test(stripped)) {
        return false;
      }
      hasCompletionSentence = true;
    }
  }
  if (!hasCompletionSentence) return false;
  // Başka bir görevi ("sonraki görev", "diğer görev") anlatmayan diğer cümlelerdeki bekleyen niteleyiciler bu görevi niteler.
  for (const sentence of sentences) {
    if (COMPLETED_CLAIM_RE.test(sentence)) continue;
    if (OTHER_TASK_SUBJECT_RE.test(sentence)) continue;
    const stripped = sentence.replace(NEGATED_ABSENCE_RE, ' ');
    if (PENDING_QUALIFIER_RE.test(stripped)) {
      return false;
    }
  }
  return true;
}

/** Bildirim tümcelerinde açık "gecikme yok" iddiası olup olmadığını (soru/koşul ve gecikme kabulünü ayırarak) denetler. */
function hasExplicitNoDelayClaim(lowerText) {
  const clauses = declarativeClauses(lowerText, CLAUSE_SPLIT_RE);
  const claimsNoDelay = clauses.some((clause) => EXPLICIT_NO_DELAY_CLAIM_RE.test(clause));
  if (!claimsNoDelay) return false;
  return !clauses.some((clause) => DELAY_ACKNOWLEDGED_RE.test(clause));
}

/** Bildirim tümcelerinde takvim planı veya gerçekleşmiş erteleme/iptal iddiası arar. */
function hasScheduledPlanClaim(lowerText) {
  return declarativeClauses(lowerText, CLAUSE_SPLIT_RE).some((clause) => SCHEDULED_DATE_RE.test(clause));
}

function hasConfirmedPostponementClaim(lowerText) {
  return declarativeClauses(lowerText, CLAUSE_SPLIT_RE).some((clause) => POSTPONED_OR_NEGATED_RE.test(clause));
}

/** İki hazırlık iddia listesi arasında aynı özne üzerinde zıt kutuplu çift olup olmadığını döner. */
function hasOpposingReadinessClaim(leftClaims, rightClaims) {
  for (const left of leftClaims) {
    for (const right of rightClaims) {
      if (left.subject === right.subject && left.polarity !== right.polarity) {
        return true;
      }
    }
  }
  return false;
}

/** Not içinde yapay zekâya yönelik gömülü yönerge (istem enjeksiyonu) bulunup bulunmadığını belirler. */
export function containsUntrustedInstruction(text) {
  if (typeof text !== 'string') return false;
  const sanitized = text
    .replace(FORMAT_CHARS_RE, '')
    .normalize('NFKC')
    .replace(CONTROL_CHARS_RE, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!sanitized) return false;
  const lowerTr = sanitized.toLocaleLowerCase('tr-TR');
  return PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(sanitized) || pattern.test(lowerTr));
}

function isWithinPeriod(isoTimestamp, period) {
  if (!isoTimestamp || !period) return false;
  const day = istanbulDay(isoTimestamp);
  return Boolean(day && day >= period.baslangic && day <= period.bitis);
}

/**
 * Sürüm kimliğini kırpma öncesi tam metin veya sunucu SHA-256 özeti üzerinden hesaplar.
 * Yalnızca kırpılmış alıntı varsa doğrulanabilir tam kimlik üretmez (`null`).
 */
function buildVersionIdentity({ fullText, sourceClipped = false, fullHash = null }) {
  if (!fullText) return null;
  if (fullHash) return `hash:${fullHash}`;
  if (!sourceClipped) return `exact:${fullText}`;
  return null;
}

function sameVersionIdentity(left, right) {
  const leftId = typeof left === 'string' ? left : left?._versionIdentity;
  const rightId = typeof right === 'string' ? right : right?._versionIdentity;
  return Boolean(leftId && rightId && leftId === rightId);
}

/** Denetim olayından öncesi/sonrası açıklama metni, okunabilirlik ve tam kimlik bilgilerini çıkarır. */
function extractAuditSide(event, side) {
  const isBefore = side === 'before';
  const hasExtracted = Object.hasOwn(event, isBefore ? 'beforeDescription' : 'afterDescription')
    || Object.hasOwn(event, isBefore ? 'beforeReadable' : 'afterReadable');

  if (hasExtracted) {
    const readable = isBefore ? event.beforeReadable !== false : event.afterReadable !== false;
    const rawDesc = isBefore ? event.beforeDescription : event.afterDescription;
    const sourceClipped = Boolean(isBefore ? event.beforeClipped : event.afterClipped);
    const fullHash = isBefore ? (event.beforeHash || null) : (event.afterHash || null);
    const text = readable ? normalizeNoteText(rawDesc) : null;
    const identity = readable ? buildVersionIdentity({ fullText: text, sourceClipped, fullHash }) : null;
    return { readable, text, sourceClipped, fullHash, identity };
  }

  const rawJson = isBefore ? event.beforeJson : event.afterJson;
  const parsed = parseJsonSnapshot(rawJson);
  if (!parsed.readable) {
    return { readable: false, text: null, sourceClipped: Boolean(event.detailJsonClipped), fullHash: null, identity: null };
  }
  const desc = extractDescriptionField(parsed.obj);
  if (!desc.valid) {
    return { readable: false, text: null, sourceClipped: Boolean(event.detailJsonClipped), fullHash: null, identity: null };
  }
  const text = normalizeNoteText(desc.value);
  const sourceClipped = Boolean(event.detailJsonClipped);
  const identity = buildVersionIdentity({ fullText: text, sourceClipped, fullHash: null });
  return { readable: true, text, sourceClipped, fullHash: null, identity };
}

/**
 * Tek bir görevin yetkili `MR_AuditLog` açıklama olaylarından ve güncel `MR_Tasks.Description` değerinden
 * kronolojik, zaman kökeni doğru not sürümlerini kurar.
 *
 * @param {object} params - Görev, güncel not, denetim olayları ve rapor dönemi.
 * @returns {Array<object>} Kronolojik sırada (eskiden yeniye) not sürümü kayıtları.
 */
export function reconstructTaskNoteChronology({
  task,
  currentNote = null,
  auditEvents = [],
  period,
  cutOffMs = null,
  maxNoteChars = REPORT_EVIDENCE_LIMITS.maxNoteChars
}) {
  const safeOccurredMs = (event) => {
    if (!event?.occurredAt) return Number.POSITIVE_INFINITY;
    const ms = Date.parse(event.occurredAt);
    return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
  };
  const sortedEvents = [...auditEvents].sort((left, right) => {
    const leftMs = safeOccurredMs(left);
    const rightMs = safeOccurredMs(right);
    if (leftMs !== rightMs) return leftMs - rightMs;
    return (Number(left.auditId) || 0) - (Number(right.auditId) || 0);
  });

  const versions = [];
  let activeVersion = null;
  let gapBeforeNext = false;
  let afterUnauthorizedOriginMove = false;

  const pushVersion = (entry) => {
    const { text, clipped } = clipNoteText(entry.rawText, maxNoteChars);
    const injection = containsUntrustedInstruction(text);
    const version = {
      taskId: task.id,
      projectId: entry.projectId || task.projectId,
      kaynak: entry.kaynak,
      kayit_zamani: entry.kayit_zamani,
      kayit_zamani_durumu: entry.kayit_zamani ? 'biliniyor' : 'bilinmiyor',
      surum_tipi: entry.surum_tipi,
      donem_ici: entry.kayit_zamani ? isWithinPeriod(entry.kayit_zamani, period) : false,
      metin: text,
      kirpildi: Boolean(clipped || entry.sourceClipped),
      guvenilmez_veri: true,
      metin_turu: 'kayitli_kullanici_metni',
      ...(injection ? { guvenilmez_yonerge_iceriyor: true } : {}),
      ...(entry.sonraki_degisiklik_zamani ? { sonraki_degisiklik_zamani: entry.sonraki_degisiklik_zamani } : {}),
      _auditId: entry.auditId ?? null,
      _dedupeKey: duplicateKey(text),
      _versionIdentity: entry.identity ?? null,
      _precededByGap: Boolean(entry.precededByGap)
    };
    versions.push(version);
    return version;
  };

  for (const event of sortedEvents) {
    const before = extractAuditSide(event, 'before');
    const after = extractAuditSide(event, 'after');
    const occurredMs = safeOccurredMs(event);
    const occurredIstanbul = Number.isFinite(occurredMs) ? formatIstanbulTimestamp(new Date(occurredMs)) : null;
    const beforeProjectId = event.beforeProjectId || event.projectId;

    if (event.actionCode === 'CREATE') {
      afterUnauthorizedOriginMove = false;
      if (after.readable && after.text) {
        activeVersion = pushVersion({
          rawText: after.text,
          kaynak: 'MR_AuditLog',
          kayit_zamani: occurredIstanbul,
          surum_tipi: 'tarihsel',
          projectId: event.projectId,
          auditId: event.auditId,
          sourceClipped: after.sourceClipped,
          identity: after.identity,
          precededByGap: gapBeforeNext
        });
        gapBeforeNext = false;
      } else {
        activeVersion = null;
        if (!after.readable) gapBeforeNext = true;
      }
      continue;
    }

    // Okunamayan veya gizlenen `before` sınırı kronoloji sürekliliğini keser; aynı metin görülse bile
    // önceki zaman damgası devralınmaz, yeni zamansız sürüm başlatılır.
    if (!before.readable) {
      gapBeforeNext = true;
      // Yetkisiz kaynak projeden gelen taşınma satırında açıklama değişmediyse sonraki düzenlemenin
      // `before` tarafı da eski yetkisiz metni taşıyacağından bastırılır.
      if (event.beforeOriginUnauthorized && !after.readable) {
        afterUnauthorizedOriginMove = true;
        activeVersion = null;
      } else if (!after.readable || !after.text) {
        if (after.readable) afterUnauthorizedOriginMove = false;
        activeVersion = null;
      } else {
        afterUnauthorizedOriginMove = false;
        activeVersion = pushVersion({
          rawText: after.text,
          kaynak: 'MR_AuditLog',
          kayit_zamani: null,
          surum_tipi: 'tarihsel',
          projectId: event.projectId,
          auditId: null,
          sourceClipped: after.sourceClipped,
          identity: after.identity,
          precededByGap: true
        });
        gapBeforeNext = false;
      }
      continue;
    }

    // `after` okunamıyorsa değişim kanıtlanamaz; yalnızca önceki metin bilinmeyen zamanla korunur ve sınır kapanır.
    if (!after.readable) {
      if (!afterUnauthorizedOriginMove && before.text && !sameVersionIdentity(activeVersion, before.identity)) {
        pushVersion({
          rawText: before.text,
          kaynak: 'MR_AuditLog',
          kayit_zamani: null,
          surum_tipi: 'tarihsel_onceki',
          projectId: beforeProjectId,
          auditId: null,
          sourceClipped: before.sourceClipped,
          identity: before.identity,
          precededByGap: gapBeforeNext || (versions.length > 0 && !activeVersion)
        });
      }
      activeVersion = null;
      gapBeforeNext = true;
      continue;
    }

    // Her iki taraf da okunabilir: yalnızca gerçek açıklama değişikliğinde yeni zaman veya sonraki değişim zamanı atanır.
    const bothEmpty = !before.text && !after.text;
    const sameText = Boolean(before.text && after.text && sameVersionIdentity(before.identity, after.identity));
    if (bothEmpty) {
      activeVersion = null;
      afterUnauthorizedOriginMove = false;
      continue;
    }
    if (sameText) {
      if (afterUnauthorizedOriginMove) {
        // Yetkisiz taşınma sonrası değişmeyen metin sonraki satırlardan da yayımlanmaz.
        activeVersion = null;
        gapBeforeNext = true;
        continue;
      }
      // Açıklamayı değiştirmeyen güncelleme: henüz kaydı yoksa zamanı ve sonraki değişimi belirsiz olarak tut.
      if (!sameVersionIdentity(activeVersion, before.identity)) {
        activeVersion = pushVersion({
          rawText: before.text,
          kaynak: 'MR_AuditLog',
          kayit_zamani: null,
          surum_tipi: 'tarihsel_onceki',
          projectId: beforeProjectId,
          auditId: null,
          sourceClipped: before.sourceClipped,
          identity: before.identity,
          precededByGap: gapBeforeNext || versions.length > 0
        });
        gapBeforeNext = false;
      }
      continue;
    }

    // Gerçek değişiklik (yazma, düzenleme veya silme/temizleme):
    const suppressOriginBefore = afterUnauthorizedOriginMove;
    afterUnauthorizedOriginMove = false;

    if (before.text && !suppressOriginBefore) {
      if (sameVersionIdentity(activeVersion, before.identity)) {
        // Değiştirilen önceki sürüm henüz sonraki değişim zamanı taşımıyorsa gerçek değişim anını işaretle.
        if (activeVersion.kayit_zamani === null && !activeVersion.sonraki_degisiklik_zamani && occurredIstanbul) {
          activeVersion.sonraki_degisiklik_zamani = occurredIstanbul;
        }
      } else {
        // Önceki sürüm yalnızca hemen önceki etkin sürümle eşleştirilir; eşleşmiyorsa kaynak projesiyle ayrı sürüm olur.
        pushVersion({
          rawText: before.text,
          kaynak: 'MR_AuditLog',
          kayit_zamani: null,
          surum_tipi: 'tarihsel_onceki',
          projectId: beforeProjectId,
          auditId: null,
          sonraki_degisiklik_zamani: occurredIstanbul,
          sourceClipped: before.sourceClipped,
          identity: before.identity,
          precededByGap: gapBeforeNext || versions.length > 0
        });
        gapBeforeNext = false;
      }
    }

    if (after.text) {
      activeVersion = pushVersion({
        rawText: after.text,
        kaynak: 'MR_AuditLog',
        kayit_zamani: occurredIstanbul,
        surum_tipi: 'tarihsel',
        projectId: event.projectId,
        auditId: event.auditId,
        sourceClipped: after.sourceClipped,
        identity: after.identity,
        precededByGap: suppressOriginBefore || gapBeforeNext
      });
      gapBeforeNext = false;
    } else {
      // Açıklama temizlendi: etkin sürüm sonlanır; sonradan aynı metin geri gelirse eski zamanı devralamaz.
      activeVersion = null;
    }
  }

  // Canlı not yalnızca aynı proje bağı doğrulanır ve veri kesitini aşmadığı biliniyorsa kabul edilir.
  const noteProjectMismatch = Boolean(currentNote?.projectId && task.projectId && currentNote.projectId !== task.projectId);
  const taskModifiedAfterCutoff = Boolean(
    cutOffMs != null
    && Number.isFinite(cutOffMs)
    && task.updatedAt
    && Date.parse(task.updatedAt) > cutOffMs
  );
  const usableCurrentNote = (!noteProjectMismatch && !taskModifiedAfterCutoff) ? currentNote : null;
  const currentText = usableCurrentNote ? normalizeNoteText(usableCurrentNote.text) : null;

  if (currentText) {
    const { clipped: currentClipped } = clipNoteText(currentText, maxNoteChars);
    const currentIdentity = buildVersionIdentity({
      fullText: currentText,
      sourceClipped: Boolean(usableCurrentNote.clipped),
      fullHash: usableCurrentNote.fullHash || null
    });
    if (activeVersion && sameVersionIdentity(activeVersion, currentIdentity)) {
      activeVersion.surum_tipi = 'guncel';
      // Görev başka projeye taşındıysa güncel sürüm güncel proje kimliğini yansıtmalıdır.
      activeVersion.projectId = usableCurrentNote.projectId || task.projectId;
      if (currentClipped || usableCurrentNote.clipped) activeVersion.kirpildi = true;
    } else {
      // Denetim kaydında doğrulanamayan güncel açıklama: MR_Tasks.UpdatedAt kayıt zamanı değildir.
      pushVersion({
        rawText: currentText,
        kaynak: 'MR_Tasks',
        kayit_zamani: null,
        surum_tipi: 'guncel',
        projectId: usableCurrentNote.projectId || task.projectId,
        auditId: null,
        sourceClipped: Boolean(usableCurrentNote.clipped),
        identity: currentIdentity,
        precededByGap: gapBeforeNext || versions.length > 0
      });
    }
  }

  // Sürüm numarası ve toplam sürüm bilgisini kronolojik olarak ekle.
  const totalVersions = versions.length;
  return versions.map((item, index) => ({
    ...item,
    surum_sira: index + 1,
    toplam_surum: totalVersions
  }));
}

/**
 * Belirlenimci olarak saptanabilen not yinelemelerini ve çelişkilerini (görev durumu ↔ not,
 * aynı görevde çelişen ardışık sürümler, kapsam içi karşıt notlar) işaretler.
 * Hangi kaydın doğru olduğuna karar vermez; zaman sırasını korur.
 */
export function detectNoteDuplicatesAndContradictions({
  noteEntries,
  taskById,
  taskEvidenceIdByTaskId,
  today,
  period = null,
  lastReopenAtByTaskId = new Map(),
  lastTargetFinishChangeByTaskId = new Map()
}) {
  const contradictions = [];
  const seenConflictKeys = new Set();
  const addConflict = (conflict) => {
    const key = `${conflict.tur}:${[...conflict.kanitlar].sort(compareAscii).join('|')}`;
    if (seenConflictKeys.has(key)) return;
    seenConflictKeys.add(key);
    contradictions.push(conflict);
  };

  // 1. Farklı görevlerde birebir yinelenen not metinlerini işaretle (aynı görevde A→B→A geri alımı yineleme sayılmaz).
  const byText = new Map();
  for (const entry of noteEntries) {
    // Kırpılmış notlar yalnızca doğrulanmış tam metin SHA-256 özetiyle yinelenmiş sayılır; ortak 1600 karakterlik önek yeterli değildir.
    const key = entry.kirpildi
      ? (typeof entry._versionIdentity === 'string' && entry._versionIdentity.startsWith('hash:') ? entry._versionIdentity : null)
      : duplicateKey(entry.metin);
    if (!key) continue;
    if (!byText.has(key)) byText.set(key, []);
    byText.get(key).push(entry);
  }
  let duplicateGroupSeq = 0;
  for (const group of byText.values()) {
    const distinctTaskIds = new Set(group.map((item) => item._taskId));
    if (distinctTaskIds.size < 2) continue;
    duplicateGroupSeq += 1;
    const groupId = `Y${duplicateGroupSeq}`;
    for (const item of group) {
      item.yineleme_grubu = groupId;
      item.yinelenen_kanitlar = group
        .filter((other) => other._taskId !== item._taskId)
        .map((other) => other.id);
    }
  }

  // 2. Görev bazında not sürümü çelişkileri ve görev durumu ↔ not uyuşmazlıkları.
  const byTask = new Map();
  for (const entry of noteEntries) {
    if (!byTask.has(entry._taskId)) byTask.set(entry._taskId, []);
    byTask.get(entry._taskId).push(entry);
  }

  for (const [taskId, taskNotes] of byTask) {
    const task = taskById.get(taskId);
    const taskEvidenceId = taskEvidenceIdByTaskId.get(taskId) || null;
    const latest = taskNotes.at(-1);

    // Aynı görevde gerçekten ardışık (surum_sira + 1), denetim kopukluğu olmayan ve kırpılmamış iki sürüm arasında çelişki (R4).
    for (let i = 0; i < taskNotes.length - 1; i += 1) {
      const earlier = taskNotes[i];
      const later = taskNotes[i + 1];
      if (earlier.guvenilmez_yonerge_iceriyor || later.guvenilmez_yonerge_iceriyor) continue;
      if (earlier.kirpildi || later.kirpildi) continue;
      if (later._precededByGap) continue;
      if (Number.isInteger(earlier.surum_sira) && Number.isInteger(later.surum_sira)
        && later.surum_sira !== earlier.surum_sira + 1) {
        continue;
      }
      const earlierLower = earlier.metin.toLocaleLowerCase('tr-TR');
      const laterLower = later.metin.toLocaleLowerCase('tr-TR');
      const scheduleReversal = hasScheduledPlanClaim(earlierLower)
        && !hasConfirmedPostponementClaim(earlierLower)
        && hasConfirmedPostponementClaim(laterLower);
      const readinessReversal = hasOpposingReadinessClaim(
        extractReadinessClaims(earlierLower),
        extractReadinessClaims(laterLower)
      );
      if (scheduleReversal || readinessReversal) {
        addConflict({
          tur: 'not_surum_celiskisi',
          kanitlar: [earlier.id, later.id],
          gorev: task?.code || taskId,
          kronoloji: [earlier.kayit_zamani, later.kayit_zamani],
          aciklama: 'Aynı görevin ardışık not sürümleri arasında zaman sırasıyla değişen çelişkili bildirimler bulundu.'
        });
      }
    }

    // Görev durumu ile yalnızca güncel olduğu doğrulanan ve kırpılmamış not arasında belirlenimci uyuşmazlık.
    if (task && taskEvidenceId && latest && latest.surum_tipi === 'guncel'
      && !latest.guvenilmez_yonerge_iceriyor && !latest.kirpildi) {
      const parseOptionalAuditId = (value) => {
        if (value === null || value === undefined || value === '') return null;
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
      };
      const latestLower = latest.metin.toLocaleLowerCase('tr-TR');
      const latestDay = latest.kayit_zamani ? istanbulDay(latest.kayit_zamani) : null;
      const latestMs = latest.kayit_zamani ? Date.parse(latest.kayit_zamani) : Number.NaN;
      const latestAuditId = parseOptionalAuditId(latest._auditId);
      const rawReopen = lastReopenAtByTaskId?.get(taskId) ?? task.lastReopenAt ?? null;
      const reopenIso = typeof rawReopen === 'string' ? rawReopen : (rawReopen?.occurredAt || null);
      const reopenAuditId = typeof rawReopen === 'object' && rawReopen !== null
        ? parseOptionalAuditId(rawReopen.auditId)
        : parseOptionalAuditId(task.lastReopenAuditId);
      const reopenMs = reopenIso ? Date.parse(reopenIso) : Number.NaN;
      // Bilinen bir yeniden açılma varsa ve notun bu yeniden açılmadan SONRA yazıldığı (milisaniye veya AuditId ile) kanıtlanamıyorsa uyuşmazlık ilan edilmez.
      const notePostdatesKnownReopen = !Number.isFinite(reopenMs)
        || (Number.isFinite(latestMs) && (
          latestMs > reopenMs
          || (latestMs === reopenMs && latestAuditId != null && reopenAuditId != null && latestAuditId > reopenAuditId)
        ));
      const rawTfChange = lastTargetFinishChangeByTaskId?.get(taskId) ?? task.lastTargetFinishChangeAt ?? null;
      const tfChangeIso = typeof rawTfChange === 'string' ? rawTfChange : (rawTfChange?.occurredAt || null);
      const tfChangeAuditId = typeof rawTfChange === 'object' && rawTfChange !== null
        ? parseOptionalAuditId(rawTfChange.auditId)
        : parseOptionalAuditId(task.lastTargetFinishChangeAuditId);
      const tfChangeMs = tfChangeIso ? Date.parse(tfChangeIso) : Number.NaN;
      // Not yazıldıktan SONRA hedef bitiş değiştirildiyse veya görev kesit sonrası değiştiyse mevcut hedef bitiş not anında yürürlükte sayılmaz.
      const deadlineEstablishedAtNoteTime = !task._postCutoffModified && (
        !Number.isFinite(tfChangeMs)
        || (Number.isFinite(latestMs) && (
          latestMs > tfChangeMs
          || (latestMs === tfChangeMs && latestAuditId != null && tfChangeAuditId != null && latestAuditId >= tfChangeAuditId)
        ))
      );
      const isTaskOpen = task.status !== 'done';
      const isTaskOverdue = isTaskOpen && Boolean(task.targetFinish) && task.targetFinish < today;
      if (isTaskOpen && notePostdatesKnownReopen
        && hasUnqualifiedCompletionClaim(latestLower)) {
        addConflict({
          tur: 'durum_not_uyusmazligi',
          kanitlar: [taskEvidenceId, latest.id],
          gorev: task.code || taskId,
          aciklama: 'Görev kaydı açık görünürken görev notu işin tamamlandığını bildiriyor.'
        });
      } else if (isTaskOverdue && notePostdatesKnownReopen && deadlineEstablishedAtNoteTime && hasExplicitNoDelayClaim(latestLower)
        && Boolean(latestDay && task.targetFinish && latestDay > task.targetFinish)) {
        addConflict({
          tur: 'durum_not_uyusmazligi',
          kanitlar: [taskEvidenceId, latest.id],
          gorev: task.code || taskId,
          aciklama: 'Hedef bitiş tarihi geçtikten sonra kaydedilen "gecikme yok" notu ile gecikmiş görev durumu uyuşmuyor.'
        });
      } else if (!isTaskOpen && hasTaskLevelNotDoneClaim(latestLower)
        && Boolean(latestDay && task.actualFinish && latestDay > task.actualFinish)) {
        addConflict({
          tur: 'durum_not_uyusmazligi',
          kanitlar: [taskEvidenceId, latest.id],
          gorev: task.code || taskId,
          aciklama: 'Görev kaydı tamamlanmış görünürken tamamlanma sonrasında kaydedilen not işin tamamlanmadığını veya ertelendiğini bildiriyor.'
        });
      }
    }
  }

  // 3. Aynı projede ve aynı ortam öznesinde eşzamanlı/örtüşen güncel, kırpılmamış farklı görev notları arasında açık karşıt bildirim.
  const safeCurrentNotes = noteEntries
    .filter((entry) => !entry.guvenilmez_yonerge_iceriyor && !entry.kirpildi && entry.surum_tipi === 'guncel')
    .map((entry) => ({
      entry,
      day: entry.kayit_zamani ? istanbulDay(entry.kayit_zamani) : null,
      claims: extractReadinessClaims(entry.metin.toLocaleLowerCase('tr-TR'))
    }))
    .filter((item) => item.claims.length > 0);

  for (let i = 0; i < safeCurrentNotes.length; i += 1) {
    for (let j = i + 1; j < safeCurrentNotes.length; j += 1) {
      const left = safeCurrentNotes[i];
      const right = safeCurrentNotes[j];
      if (left.entry._taskId === right.entry._taskId) continue;
      if (!left.entry._projectId || left.entry._projectId !== right.entry._projectId) continue;
      // Farklı takvim günlerine ait gözlemler kronolojik ilerlemedir; eşzamanlı çelişki olarak işaretlenmez.
      if ((left.day || right.day) && left.day !== right.day) continue;
      if (!hasOpposingReadinessClaim(left.claims, right.claims)) continue;
      addConflict({
        tur: 'notlar_arasi_celiski',
        kanitlar: [left.entry.id, right.entry.id],
        aciklama: 'Aynı projedeki farklı görev notları aynı test/ortam hazırlığı hakkında karşıt bildirim taşıyor.'
      });
    }
  }

  return contradictions;
}

/**
 * Rapor düzeyinde açık `notlar: dahil` rızası varsa yetkili görev notlarını ve `MR_AuditLog`
 * açıklama sürümlerini sınırlı, belirlenimci biçimde toplar.
 *
 * Rıza yoksa HİÇBİR not veya değişiklik metni sorgusu çalıştırılmaz.
 *
 * @param {object} params - Toplayıcı bağlamı.
 * @returns {Promise<object>} Not sürümleri, tamlık özeti ve istatistikler.
 */
export async function collectReportNotes({
  turn,
  scope,
  signal,
  consent,
  prioritizedTasks,
  period,
  cutOffUtc,
  factsTruncated = false,
  limits = REPORT_EVIDENCE_LIMITS
}) {
  // Açık rıza kapısı: `notlar: dahil` dışındaki hiçbir durumda korunan metin okunmaz.
  if (consent !== 'dahil') {
    return {
      versions: [],
      omittedTaskIds: new Set(),
      completeness: {
        riza: false,
        metin: 'hariç (rıza yok)',
        dahil: 0,
        disarida_kalan: 0,
        notsuz_gorev: null,
        kirpilan: 0,
        denetim_kesik: false
      }
    };
  }

  signal?.throwIfAborted?.();
  const maxTasksForNotes = Math.min(limits.maxSelectedTasks ?? REPORT_EVIDENCE_LIMITS.maxSelectedTasks, prioritizedTasks.length);
  const candidateTasks = prioritizedTasks.slice(0, maxTasksForNotes);
  const tasksExcludedByTaskCap = Math.max(0, prioritizedTasks.length - candidateTasks.length);
  const candidateIds = candidateTasks.map((task) => task.id);

  if (candidateIds.length === 0) {
    const emptyIncomplete = Boolean(tasksExcludedByTaskCap > 0 || factsTruncated);
    return {
      versions: [],
      omittedTaskIds: new Set(),
      completeness: {
        riza: true,
        metin: tasksExcludedByTaskCap > 0
          ? `0 not (${tasksExcludedByTaskCap} görev not okuma sınırı dışında)`
          : factsTruncated
            ? 'gözlenen not kaydı yok (görev/kadro okuması kesik)'
            : 'kapsamda not okunacak görev yok',
        dahil: 0,
        disarida_kalan: 0,
        notsuz_gorev: emptyIncomplete ? null : 0,
        kirpilan: 0,
        denetim_kesik: emptyIncomplete
      }
    };
  }

  const maxNoteChars = limits.maxNoteChars ?? REPORT_EVIDENCE_LIMITS.maxNoteChars;
  const maxAuditEvents = limits.maxNoteAuditEvents ?? REPORT_EVIDENCE_LIMITS.maxNoteAuditEvents;
  const maxSelectedNotes = limits.maxSelectedNotes ?? REPORT_EVIDENCE_LIMITS.maxSelectedNotes;
  const cutOffMs = cutOffUtc ? (cutOffUtc instanceof Date ? cutOffUtc.getTime() : Date.parse(cutOffUtc)) : null;

  // Güncel açıklamalar ve yetkili MR_AuditLog açıklama geçişleri sınırlı iki okuma ile alınır.
  const currentResult = await turn.sql(signal, (executor) => readReportTaskNotes(executor, scope, candidateIds, {
    maxRows: maxTasksForNotes,
    cutOffUtc
  }));
  signal?.throwIfAborted?.();
  const auditResult = await turn.sql(signal, (executor) => readReportNoteAuditHistory(executor, scope, candidateIds, {
    cutOffUtc,
    maxRows: maxAuditEvents
  }));
  signal?.throwIfAborted?.();

  const auditByTask = new Map();
  for (const event of auditResult.events) {
    if (!event.taskId) continue;
    if (!auditByTask.has(event.taskId)) auditByTask.set(event.taskId, []);
    auditByTask.get(event.taskId).push(event);
  }

  const versionsByTaskQueue = [];
  let tasksWithoutObservedNotes = 0;
  let tasksWithheldByCutoff = 0;
  let tasksWithClippedEmptyNotes = 0;
  let totalObservedVersions = 0;

  for (const task of candidateTasks) {
    const currentNote = currentResult.notes.get(task.id) || null;
    const readerWithheld = Boolean(currentResult.withheldTaskIds?.has(task.id));
    const taskModifiedAfterCutoff = Boolean(
      cutOffMs != null
      && Number.isFinite(cutOffMs)
      && task.updatedAt
      && Date.parse(task.updatedAt) > cutOffMs
    );
    // Görev olgularında açıklama var görünürken not okuyucusu satır döndürmediyse eşzamanlı değişim/saklama sayılır.
    const concurrentMissingWithDescription = Boolean(task.hasDescription === true && !currentNote && !currentResult.truncated);
    const currentWithheldByCutoff = readerWithheld || taskModifiedAfterCutoff || concurrentMissingWithDescription;
    if (currentWithheldByCutoff) {
      tasksWithheldByCutoff += 1;
    }

    // Kırpılmış güncel veya tarihsel alıntı temizlendikten sonra boş kalıyorsa (ör. 1601 görünmez boşluk + metin) "notsuz" sayılmaz.
    const taskAuditEvents = auditByTask.get(task.id) || [];
    const clippedEmptyCurrent = Boolean(!currentWithheldByCutoff && currentNote?.clipped && !normalizeNoteText(currentNote.text));
    const clippedEmptyAudit = taskAuditEvents.some((event) => {
      const before = extractAuditSide(event, 'before');
      const after = extractAuditSide(event, 'after');
      return (before.readable && before.sourceClipped && !before.text)
        || (after.readable && after.sourceClipped && !after.text);
    });
    if (clippedEmptyCurrent || clippedEmptyAudit) {
      tasksWithClippedEmptyNotes += 1;
    }

    const taskVersions = reconstructTaskNoteChronology({
      task,
      currentNote: currentWithheldByCutoff ? null : currentNote,
      auditEvents: taskAuditEvents,
      period,
      cutOffMs,
      maxNoteChars: Math.max(1, maxNoteChars)
    });
    if (taskVersions.length === 0) {
      if (!currentWithheldByCutoff && !clippedEmptyCurrent && !clippedEmptyAudit && task.hasDescription !== true) {
        tasksWithoutObservedNotes += 1;
      }
      continue;
    }
    totalObservedVersions += taskVersions.length;
    // Görev içi seçim sırası: dönem içi not → güncel sürüm → en yeni sürüm.
    const rankedTaskVersions = taskVersions
      .map((version) => ({
        ...version,
        _taskPriorityRank: task._priorityRank ?? 0
      }))
      .sort((left, right) => {
        if (left.donem_ici !== right.donem_ici) return left.donem_ici ? -1 : 1;
        const leftCurrent = left.surum_tipi === 'guncel';
        const rightCurrent = right.surum_tipi === 'guncel';
        if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;
        return right.surum_sira - left.surum_sira;
      });
    versionsByTaskQueue.push(rankedTaskVersions);
  }

  // Adil tur-bazlı (round-robin) seçim: tek bir çok düzenlenmiş görev tüm not bütçesini tüketip
  // diğer öncelikli görevleri aç bırakmaz; her görev öncelik sırasıyla en değerli sürümünü önce alır.
  const prioritizedPool = [];
  let round = 0;
  while (true) {
    let addedInRound = false;
    for (const queue of versionsByTaskQueue) {
      if (round < queue.length) {
        prioritizedPool.push(queue[round]);
        addedInRound = true;
      }
    }
    if (!addedInRound) break;
    round += 1;
  }

  // Sıfır karakter bütçesi boş not kanıtı üretmez; bütün gözlenen notlar sınır nedeniyle dışarıda sayılır.
  const effectiveSelectedCap = maxNoteChars <= 0 ? 0 : Math.max(0, maxSelectedNotes);
  const selected = prioritizedPool.slice(0, effectiveSelectedCap).map((version, index) => ({
    ...version,
    _selectionOrder: index
  }));
  const omittedTaskIds = new Set(prioritizedPool.slice(effectiveSelectedCap).map((version) => version.taskId).filter(Boolean));

  // Sunum sıralaması: görev önceliği korunarak aynı görevdeki sürümler kronolojik (eskiden yeniye) sıralanır.
  selected.sort((left, right) => {
    if (left._taskPriorityRank !== right._taskPriorityRank) {
      return left._taskPriorityRank - right._taskPriorityRank;
    }
    if (left.taskId === right.taskId) {
      return left.surum_sira - right.surum_sira;
    }
    return compareAscii(left.taskId, right.taskId);
  });

  const omittedCount = Math.max(0, totalObservedVersions - selected.length);
  const clippedCount = selected.filter((item) => item.kirpildi).length;
  const historyIncomplete = Boolean(
    auditResult.truncated
    || currentResult.truncated
    || (auditResult.corruptedCount || 0) > 0
    || tasksWithheldByCutoff > 0
    || tasksWithClippedEmptyNotes > 0
    || tasksExcludedByTaskCap > 0
    || factsTruncated
  );
  // Denetim geçmişi kesik, bozuk, kesit sonrası saklı veya görev/kadro sınırı dışındaysa kesin "notsuz" ilan edilmez (`null`).
  const definitiveTasksWithoutNotes = historyIncomplete ? null : tasksWithoutObservedNotes;

  const summaryParts = [];
  if (omittedCount > 0) {
    summaryParts.push(selected.length > 0
      ? `ilk ${selected.length} not (${omittedCount} not sınır nedeniyle dışarıda)`
      : `0 not (${omittedCount} not sınır nedeniyle dışarıda)`);
  } else if (selected.length === 0) {
    summaryParts.push(historyIncomplete ? 'gözlenen not kaydı yok (denetim kesik)' : 'not kaydı yok');
  } else {
    summaryParts.push(`${selected.length} not`);
  }
  if (definitiveTasksWithoutNotes != null && definitiveTasksWithoutNotes > 0) {
    summaryParts.push(`${definitiveTasksWithoutNotes} görev notsuz`);
  } else if (historyIncomplete && tasksWithoutObservedNotes > 0) {
    summaryParts.push(`${tasksWithoutObservedNotes} görevde gözlenen not yok (denetim kesik)`);
  }
  if (tasksWithheldByCutoff > 0) {
    summaryParts.push(`${tasksWithheldByCutoff} görevde güncel not kesit sonrası değişim nedeniyle dışarıda`);
  }
  if (tasksExcludedByTaskCap > 0) {
    summaryParts.push(`${tasksExcludedByTaskCap} görev not okuma sınırı dışında`);
  }
  if (clippedCount > 0) summaryParts.push(`${clippedCount} not ${maxNoteChars} karakterde kırpıldı`);
  if (historyIncomplete) summaryParts.push('denetim/not okuması kesik veya eksik');

  return {
    versions: selected,
    omittedTaskIds,
    completeness: {
      riza: true,
      metin: summaryParts.join('; '),
      dahil: selected.length,
      disarida_kalan: omittedCount,
      notsuz_gorev: definitiveTasksWithoutNotes,
      kirpilan: clippedCount,
      denetim_kesik: historyIncomplete,
      kesit_sonrasi_saklanan_gorev: tasksWithheldByCutoff,
      okuma_disi_gorev: tasksExcludedByTaskCap
    }
  };
}
