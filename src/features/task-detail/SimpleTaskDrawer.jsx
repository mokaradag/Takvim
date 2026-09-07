'use client';
import { useAppState } from '../../state/AppStateProvider';
import { taskPersonnelScope } from '../../state/taskPersonnelScope.js';
import { useEffect, useMemo, useState } from 'react';
import { DateInput } from '../../components/DateInput';
import { Icons } from '../../components/icons';
import { Spinner } from '../../components/Loader';
import { SearchableSelect } from '../../components/SearchableSelect';
import { Avatar, StatusIcon } from '../../components/ui';
import { PRIORITIES, normalizePriorityId } from '../../domain/constants';
import { ownsSimpleModePlan } from './simpleTaskPlan.js';
import { filterTaskAssigneeCandidates, resolveTaskAssigneeDisplayRecords, taskAssigneeMutationPatch } from './taskAssigneeDisplay.js';
import { simpleAssigneeNumber } from '../simple/simpleAssigneeSearch.js';
import { TaskReminderButton } from '../reminders/TaskReminderButton';
import { ScheduleChangeDialog } from '../schedule-change/ScheduleChangeDialog.jsx';
import { useAllProjects, useAllPeople, useAssignmentScopeSicils } from '../../state/hooks';
import { TaskCreatorByline } from './TaskCreatorByline.jsx';

/**
 * Temel Kip · Görev düzenleme.
 *
 * Yalnızca "Hızlı Görev Tanımı"nda toplanan alanları düzenler: görev, kısa
 * açıklama, sorumlular, termin, öncelik ve durum. İlerleme yüzdesi,
 * planlanan başlangıç/bitiş, dağılım ağacı, bağımlılıklar ve tekrar
 * kuralı Kapsamlı Kipte kalır — Temel Kipte ne toplanır ne de gösterilir.
 *
 * Kayıt YAPISI aynıdır: aynı görev Kapsamlı Kipte tüm alanlarıyla açılır.
 */
