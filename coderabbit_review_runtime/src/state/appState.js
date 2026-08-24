import { normalizeTaskRecord } from '../data/normalizeTaskRecord.js';
import { TASK_STATUSES } from '../domain/constants/index.js';
import { compareWbsNodes, selectDefaultProjectWbs, selectWbsDescendantIds } from '../domain/selectors/index.js';
import {
  validateTaskWbsMove,
  validateWbsDeletion,
  validateWbsReparent,
  validateWbsStructure
} from '../domain/validation/index.js';
import { fmtISO, today } from '../scheduling/dates/index.js';
import { addWorkingDays, moveToWorkingDay, resolveProjectCalendar } from '../scheduling/calendars/index.js';
import {
  WORKSPACE_MODE_PORTFOLIO,
  WORKSPACE_MODE_PROJECT,
  normalizeWorkspaceSelection
} from './selectors/workspaceSelectors.js';

/**
 * Görev tanımlarken seçilebilen, GÖRÜNÜR olmayan projeler.
 *
 * Yöneticinin görev atama kapsamı, kendisine "corporateprojectaccess"
 * verilmemiş CN43N projelerini de seçilebilir kılar. Bu kayıtlar bilinçli
 * olarak `state.projects` dışında tutulur: çalışma alanı seçicisi, süzgeçler,
 * raporlar ve görev görünürlüğü DEĞİŞMEZ.
 */
export function selectAssignableProjects(state = {}) {
  const visible = new Set((state.projects || []).map((project) => String(project.id)));
  return (state.assignableProjects || []).filter((project) => project && !visible.has(String(project.id)));
}

/**
 * Görev normalleştirmesinin bağlamı.
 *
 * Seçilebilir projeler ve kök dağılım düğümleri bu bağlama EKLENİR — ama
 * yalnızca buraya. Aksi hâlde yönetici bu projelerden birine görev tanımladığında
 * proje adı çözülemez ve kök düğüm bilinmediği için `wbsId` boşaltılırdı.
 */
function taskContext(state) {
  const assignable = selectAssignableProjects(state);
  return {
    projects: [...(state.projects || []), ...assignable],
    people: state.people || [],
    wbs: [
      ...(state.wbs || []),
      ...assignable
        .filter((project) => project.rootWbsId)
        .map((project) => ({
          id: project.rootWbsId,
          projectId: project.id,
          parentId: null,
          code: project.code || '',
          name: project.name,
          sortOrder: 0
        }))
    ],
    calendars: state.calendars || []
  };
}

function workspaceState(state, selection) {
  const normalized = normalizeWorkspaceSelection(selection, state.projects || []);
  const selectedTask = (state.tasks || []).find((task) => task.id === state.selectedTaskId) || null;
  const selectedTaskId = normalized.workspaceMode === WORKSPACE_MODE_PROJECT
    && selectedTask
    && selectedTask.projectId !== normalized.selectedProjectId
    ? null
    : state.selectedTaskId;

  return { ...normalized, selectedTaskId };
}

function wbsMessage(code) {
  const messages = {
    WBS_PARENT_NOT_FOUND: 'Üst WBS düğümü bulunamadı.',
    WBS_NODE_NOT_FOUND: 'Taşınacak WBS düğümü bulunamadı.',
    WBS_NAME_REQUIRED: 'WBS adı boş bırakılamaz.',
    WBS_HAS_CHILDREN: 'Alt WBS düğümleri bulunan bir WBS silinemez.',
    WBS_HAS_TASKS: 'Doğrudan görev atanmış bir WBS silinemez.',
    WBS_ROOT_DELETE_FORBIDDEN: 'Proje kök WBS düğümü silinemez.',
    WBS_ROOT_REPARENT_FORBIDDEN: 'Proje kök WBS düğümü başka bir WBS altına taşınamaz.',
    WBS_REPARENT_TO_DESCENDANT: 'Bir WBS kendi alt düğümlerinden birinin altına taşınamaz.',
    WBS_SELF_PARENT: 'Bir WBS kendi üst düğümü olamaz.',
    CROSS_PROJECT_WBS_PARENT: 'WBS düğümleri farklı projeler arasında taşınamaz.',
    TASK_MOVE_SELECTION_EMPTY: 'Taşınacak en az bir görev seçilmelidir.',
    WBS_TARGET_NOT_FOUND: 'Hedef WBS düğümü bulunamadı.',
    TASK_NOT_FOUND: 'Taşınacak görevlerden biri bulunamadı.',
    CROSS_PROJECT_TASK_WBS_MOVE: 'Görevler yalnızca kendi projelerindeki WBS düğümlerine taşınabilir.'
  };
  return messages[code] || 'WBS işlemi doğrulama nedeniyle tamamlanamadı.';
}

