import { normalizePriorityId } from '../domain/constants/index.js';
import { depId, formatDependencyLag, relTypeOf } from '../scheduling/dependencies/index.js';
import { fmtDisplayDate, fmtISO, today } from '../scheduling/dates/index.js';
import { formatRecurrenceRule } from '../scheduling/recurrence/index.js';
import { buildZipArchive, encodeUtf8 } from './xlsx/zipArchive.js';
import { buildXlsxWorkbook, excelSerialDate, neutralizeCellText } from './xlsx/xlsxWorkbook.js';

const STATUS_LABELS = {
  todo: 'Yapılacak',
  in_progress: 'Devam ediyor',
  done: 'Tamamlandı'
};

const PRIORITY_LABELS = {
  low: 'Düşük',
  medium: 'Orta',
  high: 'Yüksek',
  critical: 'Kritik'
};

/** Dışa aktarım sütunları tek yerde tanımlıdır; CSV ve Excel aynı sırayı kullanır. */
export const EXPORT_HEADERS = Object.freeze([
  'WBS', 'Görev', 'Etiket', 'Sorumlu', 'Durum', 'Öncelik', 'Başlangıç', 'Bitiş', 'Hedef',
  'İlerleme', 'İlişkiler', 'Tekrar Kuralı', 'Seri', 'Seri Günü'
]);
export const EXPORT_KEYS = Object.freeze([
  'wbs', 'gorev', 'etiket', 'sorumlu', 'durum', 'oncelik', 'baslangic', 'bitis', 'hedef',
  'ilerleme', 'iliskiler', 'tekrarKurali', 'seri', 'seriGunu'
]);

function clean(value) {
  return value == null ? '' : String(value);
}

function neutralizeSpreadsheetFormula(value) {
  return neutralizeCellText(clean(value));
}

