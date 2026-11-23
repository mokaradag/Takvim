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

// Denetim karakterlerini temizler; sekme ve satır sonlarını tek boşluğa indirger (teknik bağlam korunur).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;

/**
 * Not metninde yapay zekâya veya rapor yazarına doğrudan yönelen gömülü yönerge kalıplarını tanır.
 * Sıradan mühendislik buyruklarını ("test cihazını kontrol edin", "önce arayüzü doğrulayın")
 * engellemez ve notu sansürlemez; yalnızca yazara güvenilmez yönerge işareti taşır.
 */
const PROMPT_INJECTION_PATTERNS = Object.freeze([
  /(?:önceki|yukarıdaki|tüm|bütün)\s+(?:bütün\s+|tüm\s+)?(?:talimat|yönerge|kural|sistem\s+mesaj)/iu,
  /raporu\s+yazan\s+yapay\s+zek[aâ]/iu,
  /(?:yapay\s+zek[aâ]|asistan|model)\s*[:\-]\s*(?:bu\s+görevi|riskleri|bütün|tüm)/iu,
  /(?:riskleri\s+atla|tamamland[ıi]\s+olarak\s+yaz|bütün\s+projelerin\s+görevlerini\s+listele|bütün\s+direktörlüğü\s+göster)/iu,
  /(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:previous|prior|above|system)\s+(?:instructions?|prompts?|rules?|directives?)/iu,
  /(?:system\s+prompt|you\s+are\s+now|act\s+as\s+(?:system|admin)|new\s+instructions?\s*:)/iu
]);

const COMPLETED_CLAIM_RE = /(?:^|[.!?;]\s*)(?:görev\s+|iş\s+)?(?:tamamen\s+)?(?:tamamland[ıi]|bitti|kapand[ıi])(?:\s*[.!?]?\s*$)/iu;
const PENDING_QUALIFIER_RE = /(?:bekleniyor|bekliyor|haftaya|ertelendi|sürüyor|devam\s+ediyor|eksik|yok|başlamad[ıi]|kesin\s+değil|planland[ıi])/iu;
const BLOCKED_OR_NOT_DONE_RE = /(?:henüz\s+başlamad[ıi]|ertelendi|durduruldu|iptal\s+edildi|tamamlanmad[ıi]|hazır\s+değil)/iu;
const SCHEDULED_DATE_RE = /(?:planland[ıi]|hedeflendi|belirlendi|hazır(?![\p{L}])|risk\s+yok|gecikme\s+yok)/iu;
const POSTPONED_OR_NEGATED_RE = /(?:ertelendi|iptal|gecikme|hazır\s+değil|yeni\s+tarih\s+(?:ilan\s+edilmedi|belirsiz|yok)|risk\s+var)/iu;
const NO_RISK_CLAIM_RE = /(?:risk\s+yok|gecikme\s+yok|sorun\s+yok)/iu;
const READY_POSITIVE_RE = /(?:test\s+ortam[ıi]\s+hazır(?!\s+değil)|ortam\s+hazır(?!\s+değil))/iu;
const READY_NEGATIVE_RE = /(?:test\s+ortam[ıi]\s+hazır\s+değil|ortam\s+hazır\s+değil)/iu;