function withWbsError(state, code, nodeId = null, details = {}) {
  return {
    ...state,
    wbsActionError: { code, nodeId, details, message: wbsMessage(code) }
  };
}

function nextChildDefinition(state, parent) {
  const siblings = (state.wbs || []).filter((node) => node.parentId === parent.id);
  const maxOrder = siblings.reduce((max, node) => Math.max(max, Number.isFinite(node.sortOrder) ? node.sortOrder : 0), 0);
  const maxSegment = siblings.reduce((max, node) => {
    const segment = Number.parseInt(String(node.code || '').split('.').at(-1), 10);
    return Number.isFinite(segment) ? Math.max(max, segment) : max;
  }, 0);
  const next = Math.max(maxOrder, maxSegment, siblings.length) + 1;
  return { code: `${parent.code}.${next}`, sortOrder: next };
}

function moveTasksToWbs(state, taskIds, targetWbsId) {
  const issues = validateTaskWbsMove(state.tasks, state.wbs, taskIds, targetWbsId);
  if (issues.length) {
    const first = issues[0];
    return withWbsError(state, first.code, first.nodeId, first.details);
  }

  const selectedIds = new Set(taskIds);
  return {
    ...state,
    tasks: state.tasks.map((task) => (selectedIds.has(task.id) ? { ...task, wbsId: targetWbsId } : task)),
    wbsActionError: null
  };
}

function rebaseWbsCode(code, oldPrefix, newPrefix) {
  const value = String(code || '');
  const previous = String(oldPrefix || '');
  if (!previous) return value;
  if (value === previous) return newPrefix;
  if (value.startsWith(`${previous}.`)) return `${newPrefix}${value.slice(previous.length)}`;
  return value;
}

/**
 * Kardeşleri verilen sıraya göre yeniden numaralandırır.
 *
 * Yalnızca `sortOrder` değeri gerçekten değişen düğümler yeni nesneye
 * dönüştürülür; değişmeyenler aynı referansta kalır. Kalıcılaştırma katmanı
 * değişiklik kümesini referans karşılaştırmasıyla ürettiği için bu, gereksiz
 * kayıt güncellemelerini (ve sürüm çakışması riskini) engeller.
 */
function withSiblingOrder(wbs, orderedIds) {
  const orderById = new Map(orderedIds.map((id, index) => [id, index + 1]));
  return wbs.map((node) => {
    const sortOrder = orderById.get(node.id);
    if (sortOrder == null || node.sortOrder === sortOrder) return node;
    return { ...node, sortOrder };
  });
}

/**
 * Sürükle-bırak taşıması: üst düğüm değişikliği ve kardeşler arası sıralama.
 *
 * Üst düğüm değişiyorsa mevcut `wbs/reparent` davranışı aynen uygulanır (kod
 * yeniden türetilir, alt ağaç kodları yeniden temellendirilir). Ardından düğüm
 * hedef sıraya yerleştirilir. Kodlar sıralamayla birlikte yeniden yazılmaz:
 * ağaç önce `sortOrder` ile sıralandığı için görüntü doğru kalır ve tek bir
 * sürükleme yüzlerce kaydı güncellemez.
 */
function moveWbsNode(state, nodeId, targetParentId, index) {
  const node = (state.wbs || []).find((item) => item.id === nodeId) || null;
  if (!node) return withWbsError(state, 'WBS_NODE_NOT_FOUND', nodeId);
  const target = (state.wbs || []).find((item) => item.id === targetParentId) || null;
  if (!target) return withWbsError(state, 'WBS_PARENT_NOT_FOUND', targetParentId);

  // Yalnızca BU geçişin ürettiği hata döndürülür. Ebeveyn değişmediğinde eski
  // bir `wbsActionError` hâlâ duruyorsa sıralama sessizce düşüyor, indirgeyici
  // aynı durumu döndürdüğü için kalıcılaştırma boş bir değişiklik kümesi
  // üretiyordu.
  const reparented = node.parentId === target.id
    ? { ...state, wbsActionError: null }
    : reparentWbs(state, nodeId, targetParentId);
  if (reparented.wbsActionError) return reparented;

  const siblings = (reparented.wbs || [])
    .filter((item) => item.parentId === target.id && item.id !== nodeId)
    .sort(compareWbsNodes)
    .map((item) => item.id);
  const position = Math.max(0, Math.min(Number.isFinite(index) ? index : siblings.length, siblings.length));
  siblings.splice(position, 0, nodeId);

  return { ...reparented, wbs: withSiblingOrder(reparented.wbs, siblings), wbsActionError: null };
}