function escapeCsv(value) {
  const text = neutralizeSpreadsheetFormula(value).replace(/"/g, '""');
  return /[;"\n\r]/.test(text) ? `"${text}"` : text;
}

function displayDate(value) {
  if (!value) return '';
  // XLSX yazıcısı geçersiz ya da 1900 öncesi bir günü metne düşürür. CSV de
  // aynı değeri korur; `Date` taşmasına izin verilirse 30 Şubat sessizce
  // 2 Mart olarak dışa aktarılır ve iki biçim birbiriyle çelişir.
  return excelSerialDate(value) == null ? clean(value) : fmtDisplayDate(value);
}

function dependencyText(dependency, taskById) {
  const predecessor = taskById.get(depId(dependency));
  const relation = relTypeOf(dependency);
  const lag = formatDependencyLag(dependency);
  return `${predecessor?.task || 'Bilinmeyen görev'} · ${relation}${lag ? ` · ${lag}` : ''}`;
}

/**
 * Tekrar serisi bilgisi dışa aktarımda taşınır.
 *
 * Kural RFC 5545 `RRULE` gövdesi olarak yazılır; şablon ile yinelemeleri
 * birbirine bağlayan seri kimliği ve yinelemenin değişmez günü de ayrı
 * sütunlarda çıkar. Aksi hâlde tekrarlayan bir proje dışa aktarıldığında hem
 * kural hem de seri ilişkisi düşer ve satırlar sıradan görevlerden ayırt
 * edilemezdi.
 */
function recurrenceColumns(task, taskById) {
  const rule = task.recurrence ? formatRecurrenceRule(task.recurrence) : '';
  const template = task.recurrenceParentId ? taskById.get(task.recurrenceParentId) : null;
  return {
    tekrarKurali: rule ? `RRULE:${rule}` : '',
    seri: task.recurrenceParentId
      ? (template?.task || '')
      : (rule ? task.task || '' : ''),
    seriGunu: task.recurrenceOccurrenceDate || ''
  };
}

function taskProgress(task) {
  const raw = task.progress ?? (task.status === 'done' ? 100 : 0);
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : 0;
}

/**
 * Görev satırlarının KANONİK biçimi: tarihler ISO, ilerleme sayıdır.
 *
 * Excel gerçek tarih ve yüzde hücreleri ister (sıralama ve süzme ancak öyle
 * çalışır); CSV ise okunur biçimi yazar. İki çıktı aynı satır modelinden
 * türetilir, böylece iki dışa aktarım birbirinden ayrı düşmez.
 */
export function buildTaskSheetRows({ tasks = [], wbs = [] } = {}) {
  const wbsById = new Map(wbs.map((node) => [node.id, node]));
  const taskById = new Map(tasks.map((task) => [task.id, task]));

  return tasks.map((task) => ({
    ...recurrenceColumns(task, taskById),
    proje: task.projectCode ? `${task.projectCode} · ${task.proje || ''}`.trim() : (task.proje || ''),
    wbs: task.wbsId ? `${wbsById.get(task.wbsId)?.code || ''} ${wbsById.get(task.wbsId)?.name || ''}`.trim() : '',
    gorev: task.task || '',
    etiket: task.keyword || '',
    sorumlu: (task.sorumlu || []).join(', '),
    durum: STATUS_LABELS[task.status] || task.status || 'Yapılacak',
    oncelik: PRIORITY_LABELS[normalizePriorityId(task.priority)] || 'Orta',
    baslangic: task.plannedStart || '',
    bitis: task.plannedFinish || '',
    hedef: task.targetFinish || '',
    ilerleme: taskProgress(task),
    iliskiler: (task.deps || []).map((dependency) => dependencyText(dependency, taskById)).join(' | ')
  }));
}

/** Eski düz CSV sözleşmesi: bütün alanlar okunur metindir. */
export function buildExportRows(input = {}) {
  return buildTaskSheetRows(input).map((row) => ({
    ...row,
    baslangic: displayDate(row.baslangic),
    bitis: displayDate(row.bitis),
    hedef: displayDate(row.hedef),
    seriGunu: displayDate(row.seriGunu),
    ilerleme: `${row.ilerleme}%`
  }));
}

export function buildProjectCsv(input = {}) {
  const headers = EXPORT_HEADERS;
  const rows = buildExportRows(input);
  const keys = EXPORT_KEYS;
  return [
    headers.map(escapeCsv).join(';'),
    ...rows.map((row) => keys.map((key) => escapeCsv(row[key])).join(';'))
  ].join('\r\n');
}

/* ── Çok sayfalı çıktı ────────────────────────────────────── */

function taskSheetColumns(includeProject) {
  return [
    ...(includeProject ? [{ header: 'Proje', key: 'proje', width: 28 }] : []),
    { header: 'WBS', key: 'wbs', width: 26 },
    { header: 'Görev', key: 'gorev', width: 46 },
    { header: 'Etiket', key: 'etiket', width: 16 },
    { header: 'Sorumlu', key: 'sorumlu', width: 26 },
    { header: 'Durum', key: 'durum', width: 14 },
    { header: 'Öncelik', key: 'oncelik', width: 11 },
    { header: 'Başlangıç', key: 'baslangic', width: 12, type: 'date' },
    { header: 'Bitiş', key: 'bitis', width: 12, type: 'date' },
    { header: 'Hedef', key: 'hedef', width: 12, type: 'date' },
    { header: 'İlerleme', key: 'ilerleme', width: 10, type: 'percent' },
    { header: 'İlişkiler', key: 'iliskiler', width: 32 },
    { header: 'Tekrar Kuralı', key: 'tekrarKurali', width: 24 },
    { header: 'Seri', key: 'seri', width: 22 },
    { header: 'Seri Günü', key: 'seriGunu', width: 12, type: 'date' }
  ];
}

function summaryRows({ project, projects, tasks, wbsNodes, taskRows, projectLead }) {
  const done = tasks.filter((task) => task.status === 'done').length;
  const inProgress = tasks.filter((task) => task.status === 'in_progress').length;
  const todo = tasks.length - done - inProgress;
  // Gün YEREL takvimden okunur. `toISOString()` UTC verir; UTC+3'te gece
  // yarısı ile 03:00 arasında bir önceki günü döndürüyor, "Geciken" sayısı
  // dünkü terminleri atlıyor ve "Rapor tarihi" bir gün geride yazılıyordu.
  const todayIso = fmtISO(today());
  const overdue = tasks.filter((task) => task.status !== 'done' && task.targetFinish && task.targetFinish < todayIso).length;
  const averageProgress = taskRows.length
    ? Math.round(taskRows.reduce((total, row) => total + row.ilerleme, 0) / taskRows.length)
    : 0;

  return [
    { alan: 'Kapsam', deger: project ? `${project.code ? `${project.code} · ` : ''}${project.name}` : 'Portföy · Tüm projeler' },
    { alan: 'Proje sayısı', deger: project ? 1 : projects.length, type: 'number' },
    { alan: 'Görev sayısı', deger: tasks.length, type: 'number' },
    { alan: 'Tamamlanan', deger: done, type: 'number' },
    { alan: 'Devam eden', deger: inProgress, type: 'number' },
    { alan: 'Yapılacak', deger: Math.max(0, todo), type: 'number' },
    { alan: 'Geciken', deger: overdue, type: 'number' },
    { alan: 'Ortalama ilerleme', deger: averageProgress, type: 'percent' },
    { alan: 'İş dağılım düğümü', deger: wbsNodes.length, type: 'number' },
    ...(projectLead ? [{ alan: 'Proje sorumlusu', deger: projectLead }] : []),
    ...(project?.dataDate ? [{ alan: 'Veri tarihi', deger: project.dataDate, type: 'date' }] : []),
    { alan: 'Rapor tarihi', deger: todayIso, type: 'date' }
  ];
}

/**
 * Çıktının sayfa modeli: hem `.xlsx` hem CSV paketi bu tanımdan üretilir.
 *
 * Bilinçli olarak DAR tutulur: özet, görevler, iş dağılım ağacı ve (portföy
 * çıktısında) proje listesi. Her satır ekranda da görülen bir bilgiyi taşır;
 * iç kimlikler, sürüm anahtarları ve yetki alanları dışarı çıkmaz.
 */
/**
 * Proje sorumlusunun görünen adı.
 *
 * Gerçek Sistem anlık görüntüsü projede yalnızca `leadId` (Sicil) taşır; `lead`
 * eski gösterim alanıdır ve kurumsal veride boştur. Ad çözülmezse sütun boş
 * bırakılır — dışarı Sicil yazılmaz.
 */
function projectLeadName(project, peopleById) {
  const direct = String(project?.lead || '').trim();
  if (direct) return direct;
  const person = project?.leadId == null ? null : peopleById.get(String(project.leadId));
  return person?.name || '';
}

export function buildExportSheets({ project = null, projects = [], tasks = [], wbs = [], people = [] } = {}) {
  const peopleById = new Map((people || []).map((person) => [String(person.id), person]));
  const scopeLabel = project ? `${project.code ? `${project.code} · ` : ''}${project.name}` : 'Portföy · Tüm projeler';
  const projectWbs = project ? wbs.filter((node) => node.projectId === project.id) : wbs;
  const taskRows = buildTaskSheetRows({ tasks, wbs });
  const wbsById = new Map(wbs.map((node) => [node.id, node]));
  const taskCountByWbs = new Map();
  for (const task of tasks) {
    if (!task.wbsId) continue;
    taskCountByWbs.set(task.wbsId, (taskCountByWbs.get(task.wbsId) || 0) + 1);
  }

  const sheets = [
    {
      name: 'Özet',
      title: `MERGEN Rota · ${scopeLabel}`,
      notes: ['Görev yönetimi dışa aktarma çıktısı'],
      autoFilter: false,
      columns: [
        { header: 'Alan', key: 'alan', width: 26 },
        // Değer sütununun türü SATIR BAŞINA değişir: sayaçlar sayı, tarihler
        // gerçek tarih, ortalama ilerleme yüzde hücresi olarak yazılır.
        { header: 'Değer', key: 'deger', width: 34, typeKey: 'degerType' }
      ],
      rows: summaryRows({
        project,
        projects,
        tasks,
        wbsNodes: projectWbs,
        taskRows,
        projectLead: projectLeadName(project, peopleById)
      })
        .map((row) => ({ alan: row.alan, deger: row.deger, degerType: row.type }))
    },
    {
      name: 'Görevler',
      title: `Görevler · ${scopeLabel}`,
      columns: taskSheetColumns(!project),
      rows: taskRows
    },
    {
      name: 'İş Dağılım Ağacı',
      title: `İş dağılım ağacı · ${scopeLabel}`,
      columns: [
        { header: 'Kod', key: 'kod', width: 16 },
        { header: 'Ad', key: 'ad', width: 44 },
        { header: 'Üst Düğüm', key: 'ust', width: 34 },
        { header: 'Görev', key: 'gorevSayisi', width: 10, type: 'number' }
      ],
      rows: projectWbs.map((node) => ({
        kod: node.code || '',
        ad: node.name || '',
        ust: wbsById.get(node.parentId)?.name || '',
        gorevSayisi: taskCountByWbs.get(node.id) || 0
      }))
    }
  ];

  // Proje listesi YALNIZCA portföy çıktısında anlamlıdır: tek proje dışa
  // aktarılırken aynı bilgi Özet sayfasında zaten duruyor.
  if (!project && projects.length) {
    const projectTaskStats = new Map();
    for (const task of tasks) {
      const key = String(task.projectId ?? '');
      const stats = projectTaskStats.get(key) || { total: 0, done: 0, progress: 0 };
      stats.total += 1;
      if (task.status === 'done') stats.done += 1;
      stats.progress += taskProgress(task);
      projectTaskStats.set(key, stats);
    }
    sheets.push({
      name: 'Projeler',
      title: 'Projeler',
      columns: [
        { header: 'Kod', key: 'kod', width: 16 },
        { header: 'Proje', key: 'ad', width: 36 },
        { header: 'Tür', key: 'tur', width: 22 },
        { header: 'Sorumlu', key: 'sorumlu', width: 24 },
        { header: 'Görev', key: 'gorev', width: 10, type: 'number' },
        { header: 'Tamamlanan', key: 'tamamlanan', width: 12, type: 'number' },
        { header: 'İlerleme', key: 'ilerleme', width: 10, type: 'percent' },
        { header: 'Veri Tarihi', key: 'veriTarihi', width: 12, type: 'date' }
      ],
      rows: projects.map((item) => {
        const stats = projectTaskStats.get(String(item.id)) || { total: 0, done: 0, progress: 0 };
        return {
          kod: item.code || '',
          ad: item.name || '',
          tur: item.projectTypeName || item.projectTypeCode || '',
          sorumlu: projectLeadName(item, peopleById),
          gorev: stats.total,
          tamamlanan: stats.done,
          ilerleme: stats.total ? Math.round(stats.progress / stats.total) : 0,
          veriTarihi: item.dataDate || ''
        };
      })
    });
  }

  return sheets;
}

export function buildProjectWorkbook(input = {}) {
  const title = input.project?.name || 'MERGEN Rota Portföyü';
  return buildXlsxWorkbook({
    title,
    creator: 'MERGEN Rota',
    sheets: buildExportSheets(input)
  });
}

/** Sayfa modelini CSV metnine çevirir (tarihler okunur biçimde yazılır). */
export function sheetToCsv(sheet) {
  const columns = sheet.columns || [];
  const lines = [columns.map((column) => escapeCsv(column.header)).join(';')];
  for (const row of sheet.rows || []) {
    lines.push(columns.map((column) => {
      const value = row[column.key];
      // Tür sütundan ya da (özet sayfasında olduğu gibi) satırdan gelir.
      const type = column.typeKey ? row[column.typeKey] : column.type;
      if (type === 'date') return escapeCsv(displayDate(value));
      if (type === 'percent') return escapeCsv(value === '' || value == null ? '' : `%${value}`);
      return escapeCsv(value);
    }).join(';'));
  }
  return lines.join('\r\n');
}

/**
 * CSV paketi: her sayfa ayrı bir `.csv` dosyası olarak tek ZIP içinde.
 *
 * CSV'nin sayfa kavramı yoktur; tek dosyada bölüm bölüm yazmak ise dosyayı
 * hiçbir ayrıştırıcının okuyamayacağı hâle getirirdi. Dosyalar UTF-8 BOM ile
 * yazılır, böylece Excel Türkçe karakterleri doğru açar.
 */
export function buildProjectCsvBundle(input = {}, { baseName = 'MERGEN_Rota' } = {}) {
  const sheets = buildExportSheets(input);
  return buildZipArchive(sheets.map((sheet, index) => ({
    name: `${baseName}/${String(index + 1).padStart(2, '0')}_${safeExportName(sheet.name)}.csv`,
    data: encodeUtf8(`﻿${sheetToCsv(sheet)}`)
  })));
}

export function safeExportName(value) {
  // `NFKD`, `ğ ü ş ö ç İ` harflerini taban harf + birleşen imle ayrıştırıyor;
  // izin listesi yalnızca BİRLEŞİK biçimleri tuttuğu için her im `_` oluyordu
  // ("Ağustos" → "Ag_ustos"). `NFC` birleşik biçimi korur.
  return clean(value || 'MERGEN_Rota')
    .normalize('NFC')
    .replace(/[^a-zA-Z0-9ğüşöçıİĞÜŞÖÇ_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'MERGEN_Rota';
}
