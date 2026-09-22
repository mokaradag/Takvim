import { escapeHtml } from '../reminders/reminderTemplate.js';
import { resolvePriority } from '../constants/index.js';

/**
 * Atama bildirim postasının içeriği — SAF işlev.
 *
 * Veritabanı, ağ ve React bağımlılığı yoktur; aynı kod hem teslimat yolunda
 * hem de testte çalışır. Dinamik değerler HTML'e KAÇIRILARAK yazılır.
 *
 * İçerik bilinçli olarak KISADIR: görev, proje, atayan, öncelik, hedef/termin,
 * değişiklik özeti ve varsa uygulama bağlantısı. Görev açıklaması, eş sorumlu
 * listesi ve finans alanları taşınmaz.
 */

const APP_NAME = 'MERGEN Rota';

function formatDate(value) {
  if (!value) return '—';
  const text = String(value).slice(0, 10);
  const [year, month, day] = text.split('-');
  return year && month && day ? `${day}.${month}.${year}` : text;
}

function rows(entries) {
  return entries
    .filter(([, value]) => value != null && value !== '')
    .map(([label, value]) => `<tr><td style="padding:4px 12px 4px 0;color:#64748b;">${escapeHtml(label)}</td>`
      + `<td style="padding:4px 0;font-weight:600;">${escapeHtml(value)}</td></tr>`)
    .join('');
}

/**
 * @param {object} payload `MR_TaskMailOutbox.PayloadJson` içeriği
 * @returns {{subject: string, html: string, text: string}}
 */
export function buildTaskAssignmentMail(payload = {}) {
  const taskTitle = String(payload.taskTitle || 'Görev');
  const projectLabel = [payload.projectCode, payload.projectName].filter(Boolean).join(' · ');
  const priority = payload.priority ? resolvePriority(payload.priority).label : null;
  const targetLabel = payload.simpleMode ? 'Termin' : 'Hedef';
  const action = payload.kind === 'TASK_UNASSIGNED' ? 'kaldırıldı' : 'atandı';
  const subject = payload.kind === 'TASK_UNASSIGNED'
    ? `${APP_NAME} · Görev sorumluluğunuz kaldırıldı: ${taskTitle}`
    : `${APP_NAME} · Size görev atandı: ${taskTitle}`;

  const detail = rows([
    ['Görev', taskTitle],
    ['Proje', projectLabel],
    [payload.kind === 'TASK_UNASSIGNED' ? 'Kaldıran' : 'Atayan', payload.actorName],
    ['Öncelik', priority],
    [targetLabel, payload.targetFinish ? formatDate(payload.targetFinish) : null],
    ['Değişiklik', payload.changeSummary]
  ]);

  const link = typeof payload.link === 'string' && /^https?:\/\//i.test(payload.link) ? payload.link : null;
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#0f172a;">`
    + `<p style="margin:0 0 12px;">${escapeHtml(`"${taskTitle}" görevinin sorumluluğu ${action}.`)}</p>`
    + `<table style="border-collapse:collapse;font-size:13px;">${detail}</table>`
    + (link ? `<p style="margin:14px 0 0;"><a href="${escapeHtml(link)}">${escapeHtml(APP_NAME)} uygulamasında aç</a></p>` : '')
    + `<p style="margin:16px 0 0;color:#94a3b8;font-size:12px;">Bu ileti ${escapeHtml(APP_NAME)} tarafından otomatik gönderildi.</p>`
    + `</div>`;

  const text = [
    `"${taskTitle}" görevinin sorumluluğu ${action}.`,
    projectLabel ? `Proje: ${projectLabel}` : null,
    payload.actorName ? `${payload.kind === 'TASK_UNASSIGNED' ? 'Kaldıran' : 'Atayan'}: ${payload.actorName}` : null,
    priority ? `Öncelik: ${priority}` : null,
    payload.targetFinish ? `${targetLabel}: ${formatDate(payload.targetFinish)}` : null,
    payload.changeSummary ? `Değişiklik: ${payload.changeSummary}` : null,
    link
  ].filter(Boolean).join('\n');

  return { subject, html, text };
}