function reparentWbs(state, nodeId, targetParentId) {
  const issues = validateWbsReparent(state.wbs, nodeId, targetParentId);
  if (issues.length) {
    const first = issues[0];
    return withWbsError(state, first.code, first.nodeId, first.details);
  }

  const node = state.wbs.find((item) => item.id === nodeId);
  const target = state.wbs.find((item) => item.id === targetParentId);
  if (node.parentId === target.id) return { ...state, wbsActionError: null };

  const stateWithoutSourceSibling = {
    ...state,
    wbs: state.wbs.filter((item) => item.id !== node.id)
  };
  const ordering = nextChildDefinition(stateWithoutSourceSibling, target);
  const descendants = new Set(selectWbsDescendantIds(state.wbs, node.id));
  const nextWbs = state.wbs.map((item) => {
    if (item.id === node.id) {
      return {
        ...item,
        parentId: target.id,
        code: ordering.code,
        sortOrder: ordering.sortOrder
      };
    }
    if (descendants.has(item.id)) {
      return { ...item, code: rebaseWbsCode(item.code, node.code, ordering.code) };
    }
    return item;
  });

  const structureIssues = validateWbsStructure(nextWbs);
  if (structureIssues.length) {
    const first = structureIssues[0];
    return withWbsError(state, first.code, first.nodeId, first.details);
  }

  return { ...state, wbs: nextWbs, wbsActionError: null };
}

function emptyApplicationData() {
  return {
    calendars: [],
    projects: [],
    people: [],
    wbs: [],
    tasks: [],
    baselines: [],
    taskBaselineSnapshots: [],
    // Görev atama kapsamındaki (görünür OLMAYAN) kurumsal projeler.
    assignableProjects: [],
    assignmentScopeSicils: [],
    session: null,
    currentUser: null,
    isSystemAdmin: false,
    isExecutive: false,
    canCreateProjects: false,
    projectAccess: []
  };
}

export function createLoadingState() {
  return {
    ...emptyApplicationData(),
    selectedTaskId: null,
    workspaceMode: WORKSPACE_MODE_PORTFOLIO,
    selectedProjectId: null,
    wbsActionError: null,
    dataStatus: 'loading',
    // İlk yükleme tamamlandıktan sonra yeniden yüklemeler uygulama kabuğunu
    // söktürmez; aksi hâlde her kayıttan sonra karşılama ekranı yeniden açılıyor
    // ve kullanıcı uygulamayı ilk kez açmış gibi baştan başlıyordu.
    hasLoadedOnce: false,
    loadError: null,
    pendingMutationCount: 0,
    saveError: null,
    lastSavedAt: null
  };
}

