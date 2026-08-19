'use client';
import { useEffect, useMemo, useState } from 'react';
import { DateInput } from '../../components/DateInput';
import { Icons } from '../../components/icons';
import { SearchableSelect } from '../../components/SearchableSelect';
import { Avatar, StatusIcon } from '../../components/ui';
import { PRIORITIES, normalizePriorityId } from '../../domain/constants';
import { TaskReminderButton } from '../reminders/TaskReminderButton';
import { useAllPeople } from '../../state/hooks';

/**
 * Basit Mod · Görev düzenleme.
 *
 * Yalnızca "Hızlı Görev Tanımı"nda toplanan alanları düzenler: görev, kısa
 * açıklama, sorumlular, termin, öncelik ve durum. İlerleme yüzdesi, efor
 * saatleri, planlanan başlangıç/bitiş, dağılım ağacı, bağımlılıklar ve tekrar
 * kuralı Gelişmiş Modda kalır — Basit Modda ne toplanır ne de gösterilir.
 *
 * Kayıt YAPISI aynıdır: aynı görev Gelişmiş Modda tüm alanlarıyla açılır.
 */
export function SimpleTaskDrawer({ task, onClose, onUpdate, onDelete }) {
  const people = useAllPeople();
  const [local, setLocal] = useState({ ...task });

  useEffect(() => { setLocal({ ...task }); }, [task]);

  const save = (patch) => {
    setLocal((current) => ({ ...current, ...patch }));
    onUpdate(task.id, patch);
  };

  const selectedAssignees = useMemo(() => {
    const ids = (local.assigneeIds || []).map((id) => String(id));
    return ids.map((id) => people.find((person) => String(person.id) === id)).filter(Boolean);
  }, [people, local.assigneeIds]);

  const personOptions = useMemo(() => {
    const selected = new Set(selectedAssignees.map((person) => String(person.id)));
    return people
      .filter((person) => !selected.has(String(person.id)))
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name, 'tr'))
      .map((person) => ({
        value: person.id,
        label: person.employeeNo ? `${person.employeeNo} · ${person.name}` : person.name,
        description: person.role || null,
        keywords: [person.name, person.employeeNo, person.username, person.team],
        icon: <Avatar name={person.name} person={person} size="sm" />
      }));
  }, [people, selectedAssignees]);

  const setAssignees = (ids) => {
    const unique = [...new Set(ids.map((id) => String(id)))];
    save({
      assigneeIds: unique,
      sorumlu: unique.map((id) => people.find((person) => String(person.id) === id)?.name).filter(Boolean)
    });
  };

  const priority = normalizePriorityId(local.priority);

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer simple-task-drawer" role="dialog" aria-label="Görev düzenle">
        <header className="drawer-head">
          <div className="col" style={{ gap: 2, minWidth: 0 }}>
            <span className="simple-mode-badge"><Icons.Sparkle size={12} /> Basit Mod</span>
            <span className="muted" style={{ fontSize: 11.5 }}>
              {local.projectCode ? `${local.projectCode} · ${local.proje}` : local.proje}
            </span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Kapat"><Icons.Close size={15} /></button>
        </header>

        <div className="drawer-body col" style={{ gap: 14 }}>
          <label className="simple-field">
            <span>Görev</span>
            <input
              className="input"
              value={local.task || ''}
              onChange={(event) => save({ task: event.target.value })}
              placeholder="Yapılacak işi yazın"
            />
          </label>

          <label className="simple-field">
            <span>Kısa açıklama</span>
            <input
              className="input"
              value={local.keyword || ''}
              onChange={(event) => save({ keyword: event.target.value })}
              placeholder="Örn. Teklif, Onay, Teslim"
            />
          </label>

          <div className="simple-field">
            <span>Sorumlular</span>
            <div className="simple-drawer-assignees">
              {selectedAssignees.map((person) => (
                <span key={person.id} className="simple-person active">
                  <Avatar name={person.name} person={person} size="sm" />
                  <span><strong>{person.name}</strong><small>{person.employeeNo || person.id}</small></span>
                  <button
                    type="button"
                    className="icon-btn"
                    style={{ width: 20, height: 20 }}
                    aria-label={`${person.name} kaldır`}
                    onClick={() => setAssignees(selectedAssignees
                      .filter((entry) => entry.id !== person.id)
                      .map((entry) => entry.id))}
                  >
                    <Icons.Close size={10} />
                  </button>
                </span>
              ))}
            </div>
            <SearchableSelect
              value=""
              options={personOptions}
              onChange={(personId) => personId && setAssignees([...selectedAssignees.map((person) => person.id), personId])}
              placeholder="Sorumlu ekle"
              searchPlaceholder="Ad, sicil veya birimle ara"
              ariaLabel="Sorumlu ekle"
            />
          </div>

          <label className="simple-field">
            <span>Termin tarihi</span>
            <DateInput
              value={local.targetFinish || ''}
              onChange={(value) => save({
                targetFinish: value || null,
                // Basit Modda plan ve termin aynı gündür: hızlı görev tanımı da
                // üç alanı birlikte yazar, iki mod arasında tutarsızlık olmaz.
                plannedStart: value || local.plannedStart,
                plannedFinish: value || local.plannedFinish
              })}
              allowEmpty
            />
          </label>

          <div className="simple-field">
            <span>Öncelik</span>
            <div className="simple-priority-picker" role="group" aria-label="Görev önceliği">
              {Object.values(PRIORITIES).map((option) => {
                const active = priority === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    className={`simple-priority-option${active ? ' active' : ''}`}
                    aria-pressed={active}
                    style={{ '--priority-color': option.color }}
                    // Zaten seçili öncelik yeniden yazılmaz: anlamsız bir yazma
                    // görev sürümünü ilerletip çakışma üretirdi.
                    disabled={active}
                    onClick={() => save({ priority: option.id })}
                  >
                    <Icons.Flag size={11} /> {option.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="simple-field">
            <span>Durum</span>
            <div className="seg" role="group" aria-label="Görev durumu">
              {[['todo', 'Yapılacak'], ['in_progress', 'Devam ediyor'], ['done', 'Tamamlandı']].map(([id, label]) => {
                const active = (local.status || 'todo') === id;
                return (
                  <button
                    key={id}
                    type="button"
                    className={active ? 'active' : ''}
                    aria-pressed={active}
                    disabled={active}
                    onClick={() => save({ status: id })}
                  >
                    <StatusIcon id={id} size={12} /> {label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="drawer-foot">
          <button
            className="btn"
            onClick={() => { if (confirm('Görev silinsin mi?')) { onDelete(task.id); onClose(); } }}
          >
            <Icons.Trash size={13} /> Sil
          </button>
          {/* Hatırlatma eylemi silme eyleminin YANINDA durur; iki modda da aynı. */}
          <TaskReminderButton task={task} size={30} />
          <div style={{ flex: 1 }} />
          <button className="btn primary" onClick={onClose}>Tamam</button>
        </div>
      </aside>
    </>
  );
}