function safeJsonObject(raw) {
  if (!raw) return {};
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function extractDescriptionField(snapshot) {
  if (Object.hasOwn(snapshot, 'Description')) return snapshot.Description;
  if (Object.hasOwn(snapshot, 'description')) return snapshot.description;
  return undefined;
}

/** Ham not metnini temizler; yalnızca boşluklardan oluşan metinler `null` döner. */
export function normalizeNoteText(raw) {
  if (raw == null) return null;
  const cleaned = String(raw)
    .replace(CONTROL_CHARS_RE, ' ')
    .replace(/[【】]/gu, (mark) => (mark === '【' ? '(' : ')'))
    .replace(/\[(\s*R\d{1,3}\s*)\]/giu, '($1)')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** Metni Unicode kod noktası sınırına göre kırpar (Türkçe karakterleri veya vekil çiftlerini bölmez). */
export function clipNoteText(text, maxChars = REPORT_EVIDENCE_LIMITS.maxNoteChars) {
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

/** Not içinde yapay zekâya yönelik gömülü yönerge (istem enjeksiyonu) bulunup bulunmadığını belirler. */
export function containsUntrustedInstruction(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  const lowerTr = text.toLocaleLowerCase('tr-TR');
  return PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(text) || pattern.test(lowerTr));
}

function isWithinPeriod(isoTimestamp, period) {
  if (!isoTimestamp || !period) return false;
  const day = istanbulDay(isoTimestamp);
  return Boolean(day && day >= period.baslangic && day <= period.bitis);
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
  maxNoteChars = REPORT_EVIDENCE_LIMITS.maxNoteChars
}) {
  const sortedEvents = [...auditEvents].sort((left, right) => {
    const leftMs = left.occurredAt ? Date.parse(left.occurredAt) : 0;
    const rightMs = right.occurredAt ? Date.parse(right.occurredAt) : 0;
    return leftMs - rightMs || (left.auditId || 0) - (right.auditId || 0);
  });

  const versions = [];
  const pushVersion = (entry) => {
    const { text, clipped } = clipNoteText(entry.rawText, maxNoteChars);
    const dedupe = duplicateKey(text);
    const previous = versions.at(-1);
    // Ardışık özdeş metinleri yinelemeyiz; varsa bilinen en erken gerçek kayıt zamanı korunur.
    if (previous && previous._dedupeKey === dedupe) {
      if (previous.kayit_zamani === null && entry.kayit_zamani !== null) {
        previous.kayit_zamani = entry.kayit_zamani;
        previous.kayit_zamani_durumu = 'biliniyor';
        previous.donem_ici = isWithinPeriod(entry.kayit_zamani, period);
      }
      if (entry.auditId != null) previous._auditId = entry.auditId;
      return;
    }
    const injection = containsUntrustedInstruction(text);
    versions.push({
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
      _dedupeKey: dedupe
    });
  };

  for (const event of sortedEvents) {
    const beforeSnapshot = safeJsonObject(event.beforeJson);
    const afterSnapshot = safeJsonObject(event.afterJson);
    const beforeRaw = extractDescriptionField(beforeSnapshot);
    const afterRaw = extractDescriptionField(afterSnapshot);
    const beforeText = normalizeNoteText(beforeRaw);
    const afterText = normalizeNoteText(afterRaw);
    const occurredIstanbul = event.occurredAt ? formatIstanbulTimestamp(event.occurredAt) : null;

    if (event.actionCode === 'CREATE') {
      if (afterText) {
        pushVersion({
          rawText: afterText,
          kaynak: 'MR_AuditLog',
          kayit_zamani: occurredIstanbul,
          surum_tipi: 'tarihsel',
          projectId: event.projectId,
          auditId: event.auditId,
          sourceClipped: event.detailJsonClipped
        });
      }
      continue;
    }

    // UPDATE olayında yalnızca açıklama gerçekten değiştiyse yeni kayıt zamanı atanır.
    const unchanged = beforeText === afterText;
    if (beforeText) {
      const alreadyRecorded = versions.some((item) => item._dedupeKey === duplicateKey(beforeText));
      if (!alreadyRecorded) {
        // Önceki metne değiştirme olayının zamanı ASLA atanmaz; kayıt zamanı bilinmiyor işaretlenir.
        pushVersion({
          rawText: beforeText,
          kaynak: 'MR_AuditLog',
          kayit_zamani: null,
          surum_tipi: 'tarihsel_onceki',
          projectId: event.projectId,
          auditId: null,
          sonraki_degisiklik_zamani: occurredIstanbul,
          sourceClipped: event.detailJsonClipped
        });
      }
    }
    if (!unchanged && afterText) {
      pushVersion({
        rawText: afterText,
        kaynak: 'MR_AuditLog',
        kayit_zamani: occurredIstanbul,
        surum_tipi: 'tarihsel',
        projectId: event.projectId,
        auditId: event.auditId,
        sourceClipped: event.detailJsonClipped
      });
    }
  }

  const currentText = currentNote ? normalizeNoteText(currentNote.text) : null;
  if (currentText) {
    const { text: clippedCurrent, clipped: currentClipped } = clipNoteText(currentText, maxNoteChars);
    const currentKey = duplicateKey(clippedCurrent);
    const lastVersion = versions.at(-1);
    if (lastVersion && lastVersion._dedupeKey === currentKey) {
      lastVersion.surum_tipi = 'guncel';
      if (currentClipped || currentNote.clipped) lastVersion.kirpildi = true;
    } else {
      // Denetim kaydında eşleşmeyen güncel açıklama: MR_Tasks.UpdatedAt kayıt zamanı değildir.
      pushVersion({
        rawText: currentText,
        kaynak: 'MR_Tasks',
        kayit_zamani: null,
        surum_tipi: 'guncel',
        projectId: currentNote.projectId || task.projectId,
        auditId: null,
        sourceClipped: Boolean(currentNote.clipped)
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
  today
}) {
  const contradictions = [];
  const seenConflictKeys = new Set();
  const addConflict = (conflict) => {
    const key = `${conflict.tur}:${[...conflict.kanitlar].sort().join('|')}`;
    if (seenConflictKeys.has(key)) return;
    seenConflictKeys.add(key);
    contradictions.push(conflict);
  };

  // 1. Farklı görevlerde veya sürümlerde birebir yinelenen not metinlerini işaretle.
  const byText = new Map();
  for (const entry of noteEntries) {
    const key = duplicateKey(entry.metin);
    if (!key) continue;
    if (!byText.has(key)) byText.set(key, []);
    byText.get(key).push(entry);
  }
  let duplicateGroupSeq = 0;
  for (const group of byText.values()) {
    if (group.length < 2) continue;
    duplicateGroupSeq += 1;
    const groupId = `Y${duplicateGroupSeq}`;
    const ids = group.map((item) => item.id);
    for (const item of group) {
      item.yineleme_grubu = groupId;
      item.yinelenen_kanitlar = ids.filter((id) => id !== item.id);
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

    // Aynı görevde ardışık iki sürüm arasında plan ↔ erteleme / hazır ↔ hazır değil çelişkisi (R4).
    for (let i = 0; i < taskNotes.length - 1; i += 1) {
      const earlier = taskNotes[i];
      const later = taskNotes[i + 1];
      if (earlier.guvenilmez_yonerge_iceriyor || later.guvenilmez_yonerge_iceriyor) continue;
      const earlierLower = earlier.metin.toLocaleLowerCase('tr-TR');
      const laterLower = later.metin.toLocaleLowerCase('tr-TR');
      const scheduleReversal = SCHEDULED_DATE_RE.test(earlierLower) && POSTPONED_OR_NEGATED_RE.test(laterLower);
      const readinessReversal = (READY_POSITIVE_RE.test(earlierLower) && READY_NEGATIVE_RE.test(laterLower))
        || (READY_NEGATIVE_RE.test(earlierLower) && READY_POSITIVE_RE.test(laterLower));
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

    // Görev durumu ile en güncel not arasında belirlenimci uyuşmazlık (S18, S24).
    if (task && taskEvidenceId && latest && !latest.guvenilmez_yonerge_iceriyor) {
      const latestLower = latest.metin.toLocaleLowerCase('tr-TR');
      const isTaskOpen = task.status !== 'done';
      const isTaskOverdue = isTaskOpen && Boolean(task.targetFinish) && task.targetFinish < today;
      if (isTaskOpen && COMPLETED_CLAIM_RE.test(latestLower) && !PENDING_QUALIFIER_RE.test(latestLower)) {
        addConflict({
          tur: 'durum_not_uyusmazligi',
          kanitlar: [taskEvidenceId, latest.id],
          gorev: task.code || taskId,
          aciklama: 'Görev kaydı açık görünürken görev notu işin tamamlandığını bildiriyor.'
        });
      } else if (isTaskOverdue && NO_RISK_CLAIM_RE.test(latestLower) && !latest.donem_ici) {
        addConflict({
          tur: 'durum_not_uyusmazligi',
          kanitlar: [taskEvidenceId, latest.id],
          gorev: task.code || taskId,
          aciklama: 'Dönem öncesinde kaydedilen "risk/gecikme yok" notu ile güncel gecikmiş görev durumu uyuşmuyor.'
        });
      } else if (!isTaskOpen && BLOCKED_OR_NOT_DONE_RE.test(latestLower) && latest.donem_ici) {
        addConflict({
          tur: 'durum_not_uyusmazligi',
          kanitlar: [taskEvidenceId, latest.id],
          gorev: task.code || taskId,
          aciklama: 'Görev kaydı tamamlanmış görünürken dönem içi not işin tamamlanmadığını veya ertelendiğini bildiriyor.'
        });
      }
    }
  }

  // 3. Aynı kapsamdaki farklı görev notları arasında açık karşıt bildirim (ör. test ortamı hazır / hazır değil).
  const safeNotes = noteEntries.filter((entry) => !entry.guvenilmez_yonerge_iceriyor);
  const readyPositive = safeNotes.filter((entry) => READY_POSITIVE_RE.test(entry.metin.toLocaleLowerCase('tr-TR')));
  const readyNegative = safeNotes.filter((entry) => READY_NEGATIVE_RE.test(entry.metin.toLocaleLowerCase('tr-TR')));
  for (const pos of readyPositive) {
    for (const neg of readyNegative) {
      if (pos._taskId === neg._taskId) continue;
      addConflict({
        tur: 'notlar_arasi_celiski',
        kanitlar: [neg.id, pos.id],
        aciklama: 'Farklı görev notları aynı test/ortam hazırlığı hakkında karşıt bildirim taşıyor.'
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
  limits = REPORT_EVIDENCE_LIMITS
}) {
  // Açık rıza kapısı: `notlar: dahil` dışındaki hiçbir durumda korunan metin okunmaz.
  if (consent !== 'dahil') {
    return {
      versions: [],
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
  const candidateIds = candidateTasks.map((task) => task.id);

  if (candidateIds.length === 0) {
    return {
      versions: [],
      completeness: {
        riza: true,
        metin: 'kapsamda not okunacak görev yok',
        dahil: 0,
        disarida_kalan: 0,
        notsuz_gorev: 0,
        kirpilan: 0,
        denetim_kesik: false
      }
    };
  }

  const maxNoteChars = limits.maxNoteChars ?? REPORT_EVIDENCE_LIMITS.maxNoteChars;
  const maxAuditEvents = limits.maxNoteAuditEvents ?? REPORT_EVIDENCE_LIMITS.maxNoteAuditEvents;

  // Güncel açıklamalar ve yetkili MR_AuditLog açıklama sürümleri sınırlı iki okuma ile alınır.
  const currentResult = await turn.sql(signal, (executor) => readReportTaskNotes(executor, scope, candidateIds, {
    maxRows: maxTasksForNotes
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

  const allVersions = [];
  let tasksWithoutNotes = 0;
  for (const task of candidateTasks) {
    const taskVersions = reconstructTaskNoteChronology({
      task,
      currentNote: currentResult.notes.get(task.id) || null,
      auditEvents: auditByTask.get(task.id) || [],
      period,
      maxNoteChars
    });
    if (taskVersions.length === 0) {
      tasksWithoutNotes += 1;
      continue;
    }
    for (const version of taskVersions) {
      allVersions.push({
        ...version,
        _taskPriorityRank: task._priorityRank ?? 0
      });
    }
  }

  // Belirlenimci önceliklendirme: görev önceliği → dönem içi not → kronoloji (aynı görevde eskiden yeniye).
  allVersions.sort((left, right) => {
    if (left.taskId === right.taskId) {
      return left.surum_sira - right.surum_sira;
    }
    if (left._taskPriorityRank !== right._taskPriorityRank) {
      return left._taskPriorityRank - right._taskPriorityRank;
    }
    if (left.donem_ici !== right.donem_ici) {
      return left.donem_ici ? -1 : 1;
    }
    return left.taskId.localeCompare(right.taskId);
  });

  const maxSelectedNotes = limits.maxSelectedNotes ?? REPORT_EVIDENCE_LIMITS.maxSelectedNotes;
  const selected = allVersions.slice(0, maxSelectedNotes);
  const omittedCount = Math.max(0, allVersions.length - selected.length);
  const clippedCount = selected.filter((item) => item.kirpildi).length;

  const summaryParts = [];
  if (selected.length === 0) {
    summaryParts.push('not kaydı yok');
  } else if (omittedCount > 0) {
    summaryParts.push(`ilk ${selected.length} not (${omittedCount} not sınır nedeniyle dışarıda)`);
  } else {
    summaryParts.push(`${selected.length} not`);
  }
  if (tasksWithoutNotes > 0) summaryParts.push(`${tasksWithoutNotes} görev notsuz`);
  if (clippedCount > 0) summaryParts.push(`${clippedCount} not ${maxNoteChars} karakterde kırpıldı`);
  if (auditResult.truncated || currentResult.truncated) summaryParts.push('denetim/not okuması üst sınıra ulaştı');

  return {
    versions: selected,
    completeness: {
      riza: true,
      metin: summaryParts.join('; '),
      dahil: selected.length,
      disarida_kalan: omittedCount,
      notsuz_gorev: tasksWithoutNotes,
      kirpilan: clippedCount,
      denetim_kesik: Boolean(auditResult.truncated || currentResult.truncated)
    }
  };
}