function createStateFromSnapshot(snapshot = {}, previous = createLoadingState()) {
  const hasSession = Object.prototype.hasOwnProperty.call(snapshot, 'session');
  const session = hasSession ? snapshot.session : previous.session;
  const sessionState = hasSession
    ? {
        session: session || null,
        currentUser: session?.currentUser || null,
        isSystemAdmin: Boolean(session?.isSystemAdmin),
        isExecutive: Boolean(session?.isExecutive),
        canCreateProjects: Boolean(session?.canCreateProjects),
        projectAccess: session?.projectAccess || []
      }
    : {
        session: previous.session || null,
        currentUser: previous.currentUser || null,
        isSystemAdmin: Boolean(previous.isSystemAdmin),
        isExecutive: Boolean(previous.isExecutive),
        canCreateProjects: Boolean(previous.canCreateProjects),
        projectAccess: previous.projectAccess || []
      };
  const base = {
    ...sessionState,
    calendars: snapshot.calendars || [],
    projects: snapshot.projects || [],
    assignableProjects: snapshot.assignableProjects || [],
    assignmentScopeSicils: snapshot.assignmentScopeSicils || [],
    people: snapshot.people || [],
    wbs: snapshot.wbs || [],
    baselines: snapshot.baselines || [],
    taskBaselineSnapshots: snapshot.taskBaselineSnapshots || []
  };
  // Bağlam görev BAŞINA değil, bir kez kurulur: birleştirilmiş `projects`,
  // `wbs` ve `people` dizileri her görev için yeniden ayrılınca maliyet
  // görev × (proje + wbs) kadar büyüyordu.
  const context = taskContext(base);
  const tasks = (snapshot.tasks || []).map((task) => normalizeTaskRecord(task, context));
  const nextBase = { ...previous, ...base, tasks };
  const selection = workspaceState(nextBase, previous);
  const selectedTaskId = tasks.some((task) => task.id === selection.selectedTaskId)
    ? selection.selectedTaskId
    : null;

  return {
    ...nextBase,
    ...selection,
    selectedTaskId,
    wbsActionError: null,
    dataStatus: 'ready',
    hasLoadedOnce: true,
    loadError: null,
    pendingMutationCount: previous.pendingMutationCount || 0,
    saveError: null,
    lastSavedAt: previous.lastSavedAt || null
  };
}

export function createInitialState(snapshot = {}) {
  return createStateFromSnapshot(snapshot, createLoadingState());
}

function isDoneStatus(value) {
  return String(value ?? '').trim().toLowerCase() === TASK_STATUSES.DONE;
}

/**
 * Görev "Tamamlandı"ya geçerken GERÇEKLEŞEN bitişi damgalar; geri açıldığında
 * damgayı temizler.
 *
 * Normal tamamlama yolları (görev panelindeki durum düğmesi, Kanban bırakması)
 * yalnızca `status: 'done'` yamalıyor, doğrulama da buna izin veriyordu. Sonuç,
 * gerçekleşen tarihi olmayan tamamlanmış görevlerdi: raporlar bu boşluğu
 * planlanan bitişle dolduruyor ve gelecek aya planlanmış ama bugün bitirilen
 * işi eğriye gelecek ay sokuyordu.
 *
 * Damga `done` DIŞINA çıkışta temizlenir. Aksi hâlde pazartesi tamamlanıp salı
 * yeniden açılan ve cuma tekrar bitirilen bir görev, eski damgası durduğu için
 * tamamlanma eğrisine hâlâ pazartesi yazılıyordu.
 *
 * `actualStart` de birlikte doldurulur: kalıcılaştırma sınırı gerçekleşen bitiş
 * için gerçekleşen başlangıç ister ve başlangıç bitişten sonraya düşemez.
 * Gerçek başlangıç bilinmiyorsa PLAN tarihi gerçekmiş gibi yazılmaz —
 * ocak ayına planlanıp bugün yapılan iş "ocakta başlamış" diye kaydedilirdi.
 *
 * @returns {object} damgalanmış yama (değişiklik gerekmiyorsa aynı nesne)
 */
export function withCompletionStamp(state, taskId, patch, referenceDate = today()) {
  if (!patch || !Object.prototype.hasOwnProperty.call(patch, 'status')) return patch;
  const task = (state?.tasks || []).find((item) => String(item.id) === String(taskId)) || null;
  if (!task) return patch;

  const wasDone = isDoneStatus(task.status);
  const becomesDone = isDoneStatus(patch.status);
  const declaresFinish = Object.prototype.hasOwnProperty.call(patch, 'actualFinish');

  if (!becomesDone) {
    // Yeniden açılan görevin tamamlanma damgası düşer; kullanıcı açıkça bir
    // tarih verdiyse ona dokunulmaz.
    if (!wasDone || declaresFinish || !task.actualFinish) return patch;
    return { ...patch, actualFinish: null };
  }

  if (declaresFinish && patch.actualFinish) return patch;
  // Zaten tamamlanmış bir görev yeniden `done` yamalanırsa damga korunur;
  // yalnızca GERÇEK bir geçiş yeni tarih yazar.
  if (wasDone && !declaresFinish && task.actualFinish) return patch;

  const actualFinish = fmtISO(referenceDate);
  const declaredStart = Object.prototype.hasOwnProperty.call(patch, 'actualStart')
    ? patch.actualStart
    : task.actualStart;
  const candidateStart = declaredStart || actualFinish;
  return {
    ...patch,
    actualStart: candidateStart > actualFinish ? actualFinish : candidateStart,
    actualFinish
  };
}

