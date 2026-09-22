'use client';
import { useCallback, useMemo, useState } from 'react';
import { organizationPath } from '../../domain/assignment/assignmentCoordination.js';

/**
 * Görev düzenleyicisinin ATAMA TALEBİ taslağı.
 *
 * Taslak yalnızca arayüzdedir: talep edilen kişi hiçbir zaman `assigneeIds`
 * içine yazılmaz, bu yüzden iş yükü, Özet, Kanban, hatırlatma ve Outlook
 * onaylanmamış bir atamayı kabul edilmiş iş gibi görmez.
 *
 * Doğrudan atama yetkisi burada YALNIZCA arayüz için kestirilir; sorumlu kapsam
 * denetimi her durumda sunucuda yeniden yapılır ve son sözü o söyler.
 */
export function useAssignmentRequestDraft({ assignmentScopeOnly, canManageAssignees }) {
  const [requested, setRequested] = useState([]);
  const [note, setNote] = useState('');

  const canAssignDirectly = useCallback((person) => {
    if (!canManageAssignees) return false;
    if (!assignmentScopeOnly) return true;
    return assignmentScopeOnly.has(String(person?.sicil ?? ''));
  }, [assignmentScopeOnly, canManageAssignees]);

  const requestAssignee = useCallback((person) => {
    if (!person) return;
    setRequested((current) => (current.some((item) => String(item.sicil) === String(person.sicil))
      ? current
      : [...current, {
        sicil: String(person.sicil),
        name: person.name,
        organizationPath: organizationPath(person.organization || {})
      }]));
  }, []);

  const cancelRequest = useCallback((sicil) => {
    setRequested((current) => current.filter((item) => String(item.sicil) !== String(sicil)));
  }, []);

  const payload = useMemo(() => (requested.length ? {
    assigneeSicils: requested.map((person) => Number(person.sicil)),
    message: note.trim()
  } : null), [requested, note]);

  return {
    requested,
    note,
    setNote,
    canAssignDirectly,
    requestAssignee,
    cancelRequest,
    assignmentRequest: payload
  };
}
