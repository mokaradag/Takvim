'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { DateInput } from '../../components/DateInput';
import { Icons } from '../../components/icons';
import { Spinner } from '../../components/Loader';
import { SearchableSelect } from '../../components/SearchableSelect';
import { Avatar, StatusIcon } from '../../components/ui';
import { PRIORITIES, normalizePriorityId } from '../../domain/constants';
import { findProjectTag, projectTagCatalog } from '../../domain/tags';
import { ownsSimpleModePlan } from './simpleTaskPlan.js';
import { filterTaskAssigneeCandidates, resolveTaskAssigneeDisplayRecords, taskAssigneeMutationPatch } from './taskAssigneeDisplay.js';
import { keywordDirtyFields, reconcileTaskDraft, runCurrentKeywordCommit } from './taskDraft.js';
import { canCloseWithTaskTitle, useTaskTitleDraft } from './taskTitleDraft.js';
import { simpleAssigneeNumber } from '../simple/simpleAssigneeSearch.js';
import { TaskReminderButton } from '../reminders/TaskReminderButton';
import { ScheduleChangeDialog } from '../schedule-change/ScheduleChangeDialog.jsx';
import { useAllProjects, useAllPeople, useAssignmentScopeSicils, useTaskActions } from '../../state/hooks';
import { canWriteProject } from '../../state/projectWritePolicy.js';
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
  isCreating = false,
  onSave = null,
  creatorFallback = null
}) {
  const people = useAllPeople();
  const projects = useAllProjects();
  const assignmentScopeSicils = useAssignmentScopeSicils();
  const { cancelTaskFieldUpdates, updateProject } = useTaskActions();
  const [local, setLocal] = useState({ ...task });
  const [catalogWarning, setCatalogWarning] = useState(null);
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const closingRef = useRef(null);
  const keywordDraftRef = useRef(null);
  const {
    draft: titleDraft,
    change: changeTitle,
    flush: flushTitle,
    valid: titleValid
  } = useTaskTitleDraft({
    canonicalTitle: task.task,
    persist: (value) => onUpdate(task.id, { task: value }),
    cancel: () => cancelTaskFieldUpdates?.(task.id, ['task'])
  });

  useEffect(() => {
    setLocal((current) => reconcileTaskDraft(
      task,
      current,
      keywordDirtyFields(keywordDraftRef.current)
    ).task);
  }, [task]);

  const project = useMemo(
    () => projects.find((item) => item.id === task.projectId) || null,
    [projects, task.projectId]
  );

  const save = (patch) => {
    setLocal((current) => ({ ...current, ...patch }));
    onUpdate(task.id, patch);
  };

  const closeWithTitle = () => {
    if (closingRef.current) return closingRef.current;
    if (!canCloseWithTaskTitle(titleDraft)) {
      return Promise.resolve({ ok: false, error: { code: 'TASK_TITLE_REQUIRED' } });
    }
    const closing = (async () => {
      const titleResult = await flushTitle();
      const closeResult = await onClose();
      return titleResult?.ok === false ? titleResult : closeResult;
    })();
    closingRef.current = closing;
    closing.finally(() => {
      if (closingRef.current === closing) closingRef.current = null;
    });
    return closing;
  };

  const saveCreationDraft = () => {
    if (!onSave || !canCloseWithTaskTitle(titleDraft)) {
      return Promise.resolve({ ok: false, error: { code: 'TASK_TITLE_REQUIRED' } });
    }
    return onSave({ ...local, task: titleDraft.trim() });
  };

  const dismiss = isCreating ? onClose : closeWithTitle;
  const primaryAction = isCreating ? saveCreationDraft : closeWithTitle;

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
    const draftAtCommit = keywordDraftRef.current;
    setCatalogWarning(null);
    // DEĞİŞMEYEN değer yeniden yazılmaz. `onBlur` her odak kaybında çalışıyor;
    // alana girip hiçbir şey değiştirmeden çıkan kullanıcı da `onUpdate`
    // çağrısını tetikliyor ve görev sürümü boş yere ilerliyordu. Öncelik ve
    // durum denetimleri bu boş yazmaları bilinçli olarak eler; etiket alanı da
    // aynı kuralı uygular.
    if (requested === String(task.keyword || '').trim()) {
      // Yerel taslak KALICI değere geri alınır. Yalnızca baştaki/sondaki boşluk
      // eklenmişse `requested` eşit çıkar ve yazma atlanır, ama `local.keyword`
      // ham taslağı tutmaya devam ederdi: kullanıcı kaydedilmemiş bir değer
      // görür, yenileme ya da yeniden açılışta o değer kaybolurdu.
      setLocal((current) => ({ ...current, keyword: task.keyword || '' }));
      keywordDraftRef.current = null;
      return;
    }
    if (!requested) {
      keywordDraftRef.current = null;
      onUpdate(task.id, { keyword: '' });
      return;
    }
    const catalog = projectTagCatalog(project);
    const existing = findProjectTag(catalog, requested);
    if (existing) {
      keywordDraftRef.current = null;
      setLocal((current) => ({ ...current, keyword: existing.name }));
      onUpdate(task.id, { keyword: existing.name });
      return;
    }
    if (canWriteProject(project)) {
      const settled = await runCurrentKeywordCommit({
        draftAtCommit,
        getCurrentDraft: () => keywordDraftRef.current,
        commit: () => updateProject(project.id, { tags: [...catalog, { name: requested }] })
      });
      if (!settled.current) return;
      const { result } = settled;
      if (!result?.ok) {
        setCatalogWarning('Etiket proje kataloğuna eklenemedi; görevde saklandı.');
      }
    }
    keywordDraftRef.current = null;
    onUpdate(task.id, { keyword: requested });
  };

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
  const assignmentScopeOnly = useMemo(() => {
    if (!project || canWriteProject(project)) return null;
    return new Set(assignmentScopeSicils.map(String));
  }, [assignmentScopeSicils, project]);

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
          <button className="icon-btn" onClick={dismiss} aria-label="Kapat"><Icons.Close size={15} /></button>
        </header>

        <div className="drawer-body col" style={{ gap: 14 }}>
          <label className="simple-field">
            <span>Görev</span>
            <input
              className="input"
              value={titleDraft}
              onChange={(event) => changeTitle(event.target.value)}
              onBlur={flushTitle}
              aria-invalid={!titleValid}
              placeholder="Yapılacak işi yazın"
            />
            {!titleValid && (
              <span className="drawer-title-warning">
                <Icons.Alert size={12} /> Görev başlığı boş bırakılamaz; başlık girilene kadar panel kapatılamaz.
              </span>
            )}
          </label>

          <label className="simple-field">
            <span>Kısa açıklama</span>
            <input
              className="input"
              value={local.keyword || ''}
              // Yazarken yalnızca yerel taslak güncellenir; katalog eşlemesi ve
              // kalıcılaştırma alan bırakıldığında yapılır, böylece her tuş
              // vuruşu proje kataloğuna yazma denemesine dönüşmez.
              onChange={(event) => {
                keywordDraftRef.current = event.target.value;
                setLocal((current) => ({ ...current, keyword: event.target.value }));
              }}
              onBlur={(event) => commitKeyword(event.target.value)}
              placeholder="Örn. Teklif, Onay, Teslim"
            />
            {catalogWarning && <small className="muted">{catalogWarning}</small>}
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
        </div>

        <div className="drawer-foot">
          {!isCreating && canDelete && <button
            className="btn"
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