export function normalizeStateTask(task, state) {
  return normalizeTaskRecord(task, taskContext(state));
}

function deleteId(value) {
  return typeof value === 'string' ? value : value?.id;
}

function removePredecessorReferences(tasks, predecessorIds) {
  if (!predecessorIds.size) return tasks;
  return tasks.map((task) => {
    const dependencies = task.deps || [];
    const filtered = dependencies.filter((dependency) => !predecessorIds.has(dependency.predecessorId));
    return filtered.length === dependencies.length ? task : { ...task, deps: filtered };
  });
}

function invalidatedPredecessorIds(beforeTasks, upserts, deletes) {
  const invalidated = new Set((deletes || []).map(deleteId).filter(Boolean));
  const beforeById = new Map((beforeTasks || []).map((task) => [task.id, task]));
  for (const task of upserts || []) {
    const before = beforeById.get(task.id);
    if (before && before.projectId !== task.projectId) invalidated.add(task.id);
  }
  return invalidated;
}

function applyUpserts(items, upserts, deletes, normalize, { prependNew = false } = {}) {
  const deleted = new Set((deletes || []).map(deleteId).filter(Boolean));
  const currentIds = new Set(items.map((item) => item.id));
  const byId = new Map((upserts || []).map((item) => [item.id, item]));
  const updated = items
    .filter((item) => !deleted.has(item.id))
    .map((item) => (byId.has(item.id) ? normalize(byId.get(item.id)) : item));
  const additions = (upserts || [])
    .filter((item) => !currentIds.has(item.id) && !deleted.has(item.id))
    .map(normalize);
  return prependNew ? [...additions, ...updated] : [...updated, ...additions];
}

function applyCommittedChanges(state, changes = {}) {
  // Sunucunun yetkili yanıtı projelere de uygulanır. Aksi hâlde proje kayıtları
  // eski (veya eksik) sürüm anahtarıyla kalır ve bir sonraki güncelleme
  // "Kayıt kimliği zaten kullanılıyor" çakışmasıyla reddedilir.
  const projects = applyUpserts(
    state.projects,
    changes.projectUpserts || [],
    changes.projectDeletes || [],
    (project) => ({ ...project })
  );
  const wbs = applyUpserts(
    state.wbs,
    changes.wbsUpserts || [],
    changes.wbsDeletes || [],
    (node) => ({ ...node })
  );
  const taskState = { ...state, projects, wbs };
  const invalidated = invalidatedPredecessorIds(
    state.tasks,
    changes.taskUpserts || [],
    changes.taskDeletes || []
  );
  const appliedTasks = applyUpserts(
    state.tasks,
    changes.taskUpserts || [],
    changes.taskDeletes || [],
    (task) => normalizeStateTask(task, taskState),
    { prependNew: true }
  );
  const tasks = removePredecessorReferences(appliedTasks, invalidated);
  const next = { ...state, projects, wbs, tasks };
  return { ...next, ...workspaceState(next, next) };
}

