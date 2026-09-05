'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { DateInput } from '../../components/DateInput';
import { Icons } from '../../components/icons';
import { SearchableSelect } from '../../components/SearchableSelect';
import { Avatar, StatusIcon } from '../../components/ui';
import { PRIORITIES, normalizePriorityId } from '../../domain/constants';
import { findProjectTag, projectTagCatalog } from '../../domain/tags';
import { ownsSimpleModePlan } from './simpleTaskPlan.js';
import { TaskReminderButton } from '../reminders/TaskReminderButton';
import { useAllProjects, useAllPeople, useAssignmentScopeSicils, useTaskActions } from '../../state/hooks';
import { canWriteProject } from '../../state/projectWritePolicy.js';

/**
 * Temel Kip · Görev düzenleme.
 *
 * Yalnızca "Hızlı Görev Tanımı"nda toplanan alanları düzenler: görev, kısa
 * açıklama, sorumlular, termin, öncelik ve durum. İlerleme yüzdesi, efor
 * saatleri, planlanan başlangıç/bitiş, dağılım ağacı, bağımlılıklar ve tekrar
 * kuralı Kapsamlı Kipte kalır — Temel Kipte ne toplanır ne de gösterilir.
 *
 * Kayıt YAPISI aynıdır: aynı görev Kapsamlı Kipte tüm alanlarıyla açılır.
 */
