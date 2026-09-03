'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { DateInput } from '../../components/DateInput.jsx';
import { fmt } from '../../scheduling/dates/index.js';
import { Icons } from '../../components/icons.jsx';
import {
  SCHEDULE_DATE_ROWS,
  reconcileScheduleProposal,
  scheduleDifferenceSummary
} from './scheduleChangePresentation.js';
import { useModalFocusTrap } from './useModalFocusTrap.js';

export function ScheduleChangeDialog({ task, onCancel, onSubmit }) {
  const current = useMemo(() => ({
    plannedStart: task.plannedStart || null,
    plannedFinish: task.plannedFinish || null,
    targetFinish: task.targetFinish || null
  }), [task.plannedStart, task.plannedFinish, task.targetFinish]);
  const [proposed, setProposed] = useState(current);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const messageRef = useRef(null);
  const dialogRef = useRef(null);
  const dirtyDateFieldsRef = useRef(new Set());
  const summary = useMemo(() => scheduleDifferenceSummary(current, proposed), [current, proposed]);

  useEffect(() => {
    setProposed((dates) => reconcileScheduleProposal(
      current,
      dates,
      dirtyDateFieldsRef.current
    ));
  }, [current]);

  useModalFocusTrap({
    containerRef: dialogRef,
    initialFocusRef: messageRef,
    onClose: onCancel,
    blocked: busy
  });

  const submit = async (event) => {
    event.preventDefault();
    if (!summary.length) {
      setError('En az bir tarih mevcut plandan farklı olmalıdır.');
      return;
    }
    if (proposed.plannedStart && proposed.plannedFinish && proposed.plannedFinish < proposed.plannedStart) {
      setError('Planlanan bitiş, planlanan başlangıçtan önce olamaz.');
      return;
    }
    if (!message.trim()) {
      setError('Değişiklik gerekçesini yazın.');
      messageRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    let result;
    try {
      result = await onSubmit({ taskId: task.id, proposedDates: proposed, message: message.trim() });
    } catch (submissionError) {
      setError(submissionError?.message || 'Tarih değişikliği talebi gönderilemedi.');
      return;
    } finally {
      setBusy(false);
    }
    if (!result?.ok) {
      setError(result?.error?.message || 'Tarih değişikliği talebi gönderilemedi.');
      return;
    }
    onCancel();
  };

  return (
    <div className="schedule-modal-layer" role="presentation">
      <button className="schedule-modal-backdrop" type="button" aria-label="Tarih talebi penceresini kapat" onClick={onCancel} disabled={busy} />
      <form ref={dialogRef} className="schedule-modal" role="dialog" aria-modal="true" aria-labelledby="schedule-change-title" onSubmit={submit} tabIndex={-1}>
        <header className="schedule-modal-head">
          <div>
            <span className="schedule-modal-eyebrow"><Icons.Calendar size={12} /> Plan onayı</span>
            <h2 id="schedule-change-title">Yeni tarih öner</h2>
            <p>Görev tarihleri hemen değişmez. Öneri, görevi oluşturan kişinin kararına gönderilir.</p>
          </div>
          <button className="icon-btn" type="button" onClick={onCancel} aria-label="Kapat" disabled={busy}><Icons.Close size={15} /></button>
        </header>

        <table className="schedule-compare">
          <caption className="sr-only">Mevcut ve önerilen görev tarihleri</caption>
          <thead>
            <tr className="schedule-compare-head">
              <th scope="col"><span className="sr-only">Tarih alanı</span></th>
              <th scope="col">Mevcut</th>
              <th scope="col">Önerilen</th>
            </tr>
          </thead>
          <tbody>
            {SCHEDULE_DATE_ROWS.map(({ key, label }) => (
              <tr className="schedule-compare-row" key={key}>
                <th scope="row">{label}</th>
                {/* Tarih, kullanıcının biçim tercihiyle çizilir. Ham saklanan
                    değer yazıldığında aynı iletişim kutusunda iki farklı tarih
                    biçimi görünüyordu (`scheduleDifferenceSummary` zaten `fmt`
                    kullanır). */}
                <td className="tabular">{current[key] ? fmt(current[key], 'dd MMM yyyy') : '—'}</td>
                <td>
                  <DateInput
                    value={proposed[key] || ''}
                    onChange={(value) => {
                      dirtyDateFieldsRef.current.add(key);
                      setProposed((dates) => ({ ...dates, [key]: value || null }));
                    }}
                    ariaLabel={`${label} önerisi`}
                    allowEmpty
                    disabled={busy}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {summary.length > 0 && (
          <div className="schedule-difference-summary">
            {summary.map((item) => <span key={item}>{item}</span>)}
          </div>
        )}

        <label className="schedule-message-field">
          <span>Değişiklik gerekçesi</span>
          <textarea
            ref={messageRef}
            className="input"
            rows={3}
            maxLength={2000}
            name="scheduleChangeReason"
            value={message}
            disabled={busy}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Yeni tarihin neden gerekli olduğunu kısaca açıklayın"
          />
        </label>
        {error && <div className="schedule-modal-error" role="alert"><Icons.Alert size={13} /> {error}</div>}
        <footer className="schedule-modal-actions">
          <button className="btn" type="button" onClick={onCancel} disabled={busy}>Vazgeç</button>
          <button className="btn primary" type="submit" disabled={busy} aria-busy={busy}>
            <Icons.Calendar size={13} /> {busy ? 'Gönderiliyor…' : 'Değişiklik öner'}
          </button>
        </footer>
      </form>
    </div>
  );
}