export function appStateReducer(state, action) {
  switch (action.type) {
    case 'data/load-start':
      return { ...state, dataStatus: 'loading', loadError: null };
    case 'data/load-success':
      return createStateFromSnapshot(action.snapshot, state);
    case 'data/load-error':
      return { ...state, dataStatus: 'error', loadError: action.error };
    case 'persistence/start':
      return {
        ...state,
        pendingMutationCount: state.pendingMutationCount + 1
      };
    // Sayaçlara dokunmadan yetkili değişiklik kümesini duruma uygular.
    case 'data/apply-changes':
      return applyCommittedChanges(state, action.changes || {});
    case 'persistence/success': {
      const committed = applyCommittedChanges(state, action.changes);
      return {
        ...committed,
        pendingMutationCount: Math.max(0, state.pendingMutationCount - 1),
        saveError: state.saveError,
        lastSavedAt: action.savedAt || state.lastSavedAt,
        wbsActionError: action.clearWbsError ? null : committed.wbsActionError
      };
    }
    case 'persistence/failure':
      return {
        ...state,
        pendingMutationCount: Math.max(0, state.pendingMutationCount - 1),
        saveError: action.error
      };
    case 'persistence/clear-error':
      return { ...state, saveError: null };
    case 'task/add':
      return { ...state, tasks: [action.task, ...state.tasks], selectedTaskId: action.task.id };
    case 'task/add-many':
      // Seri yinelemeleri tek işlemde eklenir; seçili görev şablonda kalır.
      return { ...state, tasks: [...(action.tasks || []), ...state.tasks] };
    case 'task/update': {
      const previousTask = state.tasks.find((task) => task.id === action.id) || null;
      let updatedTask = null;
      let tasks = state.tasks.map((task) => {
        if (task.id !== action.id) return task;
        const next = { ...task, ...action.patch };
        const patchHasAssigneeIds = Object.prototype.hasOwnProperty.call(action.patch, 'assigneeIds');
        // Yalnızca ad listesi gönderildiğinde kimlikler adlardan yeniden türetilir.
        // Yama açıkça Sicil kimliklerini taşıyorsa bunlar kesin kaynaktır: binlerce
        // çalışan arasında aynı ada sahip kişiler ad eşlemesinde eleniyor ve görev
        // ataması sessizce kayboluyordu.
        if (Object.prototype.hasOwnProperty.call(action.patch, 'sorumlu') && !patchHasAssigneeIds) {
          delete next.assigneeIds;
        } else if (patchHasAssigneeIds) {
          next.assigneeIdsCanonical = true;
        }
        if (Object.prototype.hasOwnProperty.call(action.patch, 'proje')) {
          delete next.projectId;
          delete next.wbsId;
        }
        updatedTask = normalizeStateTask(next, state);
        return updatedTask;
      });
      const projectChanged = Boolean(updatedTask && previousTask && updatedTask.projectId !== previousTask.projectId);
      if (projectChanged) {
        tasks = tasks.map((task) => (task.id === action.id ? { ...task, deps: [] } : task));
        tasks = removePredecessorReferences(tasks, new Set([action.id]));
        updatedTask = tasks.find((task) => task.id === action.id) || updatedTask;
      }
      const selectedTaskId = state.workspaceMode === WORKSPACE_MODE_PROJECT
        && state.selectedTaskId === action.id
        && updatedTask
        && updatedTask.projectId !== state.selectedProjectId
        ? null
        : state.selectedTaskId;
      return { ...state, tasks, selectedTaskId };
    }
    case 'task/move-wbs':
      return moveTasksToWbs(state, [action.id], action.wbsId);
    case 'task/bulk-move-wbs':
      return moveTasksToWbs(state, action.ids || [], action.wbsId);
    case 'task/delete': {
      const tasks = removePredecessorReferences(
        state.tasks.filter((task) => task.id !== action.id),
        new Set([action.id])
      );
      return {
        ...state,
        tasks,
        selectedTaskId: state.selectedTaskId === action.id ? null : state.selectedTaskId
      };
    }
    case 'task/select':
      return { ...state, selectedTaskId: action.id || null };
    case 'workspace/select':
    case 'workspace/restore':
      return { ...state, ...workspaceState(state, action) };
    case 'wbs/add-child': {
      const parent = state.wbs.find((node) => node.id === action.parentId) || null;
      if (!parent) return withWbsError(state, 'WBS_PARENT_NOT_FOUND', action.parentId);
      const name = String(action.name || '').trim();
      if (!name) return withWbsError(state, 'WBS_NAME_REQUIRED', parent.id);
      const ordering = nextChildDefinition(state, parent);
      const node = {
        id: action.id,
        projectId: parent.projectId,
        parentId: parent.id,
        code: action.code || ordering.code,
        name,
        sortOrder: Number.isFinite(action.sortOrder) ? action.sortOrder : ordering.sortOrder
      };
      const nextWbs = [...state.wbs, node];
      const issues = validateWbsStructure(nextWbs);
      if (issues.length) {
        const first = issues[0];
        return withWbsError(state, first.code, first.nodeId, first.details);
      }
      return { ...state, wbs: nextWbs, wbsActionError: null };
    }
    case 'wbs/rename': {
      const name = String(action.name || '').trim();
      if (!name) return withWbsError(state, 'WBS_NAME_REQUIRED', action.id);
      return {
        ...state,
        wbs: state.wbs.map((node) => (node.id === action.id ? { ...node, name } : node)),
        wbsActionError: null
      };
    }
    case 'wbs/reparent':
      return reparentWbs(state, action.id, action.parentId);
    case 'wbs/move':
      return moveWbsNode(state, action.id, action.parentId, action.index);
    case 'wbs/delete': {
      const issues = validateWbsDeletion(state.wbs, state.tasks, action.id);
      if (issues.length) {
        const first = issues[0];
        return withWbsError(state, first.code, first.nodeId, first.details);
      }
      return {
        ...state,
        wbs: state.wbs.filter((node) => node.id !== action.id),
        wbsActionError: null
      };
    }
    case 'wbs/clear-error':
      return { ...state, wbsActionError: null };
    default:
      return state;
  }
}