export function SimpleTaskDrawer({
  task,
  onClose,
  onUpdate,
  onDelete,
  canManageAssignees = true,
  canControlSchedule = true,
  // Termin AYRI bir yetkidir: sorumlu kendi planladığı tarihleri güncelleyebilir
  // (`canControlSchedule`) ama görevi kendisi oluşturmadıysa HEDEF BİTİŞİ
  // değiştiremez. Tek bayrağa bakan alan, sunucunun FORBIDDEN döndüğü bir
  // düzenlemeyi açık bırakıyordu.
  canEditTargetFinish = true,
  canProposeSchedule = false,
  scheduleRequests = [],
  onProposeSchedule = null,
  canDelete = true,
  isSaving = false,
  saveError = null,
  isCreating = false,
  onSave = null,
  creatorFallback = null
}) {
  const people = useAllPeople();
  const { isExecutive, isSystemAdmin } = useAppState();
  const projects = useAllProjects();
  const assignmentScopeSicils = useAssignmentScopeSicils();
  const [local, setLocal] = useState({ ...task });
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  useEffect(() => { setLocal({ ...task }); }, [task]);
  const titleDraft = local.task || '';
  const titleValid = Boolean(titleDraft.trim());

  const project = useMemo(
    () => projects.find((item) => item.id === task.projectId) || null,
    [projects, task.projectId]
  );

  const save = (patch) => {
    if (isSaving) return;
    setLocal((current) => ({ ...current, ...patch }));
    onUpdate(task.id, patch);
  };

  const dismiss = onClose;
  const primaryAction = () => onSave?.({ ...local, task: titleDraft.trim(), keyword: String(local.keyword || '').trim() });

  const selectedAssignees = useMemo(() => {
    // Fotoğraf kimlikleri de taşınır: rehberde çözülemeyen eş sorumlular için
    // görev satırındaki `assigneeAvatarIdentities` tek fotoğraf kaynağıdır.
    // Kırpılmış nesne bu alanı dışarıda bıraktığı için kartta herkes baş harfe
    // düşüyordu (liste sütunu aynı veriyle fotoğrafı gösteriyordu).
    return resolveTaskAssigneeDisplayRecords({
      assigneeIds: local.assigneeIds,
      assigneeDisplayNames: local.assigneeDisplayNames,
      assigneeAvatarIdentities: local.assigneeAvatarIdentities,
      sorumlu: local.sorumlu
    }, people, !canManageAssignees);
  }, [
    people,
    local.assigneeIds,
    local.assigneeDisplayNames,
    local.assigneeAvatarIdentities,
    local.sorumlu,
    canManageAssignees
  ]);
  const hiddenAssigneeCount = Math.max(
    0,
    Number(local.assigneeCount || 0) - selectedAssignees.length
  );

  // Atama kapsamıyla açılan projede sunucu, sorumluların tamamının yöneticinin
  // kapsamında olmasını şart koşar; seçici bütün rehberi gösterseydi kapsam dışı
  // bir kişi seçmek garanti reddedilen bir kayıt üretirdi (Kapsamlı Kipteki
  // TaskDrawer ile aynı kural).
  const assignmentScopeOnly = useMemo(() => taskPersonnelScope({
    project: project, isExecutive, isSystemAdmin, assignmentScopeSicils
  }), [project, isExecutive, isSystemAdmin, assignmentScopeSicils]);

  const personOptions = useMemo(() => {
    return filterTaskAssigneeCandidates(people, selectedAssignees)
      .filter((person) => !assignmentScopeOnly || assignmentScopeOnly.has(String(simpleAssigneeNumber(person))))
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
    save(taskAssigneeMutationPatch(local, people, ids));
  };

  const priority = normalizePriorityId(local.priority);
  const pendingScheduleRequest = scheduleRequests.find(
    (request) => request.status === 'PENDING' && request.isRequester
  ) || null;
  // Temel Kipte plan tarihleri gizlidir; sorumlu yalnızca termin (hedef bitiş)
  // için öneri gönderir.
  const proposableScheduleFields = canControlSchedule && !canEditTargetFinish ? ['targetFinish'] : null;

  return (
    <>
      <div className="drawer-backdrop" onClick={dismiss} />
      <aside className="drawer simple-task-drawer" role="dialog" aria-label="Görev düzenle">
        <header className="drawer-head">
          <div className="col" style={{ gap: 2, minWidth: 0 }}>
            <span className="simple-mode-badge"><Icons.Sparkle size={12} /> Temel Kip</span>
            <span className="muted" style={{ fontSize: 11.5 }}>
              {local.projectCode ? `${local.projectCode} · ${local.proje}` : local.proje}
            </span>
            <TaskCreatorByline task={task} people={people} fallback={creatorFallback} />
          </div>
          <button className="icon-btn" onClick={dismiss} disabled={isSaving} aria-label="Kapat"><Icons.Close size={15} /></button>
        </header>

        <fieldset className="drawer-body col" style={{ gap: 14 }} disabled={isSaving}>
          <label className="simple-field">
            <span>Görev</span>
            <input
              className="input"
              value={titleDraft}
              onChange={(event) => save({ task: event.target.value })}
              aria-invalid={!titleValid}
              placeholder="Yapılacak işi yazın"
            />
            {!titleValid && (
              <span className="drawer-title-warning">
                <Icons.Alert size={12} /> Kaydetmek için görev başlığı girin.
              </span>
            )}
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
              {selectedAssignees.map((record) => (
                <span key={record.key} className="simple-person active">
                  <Avatar name={record.name} person={record.person} size="sm" />
                  <span><strong>{record.name}</strong><small>{record.person?.employeeNo || 'Görev sorumlusu'}</small></span>
                  {canManageAssignees && record.id != null && <button
                    type="button"
                    className="icon-btn"
                    style={{ width: 20, height: 20 }}
                    aria-label={`${record.name} kaldır`}
                    onClick={() => setAssignees((local.assigneeIds || [])
                      .filter((id) => String(id) !== String(record.id)))}
                  >
                    <Icons.Close size={10} />
                  </button>}
                </span>
              ))}
            </div>
            <SearchableSelect
              value=""
              options={personOptions}
              onChange={(personId) => personId && setAssignees([
                ...(local.assigneeIds || []),
                personId
              ])}
              placeholder="Sorumlu ekle"
              searchPlaceholder="Ad, sicil veya birimle ara"
              ariaLabel="Sorumlu ekle"
              disabled={!canManageAssignees}
            />
            {!canManageAssignees && (
              <small className="muted">
                Sorumlu listesi görüntülenebilir; değiştirmek için tam proje yetkisi gerekir.
                {hiddenAssigneeCount > 0
                  ? ` ${hiddenAssigneeCount} sorumlunun adı personel kaydında bulunamadığı için gösterilemiyor.`
                  : ''}
              </small>
            )}
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
              disabled={!canControlSchedule || !canEditTargetFinish}
            />
            {!canControlSchedule && (
              <small className="muted">Bu görevin plan tarihleri görev oluşturucusunun onayıyla değiştirilir.</small>
            )}
            {canControlSchedule && !canEditTargetFinish && (
              <small className="muted">Termin tarihini yalnızca görevi oluşturan kişi değiştirebilir.</small>
            )}
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
              {[['todo', 'Yapılacak'], ['in_progress', 'Devam ediyor'], ['done', 'Tamamlandı']].filter(([id]) => !(task.milestone || task.isMilestone) || id !== 'in_progress').map(([id, label]) => {
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
        </fieldset>

        {saveError && <div className="drawer-save-error" role="alert">{saveError}</div>}
        <div className="drawer-foot">
          {!isCreating && canDelete && <button
            className="btn"
            disabled={isSaving}
            onClick={() => { if (confirm('Görev silinsin mi?')) { onDelete(task.id); onClose(); } }}
          >
            <Icons.Trash size={13} /> Sil
          </button>}
          {/* Hatırlatma eylemi silme eyleminin YANINDA durur; iki kipte de aynı. */}
          {!isCreating && <TaskReminderButton task={task} size={30} />}
          {!isCreating && canProposeSchedule && <button
            type="button"
            className="btn schedule-propose-button"
            onClick={() => setScheduleDialogOpen(true)}
          >
            <Icons.Calendar size={13} /> {pendingScheduleRequest ? 'Öneriyi değiştir' : 'Yeni tarih öner'}
          </button>}
          <div style={{ flex: 1 }} />
          <button className="btn primary" onClick={primaryAction} disabled={isSaving || !titleValid} aria-busy={isSaving}>
            {isSaving ? <Spinner size={13} /> : <Icons.Save size={14} />} {isSaving ? 'Kaydediliyor…' : 'Kaydet'}
          </button>
        </div>
      </aside>
      {scheduleDialogOpen && onProposeSchedule && (
        <ScheduleChangeDialog
          task={task}
          onCancel={() => setScheduleDialogOpen(false)}
          onSubmit={onProposeSchedule}
          fields={proposableScheduleFields}
        />
      )}
    </>
  );
}
