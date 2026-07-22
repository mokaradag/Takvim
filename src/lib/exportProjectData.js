import { depId, formatDependencyLag, relTypeOf } from '../scheduling/dependencies/index.js';
import { fmt } from '../scheduling/dates/index.js';

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

function clean(value) {
  return value == null ? '' : String(value);
}

function escapeCsv(value) {
  const text = clean(value).replace(/"/g, '""');
  return /[;"\n\r]/.test(text) ? `"${text}"` : text;
}

function escapeHtml(value) {
  return clean(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function displayDate(value) {
  return value ? fmt(value, 'dd MMM yyyy') : '';
}

function dependencyText(dependency, taskById) {
  const predecessor = taskById.get(depId(dependency));
  const relation = relTypeOf(dependency);
  const lag = formatDependencyLag(dependency);
  return `${predecessor?.task || depId(dependency) || 'Bilinmeyen görev'} · ${relation}${lag ? ` · ${lag}` : ''}`;
}

export function buildExportRows({ tasks = [], wbs = [] } = {}) {
  const wbsById = new Map(wbs.map((node) => [node.id, node]));
  const taskById = new Map(tasks.map((task) => [task.id, task]));

  return tasks.map((task) => ({
    wbs: task.wbsId ? `${wbsById.get(task.wbsId)?.code || ''} ${wbsById.get(task.wbsId)?.name || ''}`.trim() : '',
    gorev: task.task || '',
    etiket: task.keyword || '',
    sorumlu: (task.sorumlu || []).join(', '),
    durum: STATUS_LABELS[task.status] || task.status || 'Yapılacak',
    oncelik: PRIORITY_LABELS[task.priority] || task.priority || 'Orta',
    baslangic: displayDate(task.plannedStart),
    bitis: displayDate(task.plannedFinish),
    hedef: displayDate(task.targetFinish),
    ilerleme: `${task.progress ?? (task.status === 'done' ? 100 : 0)}%`,
    iliskiler: (task.deps || []).map((dependency) => dependencyText(dependency, taskById)).join(' | ')
  }));
}

export function buildProjectCsv(input = {}) {
  const headers = ['WBS', 'Görev', 'Etiket', 'Sorumlu', 'Durum', 'Öncelik', 'Başlangıç', 'Bitiş', 'Hedef', 'İlerleme', 'İlişkiler'];
  const rows = buildExportRows(input);
  const keys = ['wbs', 'gorev', 'etiket', 'sorumlu', 'durum', 'oncelik', 'baslangic', 'bitis', 'hedef', 'ilerleme', 'iliskiler'];
  return [
    headers.map(escapeCsv).join(';'),
    ...rows.map((row) => keys.map((key) => escapeCsv(row[key])).join(';'))
  ].join('\r\n');
}

export function buildProjectExcelHtml({ project = null, projects = [], tasks = [], wbs = [] } = {}) {
  const title = project?.name || 'MERGEN Rota Portföyü';
  const rows = buildExportRows({ tasks, wbs });
  const projectCount = project ? 1 : projects.length;
  const headers = ['WBS', 'Görev', 'Etiket', 'Sorumlu', 'Durum', 'Öncelik', 'Başlangıç', 'Bitiş', 'Hedef', 'İlerleme', 'İlişkiler'];
  const keys = ['wbs', 'gorev', 'etiket', 'sorumlu', 'durum', 'oncelik', 'baslangic', 'bitis', 'hedef', 'ilerleme', 'iliskiler'];
  const projectWbs = project ? wbs.filter((node) => node.projectId === project.id) : wbs;

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
body{font-family:Arial,sans-serif;color:#172033}h1{font-size:22px;margin:0 0 6px}p{color:#556070;margin:0 0 18px}.summary{border-collapse:collapse;margin-bottom:22px}.summary td{padding:7px 12px;border:1px solid #d8dee8}.summary td:first-child{font-weight:700;background:#eef4ff}table.data{border-collapse:collapse;width:100%;font-size:11px}.data th{background:#2f6fed;color:#fff;padding:8px;border:1px solid #2458bd;text-align:left}.data td{padding:7px;border:1px solid #d8dee8;vertical-align:top}.data tr:nth-child(even) td{background:#f7f9fc}.section{font-size:15px;font-weight:700;margin:24px 0 8px;color:#244a91}
</style></head><body>
<h1>${escapeHtml(title)}</h1>
<p>MERGEN Rota · Sürüm 1.0 dışa aktarma çıktısı</p>
<table class="summary"><tr><td>Proje sayısı</td><td>${projectCount}</td></tr><tr><td>Görev sayısı</td><td>${tasks.length}</td></tr><tr><td>WBS düğümü</td><td>${projectWbs.length}</td></tr>${project ? `<tr><td>Proje sorumlusu</td><td>${escapeHtml(project.lead || '')}</td></tr><tr><td>Veri tarihi</td><td>${escapeHtml(displayDate(project.dataDate))}</td></tr>` : ''}</table>
<div class="section">Görevler</div>
<table class="data"><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${keys.map((key) => `<td>${escapeHtml(row[key])}</td>`).join('')}</tr>`).join('')}</tbody></table>
<div class="section">İş Dağılım Ağacı</div>
<table class="data"><thead><tr><th>Kod</th><th>Ad</th><th>Üst Düğüm</th></tr></thead><tbody>${projectWbs.map((node) => `<tr><td>${escapeHtml(node.code)}</td><td>${escapeHtml(node.name)}</td><td>${escapeHtml(wbs.find((parent) => parent.id === node.parentId)?.name || '')}</td></tr>`).join('')}</tbody></table>
</body></html>`;
}

export function safeExportName(value) {
  return clean(value || 'MERGEN_Rota')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9ğüşöçıİĞÜŞÖÇ_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'MERGEN_Rota';
}