/**
 * Yeni görevin VARSAYILAN sorumlusu.
 *
 * Görev ATAMA kapsamıyla açılan bir projede sunucu, görevin bütün
 * sorumlularının yöneticinin `MR_V_ExecutiveScope` kapsamında olmasını şart
 * koşar. Varsayılan olarak oturum sahibini yazmak bu projelerde oluşturma
 * isteğini panel açılmadan reddettiriyor ve yönetici astını seçemiyordu; bu
 * yüzden kapsam dışı kalan varsayılan, kapsamdaki ilk çalışanla değiştirilir.
 * Kullanıcı paneli açar açmaz sorumluyu değiştirebilir.
 */
export function defaultTaskAssignee(state, project = null) {
  const fallback = state.session?.dataMode === 'actual'
    ? (() => {
      const currentUserId = state.currentUser?.id == null ? null : String(state.currentUser.id);
      if (!currentUserId) return null;
      return (state.people || []).find((person) => String(person.id) === currentUserId) || state.currentUser;
    })()
    : (state.people?.[0] || null);

  const assignOnly = Boolean(project?.accessLevel) && project.accessLevel !== 'FULL';
  const scope = state.assignmentScopeSicils || [];
  if (!assignOnly || !scope.length) return fallback;

  const scoped = new Set(scope.map(String));
  if (fallback && scoped.has(String(fallback.id))) return fallback;
  return (state.people || []).find((person) => scoped.has(String(person.id))) || null;
}

/** Bu projede oluşturma isteği KABUL EDİLEBİLİR bir sorumluyla gidebilir mi? */
export function canResolveTaskAssignee(state = {}, project = null) {
  return Boolean(defaultTaskAssignee(state, project));
}

/**
 * @param {object} state uygulama durumu
 * @param {Date} [referenceDate]
 * @param {string} [id]
 * @param {object|null} [explicitProject] görev atama kapsamındaki bir proje
 *   görünür proje listesinde BULUNMAZ; çağıran çözdüğü projeyi burada verir,
 *   aksi hâlde yeni görev sessizce başka bir projeye düşerdi.
 */
export function createNewTask(state, referenceDate = today(), id = `n-${Date.now()}`, explicitProject = null) {
  const candidates = [...(state.projects || []), ...selectAssignableProjects(state)];
  const selectedProject = state.workspaceMode === WORKSPACE_MODE_PROJECT
    ? candidates.find((project) => project.id === state.selectedProjectId) || null
    : null;
  const project = explicitProject || selectedProject || (state.projects || [])[0] || null;
  const person = defaultTaskAssignee(state, project);
  const calendar = resolveProjectCalendar(project, state.calendars);
  const start = moveToWorkingDay(referenceDate, calendar, 1);
  // Görünür ağaç yoksa projenin kök düğümü atama kapsamı kaydından okunur.
  const defaultWbs = project
    ? (selectDefaultProjectWbs(state.wbs, project.id) || (project.rootWbsId ? { id: project.rootWbsId } : null))
    : null;

  const task = normalizeStateTask({
    id,
    projectId: project?.id || null,
    wbsId: defaultWbs?.id || null,
    proje: project?.name || '',
    task: 'Yeni görev',
    keyword: 'Yeni',
    assigneeIds: person ? [person.id] : [],
    sorumlu: person ? [person.name] : [],
    status: 'todo',
    plannedStart: fmtISO(start),
    plannedFinish: fmtISO(addWorkingDays(start, 5, calendar)),
    targetFinish: fmtISO(addWorkingDays(start, 7, calendar)),
    actualStart: null,
    actualFinish: null,
    remainingDurationDays: null,
    color: project?.color || 'blue',
    deps: []
  }, state);

  return {
    ...task,
    remainingDurationDays: task.plannedDurationDays
  };
}