export function SimpleTaskDrawer({ task, onClose, onUpdate, onDelete }) {
  const people = useAllPeople();
  const projects = useAllProjects();
  const assignmentScopeSicils = useAssignmentScopeSicils();
  const { cancelTaskFieldUpdates, updateProject } = useTaskActions();
  const [local, setLocal] = useState({ ...task });
  const [catalogWarning, setCatalogWarning] = useState(null);
  // Kalıcılaştırılmayan başlık taslağı — Kapsamlı Kipteki TaskDrawer ile aynı
  // davranış. Sunucu boş başlığı reddettiği için silinmiş metin kuyruğa hiç
  // girmez; taslak burada tutulmasaydı gelen yeni `task` nesnesi silinen
  // başlığı geri yazardı.
  const titleDraftRef = useRef(null);

  useEffect(() => { titleDraftRef.current = null; }, [task.id]);

  useEffect(() => {
    setLocal((current) => {
      const draft = titleDraftRef.current;
      return draft === null ? { ...task } : { ...task, task: draft };
    });
  }, [task]);

  const project = useMemo(
    () => projects.find((item) => item.id === task.projectId) || null,
    [projects, task.projectId]
  );

  const save = (patch) => {
    setLocal((current) => ({ ...current, ...patch }));
    onUpdate(task.id, patch);
  };

  const changeTitle = (value) => {
    setLocal((current) => ({ ...current, task: value }));
    if (String(value).trim()) {
      titleDraftRef.current = null;
      onUpdate(task.id, { task: value });
      return;
    }
    titleDraftRef.current = value;
    cancelTaskFieldUpdates?.(task.id, ['task']);
  };

  /**
   * Kısa açıklamayı proje etiket KATALOĞUYLA uyumlu kaydeder.
   *
   * Serbest metin doğrudan yazıldığında katalogda karşılığı olmayan bir etiket
   * kalıyor ve katalog tabanlı seçiciler, yeniden adlandırma ile renk yayılımı
   * bu değeri temsil edemiyordu. Katalog yazması ikincildir: proje üst verisi
   * yazılamıyorsa (atama kapsamı) görev etiketi yine korunur.
   */
  const commitKeyword = async (value) => {
    const requested = String(value || '').trim();
    setCatalogWarning(null);
    if (!requested) {
      onUpdate(task.id, { keyword: '' });
      return;
    }
    const catalog = projectTagCatalog(project);
    const existing = findProjectTag(catalog, requested);
    if (existing) {
      setLocal((current) => ({ ...current, keyword: existing.name }));
      onUpdate(task.id, { keyword: existing.name });
      return;
    }
    if (canWriteProject(project)) {
      const result = await updateProject(project.id, { tags: [...catalog, { name: requested }] });
      if (!result?.ok) {
        setCatalogWarning('Etiket proje kataloğuna eklenemedi; görevde saklandı.');
      }
    }
    onUpdate(task.id, { keyword: requested });
  };

  const selectedAssignees = useMemo(() => {
    const ids = (local.assigneeIds || []).map((id) => String(id));
    return ids.map((id) => people.find((person) => String(person.id) === id)).filter(Boolean);
  }, [people, local.assigneeIds]);

  // Atama kapsamıyla açılan projede sunucu, sorumluların tamamının yöneticinin
  // kapsamında olmasını şart koşar; seçici bütün rehberi gösterseydi kapsam dışı
  // bir kişi seçmek garanti reddedilen bir kayıt üretirdi (Kapsamlı Kipteki
  // TaskDrawer ile aynı kural).
  const assignmentScopeOnly = useMemo(() => {
    if (!assignmentScopeSicils.length) return null;
    if (project && canWriteProject(project)) return null;
    return new Set(assignmentScopeSicils.map(String));
  }, [assignmentScopeSicils, project]);

  const personOptions = useMemo(() => {
    const selected = new Set(selectedAssignees.map((person) => String(person.id)));
    return people
      .filter((person) => !selected.has(String(person.id)))
      .filter((person) => !assignmentScopeOnly || assignmentScopeOnly.has(String(person.id)))
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name, 'tr'))
      .map((person) => ({
        value: person.id,
        label: person.employeeNo ? `${person.employeeNo} · ${person.name}` : person.name,
        description: person.role || null,
        keywords: [person.name, person.employeeNo, person.username, person.team],
        icon: <Avatar name={person.name} person={person} size="sm" />
      }));
  }, [people, selectedAssignees, assignmentScopeOnly]);

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
            <span className="simple-mode-badge"><Icons.Sparkle size={12} /> Temel Kip</span>
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
              onChange={(event) => changeTitle(event.target.value)}
              placeholder="Yapılacak işi yazın"
            />
          </label>

          <label className="simple-field">
            <span>Kısa açıklama</span>
            <input
              className="input"
              value={local.keyword || ''}
              // Yazarken yalnızca yerel taslak güncellenir; katalog eşlemesi ve
              // kalıcılaştırma alan bırakıldığında yapılır, böylece her tuş
              // vuruşu proje kataloğuna yazma denemesine dönüşmez.
              onChange={(event) => setLocal((current) => ({ ...current, keyword: event.target.value }))}
              onBlur={(event) => commitKeyword(event.target.value)}
              placeholder="Örn. Teklif, Onay, Teslim"
            />
            {catalogWarning && <small className="muted">{catalogWarning}</small>}
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
              onChange={(value) => save(ownsSimpleModePlan(task)
                // Temel Kipte plan ve termin aynı gündür: hızlı görev tanımı da
                // üç alanı birlikte yazar, iki kip arasında tutarsızlık olmaz.
                ? {
                  targetFinish: value || null,
                  plannedStart: value || local.plannedStart,
                  plannedFinish: value || local.plannedFinish
                }
                // Kapsamlı Kipte kurulmuş bir plan Temel Kipten EZİLMEZ:
                // yalnızca terminin düzenlenmesi, görevin Gantt/CPM sonuçlarını
                // değiştiren gizli planını yok ederdi.
                : { targetFinish: value || null })}
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
          {/* Hatırlatma eylemi silme eyleminin YANINDA durur; iki kipte de aynı. */}
          <TaskReminderButton task={task} size={30} />
          <div style={{ flex: 1 }} />
          <button className="btn primary" onClick={onClose}>Tamam</button>
        </div>
      </aside>
    </>
  );
}
