'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icons } from '../../components/icons';
import { SearchableSelect } from '../../components/SearchableSelect';
import {
  buildWbsTree,
  emptyWbsRollup,
  flattenWbsTree,
  formatWbsPath,
  selectWbsDescendantIds,
  selectWbsRollupIndex
} from '../../domain/selectors/index.js';
import { isCorporateProject } from '../../domain/projectTypes';
import { validateWbsStructure } from '../../domain/validation/index.js';
import { fmtDisplayDate } from '../../scheduling/dates';
import {
  useProjectSchedule,
  useTaskActions,
  useWbsActions,
  useWorkspace,
  useWorkspaceTasks,
  useWorkspaceWbs
} from '../../state/hooks';
import { useAppState } from '../../state/AppStateProvider';
import { canWriteProject } from '../../state/projectWritePolicy.js';
import { DEFAULT_WBS_DEPTH, WBS_DEPTH_OPTIONS, expandedIdsForDepth } from './wbsTreeViewPolicy.js';
import { createWbsDropIndex, resolveWbsDrop, wbsSiblings } from './wbsDragPolicy.js';

// Satır içinde imlecin dikey konumu bırakma niyetini belirler: üst/alt şeritler
// kardeş sırası, orta bölge ise alt düğüm yapar.
const DROP_EDGE_RATIO = 0.28;
// Kapalı bir düğümün üzerinde beklerken alt ağacın kendiliğinden açılma süresi.
const HOVER_EXPAND_MS = 650;

function dropPositionFromPointer(event, element) {
  const rect = element.getBoundingClientRect();
  if (!rect.height) return 'inside';
  const ratio = (event.clientY - rect.top) / rect.height;
  if (ratio <= DROP_EDGE_RATIO) return 'before';
  if (ratio >= 1 - DROP_EDGE_RATIO) return 'after';
  return 'inside';
}

function visibleRows(tree, expanded) {
  const rows = [];
  const visited = new Set();
  function visit(node, depth) {
    if (!node || visited.has(node.id)) return;
    visited.add(node.id);
    rows.push({ node, depth });
    if (!expanded.has(node.id)) return;
    for (const child of node.children || []) visit(child, depth + 1);
  }
  for (const root of tree) visit(root, 0);
  return rows;
}

function projectLabel(project) {
  if (!project) return '';
  return project.code ? `${project.code} · ${project.name}` : project.name;
}

/**
 * Satır içi ad girişi.
 *
 * Enter kaydeder, Esc vazgeçer. Alan açıldığı anda odaklanır: kullanıcı
 * `prompt()` penceresinde olduğu gibi doğrudan yazmaya başlayabilir, ancak
 * sayfa bağlamını kaybetmez.
 */
function WbsNameInput({ value, onChange, onSubmit, onCancel, placeholder, ariaLabel }) {
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
  return (
    <input
      ref={inputRef}
      className="input wbs-inline-input"
      value={value}
      aria-label={ariaLabel}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); onSubmit(); }
        if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
      }}
      // Odak kaybında boş ad kaydedilmez; düzenleme sessizce kapanır.
      onBlur={() => (value.trim() ? onSubmit() : onCancel())}
    />
  );
}

/** Üstteki ölçüm rozetleri; dikey alanı tüketmeden bağlamı korur. */
function TreeMetric({ icon, value, label }) {
  return (
    <span className="wbs-metric">
      {icon}
      <strong className="tabular">{value}</strong>
      <span>{label}</span>
    </span>
  );
}

/**
 * Hiyerarşi seviyesi seçici.
 *
 * "Tümünü aç" ile "Tümünü kapat" arasındaki ara basamakları verir: büyük
 * kurumsal ağaçlarda kullanıcı çoğu zaman tüm ağacı değil, belirli bir
 * seviyeye kadarını görmek ister.
 */
function HierarchyMenu({ depth, onChoose }) {
  const [open, setOpen] = useState(false);
  const hostRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!hostRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const active = WBS_DEPTH_OPTIONS.find((option) => option.value === depth) || null;

  return (
    <div className="wbs-hierarchy-menu" ref={hostRef}>
      <button
        type="button"
        className={`wbs-tree-btn${open ? ' active' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icons.Layers size={13} />
        <span>Hiyerarşi</span>
        <em>{active ? active.label.replace('Seviye ', 'S') : 'Özel'}</em>
        <Icons.ChevronDown size={12} />
      </button>
      {open && (
        <div className="wbs-hierarchy-pop" role="listbox" aria-label="Görünecek hiyerarşi seviyesi">
          {WBS_DEPTH_OPTIONS.map((option) => (
            <button
              type="button"
              key={String(option.value)}
              role="option"
              aria-selected={option.value === depth}
              className={option.value === depth ? 'active' : ''}
              onClick={() => { onChoose(option.value); setOpen(false); }}
            >
              <span>{option.label}</span>
              {option.value === depth && <Icons.Check size={12} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function WbsView() {
  const workspace = useWorkspace();
  const { session } = useAppState();
  const isActualDataMode = String(session?.dataMode || '').toLowerCase() === 'actual';
  const tasks = useWorkspaceTasks();
  const wbs = useWorkspaceWbs();
  const projectSchedule = useProjectSchedule(workspace.selectedProjectId);
  const { moveTasksToWbs } = useTaskActions();
  const { addWbsChild, renameWbs, reparentWbs, moveWbsNode, deleteWbs, clearWbsError, error } = useWbsActions();
  const tree = useMemo(() => buildWbsTree(wbs), [wbs]);
  const orderedRows = useMemo(() => flattenWbsTree(tree), [tree]);
  // Dağılım ağacı büyüdüğünde açılır listeler canlı arama ile kullanılabilir kalır.
  const wbsOptions = useMemo(() => orderedRows.map(({ node, depth }) => ({
    value: node.id,
    label: `${'— '.repeat(depth)}${node.code} · ${node.name}`,
    description: formatWbsPath(wbs, node.id),
    keywords: [node.code, node.name]
  })), [orderedRows, wbs]);
  const [expanded, setExpanded] = useState(() => new Set());
  const [depth, setDepth] = useState(DEFAULT_WBS_DEPTH);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveSourceWbsId, setMoveSourceWbsId] = useState('');
  const [moveTargetWbsId, setMoveTargetWbsId] = useState('');
  const [selectedTaskIds, setSelectedTaskIds] = useState(() => new Set());
  const [reparenting, setReparenting] = useState(null);
  // Satır içi düzenleme: `prompt()`/`confirm()` yerine sayfanın içinde kalan,
  // iptal edilebilir ve sınanabilir bir akış.
  const [editing, setEditing] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [drag, setDrag] = useState(null);
  const [dropHint, setDropHint] = useState(null);
  // Taşıma kötümser olarak kalıcılaştırılır: yanıt gelene kadar görünen ağaç
  // eskidir. Bu aralıkta yeni bir sürüklemeye izin verilirse, mutlak kardeş
  // sırası eski ağaçtan hesaplanıp güncel ağaca uygulanır ve sonuç kullanıcının
  // gördüğünden başka olur.
  const [movePending, setMovePending] = useState(false);
  // Satırın tamamı `draggable` olsaydı ad alanında metin seçmek ya da eylem
  // düğmelerinde işaretçiyi kaydırmak sürüklemeyi başlatabilir ve istenmeyen bir
  // hiyerarşi değişikliği kalıcılaşabilirdi; sürükleme yalnızca tutamaktan başlar.
  const [dragHandleNodeId, setDragHandleNodeId] = useState(null);
  const hoverExpandRef = useRef({ nodeId: null, timer: null });
  // Sürükleme oturumu boyunca paylaşılan arama dizini: `dragover` her işaretçi
  // hareketinde tetiklenir, ağaç indeksinin her olayda yeniden kurulması
  // kurumsal ölçekte sürüklemeyi kilitler.
  const dropIndexRef = useRef(null);
  const validationIssues = useMemo(() => validateWbsStructure(wbs), [wbs]);
  // Toplulaştırmalar satır başına değil, ağacın tamamı için tek geçişte
  // hesaplanır; 38 bin düğümlü kurumsal ağaçta satır çizimi böylece ucuz kalır.
  const rollups = useMemo(
    () => selectWbsRollupIndex(wbs, tasks, projectSchedule?.tasks || {}),
    [wbs, tasks, projectSchedule]
  );

  // Görünüm durumu YALNIZCA proje değiştiğinde sıfırlanır. Daha önce etki
  // `orderedRows` bağımlılığıyla çalışıyordu; ağaca düğüm eklemek/taşımak yeni
  // bir satır dizisi ürettiği için her düzenlemeden sonra ağaç varsayılan
  // derinliğe kapanıyor, açık paneller ve seçimler kayboluyordu.
  const initialisedRef = useRef({ projectId: undefined, rows: 0 });
  useEffect(() => {
    const projectId = workspace.selectedProjectId || null;
    const initialised = initialisedRef.current;
    // Aynı projede kalıyorsak ve ağaç zaten bir kez kurulduysa dokunulmaz.
    if (initialised.projectId === projectId && (initialised.rows > 0 || !orderedRows.length)) return;
    initialisedRef.current = { projectId, rows: orderedRows.length };
    setExpanded(expandedIdsForDepth(orderedRows, DEFAULT_WBS_DEPTH));
    setDepth(DEFAULT_WBS_DEPTH);
    setMoveOpen(false);
    setMoveSourceWbsId('');
    setMoveTargetWbsId('');
    setSelectedTaskIds(new Set());
    setReparenting(null);
    setEditing(null);
    setPendingDelete(null);
  }, [workspace.selectedProjectId, orderedRows]);

  // Sürükleme sırasında açılan zamanlayıcı bileşen sökülürse boşta kalmasın.
  useEffect(() => () => clearTimeout(hoverExpandRef.current.timer), []);

  // Tutamağa basıp sürüklemeden BAŞKA bir yerde bırakmak `dragHandleNodeId`
  // değerini asılı bırakıyordu: satır sürükleme başlatmadan `draggable` kalıyor
  // ve içindeki metin seçilemiyordu. Bırakma her yerde dinlenir.
  useEffect(() => {
    const releaseHandle = () => setDragHandleNodeId(null);
    window.addEventListener('pointerup', releaseHandle);
    window.addEventListener('pointercancel', releaseHandle);
    return () => {
      window.removeEventListener('pointerup', releaseHandle);
      window.removeEventListener('pointercancel', releaseHandle);
    };
  }, []);

  if (workspace.mode === 'portfolio') {
    return (
      <div className="col" style={{ gap: 16 }}>
        <div className="card">
          <div className="col" style={{ gap: 10 }}>
            <div style={{ fontSize: 17, fontWeight: 700 }}>İş Dağılım Ağacı</div>
            <div className="muted" style={{ maxWidth: 760, lineHeight: 1.6 }}>
              İş dağılım ağacı bir proje yapısıdır. Hiyerarşiyi ve proje aktivitelerini görmek ya da düzenlemek için bir proje çalışma alanına geçin.
            </div>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {workspace.projects.map((project) => (
                <button key={project.id} className="btn" onClick={() => workspace.selectWorkspace(project.id)}>
                  {projectLabel(project)}
                </button>
              ))}
              {!workspace.projects.length && <span className="muted">Henüz proje yok.</span>}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Kurumsal kaynak (CN43N) yalnızca Gerçek Sistem modunda vardır.
  const isCorporate = isActualDataMode && isCorporateProject(workspace.selectedProject);
  // Kurumsal projelerde yapı CN43N kaynağından gelir; düzenleme eylemleri kapatılır.
  const canEdit = canWriteProject(workspace.selectedProject) && !isCorporate;
  const rows = visibleRows(tree, expanded);
  const canMoveTasks = canWriteProject(workspace.selectedProject);
  const sourceTasks = moveSourceWbsId ? tasks.filter((task) => task.wbsId === moveSourceWbsId) : [];
  const selectedCount = selectedTaskIds.size;

  const toggle = (id) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const expandAll = () => {
    setExpanded(new Set(wbs.map((node) => node.id)));
    setDepth(Number.POSITIVE_INFINITY);
  };

  const collapseAll = () => {
    setExpanded(new Set());
    setDepth(1);
  };

  const applyDepth = (value) => {
    setDepth(value);
    setExpanded(value === Number.POSITIVE_INFINITY
      ? new Set(wbs.map((node) => node.id))
      : expandedIdsForDepth(orderedRows, value));
  };

  const startAddChild = (node) => {
    setPendingDelete(null);
    setReparenting(null);
    setExpanded((current) => new Set(current).add(node.id));
    setEditing({ mode: 'add', nodeId: node.id, value: '' });
  };

  const startRename = (node) => {
    setPendingDelete(null);
    setReparenting(null);
    setEditing({ mode: 'rename', nodeId: node.id, value: node.name });
  };

  // Satır içi taslak yalnızca kayıt BAŞARILI olduğunda kapanır: sürüm çakışması
  // ya da geçici bir depo hatasında alan kapatılsaydı kullanıcının yazdığı ad
  // kaybolur ve yeniden yazmaktan başka yolu kalmazdı.
  const submitEditing = async () => {
    if (!editing || editing.busy) return;
    const name = editing.value.trim();
    if (!name) return;
    const current = editing;
    setEditing({ ...current, busy: true });
    const result = current.mode === 'add'
      ? await addWbsChild(current.nodeId, name)
      : await renameWbs(current.nodeId, name);
    if (result && result.ok === false) {
      setEditing({ ...current, busy: false });
      return;
    }
    setEditing(null);
  };

  const confirmDelete = (node) => {
    deleteWbs(node.id);
    setPendingDelete(null);
  };

  // ── Sürükle-bırak ───────────────────────────────────────────────
  const cancelHoverExpand = () => {
    clearTimeout(hoverExpandRef.current.timer);
    hoverExpandRef.current = { nodeId: null, timer: null };
  };

  const scheduleHoverExpand = (node) => {
    if (hoverExpandRef.current.nodeId === node.id) return;
    cancelHoverExpand();
    if (!(node.children || []).length || expanded.has(node.id)) return;
    hoverExpandRef.current = {
      nodeId: node.id,
      timer: setTimeout(() => setExpanded((current) => new Set(current).add(node.id)), HOVER_EXPAND_MS)
    };
  };

  const endDrag = () => {
    cancelHoverExpand();
    setDrag(null);
    setDropHint(null);
    setDragHandleNodeId(null);
    dropIndexRef.current = null;
  };

  const onRowDragStart = (node) => (event) => {
    if (!canEdit || node.parentId == null || movePending || dragHandleNodeId !== node.id) {
      event.preventDefault();
      return;
    }
    setDrag({ id: node.id });
    setPendingDelete(null);
    setEditing(null);
    dropIndexRef.current = createWbsDropIndex(wbs);
    event.dataTransfer.effectAllowed = 'move';
    // Bazı tarayıcılar veri taşımayan sürüklemeyi başlatmaz.
    try { event.dataTransfer.setData('text/plain', node.id); } catch {}
  };

  const resolveDrop = (dragId, targetId, position) => resolveWbsDrop(
    wbs,
    { dragId, targetId, position },
    { index: dropIndexRef.current || (dropIndexRef.current = createWbsDropIndex(wbs)) }
  );

  const onRowDragOver = (node) => (event) => {
    if (!drag || !canEdit) return;
    const position = dropPositionFromPointer(event, event.currentTarget);
    const resolution = resolveDrop(drag.id, node.id, position);
    event.preventDefault();
    event.dataTransfer.dropEffect = resolution.ok ? 'move' : 'none';
    if (position === 'inside' && resolution.ok) scheduleHoverExpand(node);
    else cancelHoverExpand();
    // İpucu yalnızca gerçekten değiştiğinde yazılır; aksi hâlde her işaretçi
    // hareketi bütün ağacı yeniden çizerdi.
    setDropHint((current) => (current
      && current.nodeId === node.id
      && current.position === position
      && current.ok === resolution.ok
      ? current
      : { nodeId: node.id, position, ok: resolution.ok, message: resolution.ok ? null : resolution.message }));
  };

  const onRowDragLeave = (node) => (event) => {
    // Satır içindeki bir alt öğeye geçiş "ayrılma" değildir; yalnızca gerçekten
    // satırdan çıkıldığında bekleyen açma zamanlayıcısı da iptal edilir, aksi
    // hâlde artık hedef olmayan satır sürükleme sürerken kendiliğinden açılır.
    if (event.currentTarget.contains(event.relatedTarget)) return;
    if (hoverExpandRef.current.nodeId === node.id) cancelHoverExpand();
    setDropHint((current) => (current?.nodeId === node.id ? null : current));
  };

  const onRowDrop = (node) => (event) => {
    event.preventDefault();
    if (!drag || !canEdit) return endDrag();
    const position = dropPositionFromPointer(event, event.currentTarget);
    const resolution = resolveDrop(drag.id, node.id, position);
    endDrag();
    if (!resolution.ok) return;
    // Hedefin altına alınan düğüm görünür kalmalıdır: hedef kapalıysa (ya da
    // taşımadan önce yaprak olduğu için hiç açılamıyorsa) düğüm bırakıldığı anda
    // ağaçtan kayboluyor, taşıma başarısız olmuş gibi görünüyordu.
    if (position === 'inside') setExpanded((current) => new Set(current).add(node.id));
    setMovePending(true);
    Promise.resolve(moveWbsNode(resolution.move.id, resolution.move.parentId, resolution.move.index))
      .finally(() => setMovePending(false));
  };

  /** Klavye/işaretçi ayrımı olmadan kardeş sırası: sürükleme tek yol değildir. */
  const moveSibling = (node, offset) => {
    if (!canEdit || movePending || node.parentId == null) return;
    const siblings = wbsSiblings(wbs, node.parentId);
    const currentIndex = siblings.findIndex((sibling) => sibling.id === node.id);
    const nextIndex = currentIndex + offset;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= siblings.length) return;
    setMovePending(true);
    Promise.resolve(moveWbsNode(node.id, node.parentId, nextIndex))
      .finally(() => setMovePending(false));
  };

  const onSourceChange = (wbsId) => {
    setMoveSourceWbsId(wbsId);
    setMoveTargetWbsId('');
    setSelectedTaskIds(new Set());
  };

  const toggleTaskSelection = (taskId) => {
    setSelectedTaskIds((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const moveSelectedTasks = () => {
    if (!selectedCount || !moveTargetWbsId) return;
    moveTasksToWbs([...selectedTaskIds], moveTargetWbsId);
    setSelectedTaskIds(new Set());
  };

  const startReparent = (node) => {
    const blocked = new Set([node.id, ...selectWbsDescendantIds(wbs, node.id)]);
    const candidates = orderedRows.map((row) => row.node).filter((candidate) => !blocked.has(candidate.id));
    const preferred = candidates.find((candidate) => candidate.id !== node.parentId) || candidates[0] || null;
    setReparenting({ nodeId: node.id, parentId: preferred?.id || '' });
  };

  const applyReparent = () => {
    if (!reparenting?.nodeId || !reparenting?.parentId) return;
    reparentWbs(reparenting.nodeId, reparenting.parentId);
    setReparenting(null);
  };

  return (
    /* Dikey alan bu sayfada en değerli kaynaktır: üst bilgi tek satırlık ince
       bir başlık çubuğuna indirgenir, dağılım ağacı tablosu kalan yüksekliğin
       tamamını alır ve yalnızca satırlar kayar. */
    <div className="wbs-page col">
      <div className="wbs-toolbar">
        <div className="wbs-toolbar-identity">
          <span className="wbs-toolbar-title" title={projectLabel(workspace.selectedProject)}>
            {projectLabel(workspace.selectedProject)}
          </span>
          <span className={`wbs-source-chip${isCorporate ? ' corporate' : ''}`}>
            {isCorporate ? <Icons.Database size={11} /> : <Icons.Layers size={11} />}
            {isCorporate ? 'CN43N kaynaklı' : 'Proje düzeyinde yönetilir'}
          </span>
        </div>

        <div className="wbs-toolbar-metrics">
          <TreeMetric icon={<Icons.Layers size={12} />} value={wbs.length} label="düğüm" />
          <TreeMetric icon={<Icons.Table size={12} />} value={tasks.length} label="aktivite" />
          <TreeMetric icon={<Icons.ChevronDown size={12} />} value={rows.length} label="görünen satır" />
        </div>

        <div className="wbs-tree-controls" role="group" aria-label="Dağılım ağacı görünüm denetimleri">
          <button type="button" className="wbs-tree-btn" onClick={expandAll}>
            <Icons.Plus size={13} /> <span>Tümünü aç</span>
          </button>
          <button type="button" className="wbs-tree-btn" onClick={collapseAll}>
            <Icons.Close size={13} /> <span>Tümünü kapat</span>
          </button>
          <HierarchyMenu depth={depth} onChoose={applyDepth} />
          {canMoveTasks && wbs.length > 0 && (
            <button
              type="button"
              className={`wbs-tree-btn${moveOpen ? ' active' : ''}`}
              aria-expanded={moveOpen}
              onClick={() => setMoveOpen((value) => !value)}
            >
              <Icons.ArrowLeft size={13} /> <span>Görev taşı</span>
            </button>
          )}
        </div>
      </div>

      {(canEdit || isCorporate || (!canEdit && !isCorporate) || validationIssues.length > 0 || error) && (
        <div className="wbs-notices">
          {canEdit && wbs.length > 1 && (
            <div className="wbs-note">
              <Icons.Grip size={13} />
              <span>
                Satırları <strong>sürükleyip bırakarak</strong> hiyerarşiyi düzenleyin: bir satırın
                <strong> ortasına</strong> bırakmak onu alt düğüm yapar, <strong>üst/alt kenarına</strong> bırakmak
                kardeş sırasına yerleştirir. Fare kullanmadan taşımak için satırdaki <strong>Taşı</strong> düğmesini kullanın.
              </span>
            </div>
          )}
          {isCorporate && (
            <div className="wbs-note">
              <Icons.Database size={13} />
              <span>
                Kurumsal iş dağılım ağacı <strong>CN43N</strong> kaynağından eşitlenir ve MERGEN Rota üzerinden değiştirilemez.
                Görevleri bu düğümlere atamak ve düğümler arasında taşımak yine mümkündür.
              </span>
            </div>
          )}
          {!canEdit && !isCorporate && (
            <div className="wbs-note">
              <Icons.Info size={13} />
              <span>Bu proje salt okunur görünürlükle açıldı; düzenleme için tam proje yazma yetkisi gerekir.</span>
            </div>
          )}
          {error && (
            <div className="wbs-note danger">
              <Icons.Alert size={13} />
              <span>{error.message}</span>
              <button type="button" className="btn ghost sm" onClick={clearWbsError}>Kapat</button>
            </div>
          )}
          {validationIssues.map((item, index) => (
            <div key={`${item.code}-${item.nodeId}-${index}`} className="wbs-note danger">
              <Icons.Alert size={13} />
              <span>{item.code} · {item.nodeId || 'Dağılım ağacı'}</span>
            </div>
          ))}
        </div>
      )}

      {canMoveTasks && wbs.length > 0 && moveOpen && (
        <div className="card wbs-move-panel">
          <div className="col" style={{ gap: 12 }}>
            <div className="row" style={{ justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
              <div className="col" style={{ gap: 3 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>Görevleri dağılım düğümleri arasında taşı</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  Kaynak düğüme doğrudan atanmış görevleri seçin; taşıma yalnızca bu proje içindeki geçerli bir hedefe uygulanır.
                </div>
              </div>
              <button type="button" className="icon-btn" onClick={() => setMoveOpen(false)} title="Paneli kapat">
                <Icons.Close size={13} />
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) minmax(220px, 1fr)', gap: 12 }}>
              <label className="col" style={{ gap: 6 }}>
                <span className="label">Kaynak düğüm</span>
                <SearchableSelect
                  value={moveSourceWbsId}
                  options={wbsOptions}
                  onChange={onSourceChange}
                  placeholder="Kaynak seçin..."
                  searchPlaceholder="WBS kodu veya adıyla ara"
                  emptyText="Eşleşen dağılım düğümü bulunamadı."
                  allowClear
                  clearLabel="Kaynak seçimini temizle"
                />
              </label>
              <label className="col" style={{ gap: 6 }}>
                <span className="label">Hedef düğüm</span>
                <SearchableSelect
                  value={moveTargetWbsId}
                  options={wbsOptions.filter((option) => option.value !== moveSourceWbsId)}
                  onChange={setMoveTargetWbsId}
                  placeholder="Hedef seçin..."
                  searchPlaceholder="WBS kodu veya adıyla ara"
                  emptyText="Eşleşen dağılım düğümü bulunamadı."
                  disabled={!moveSourceWbsId}
                  allowClear
                  clearLabel="Hedef seçimini temizle"
                />
              </label>
            </div>

            {moveSourceWbsId && (
              <div className="col" style={{ gap: 8 }}>
                <div className="row" style={{ justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <span className="muted" style={{ fontSize: 12.5 }}>{sourceTasks.length} doğrudan görev · {selectedCount} seçili</span>
                  <div className="row" style={{ gap: 6 }}>
                    <button className="btn" disabled={!sourceTasks.length} onClick={() => setSelectedTaskIds(new Set(sourceTasks.map((task) => task.id)))}>Tümünü seç</button>
                    <button className="btn" disabled={!selectedCount} onClick={() => setSelectedTaskIds(new Set())}>Temizle</button>
                    <button className="btn primary" disabled={!selectedCount || !moveTargetWbsId} onClick={moveSelectedTasks}>Seçilenleri taşı</button>
                  </div>
                </div>
                <div className="col" style={{ gap: 4, maxHeight: 190, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: 8 }}>
                  {!sourceTasks.length && <div className="muted" style={{ padding: 8, fontSize: 12 }}>Bu düğüme doğrudan atanmış görev yok.</div>}
                  {sourceTasks.map((task) => (
                    <label key={task.id} className="row" style={{ gap: 8, padding: '7px 8px', borderRadius: 'var(--r-sm)', cursor: 'pointer' }}>
                      <input type="checkbox" checked={selectedTaskIds.has(task.id)} onChange={() => toggleTaskSelection(task.id)} />
                      {task.milestone && <Icons.Diamond size={10} />}
                      <span style={{ fontSize: 12.5 }}>{task.task}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {!wbs.length ? (
        <div className="card muted">Bu proje için iş dağılım ağacı tanımlı değil.</div>
      ) : (
        <div className="card wbs-tree-table">
          <div className="wbs-tree-scroll">
            <div className="wbs-tree-grid wbs-tree-head">
              <span>Dağılım ağacı</span><span>Aktivite</span><span>İlerleme</span><span>Plan Aralığı</span><span>İşlemler</span>
            </div>
            {rows.map(({ node, depth: rowDepth }) => {
              const rollup = rollups.get(node.id) || emptyWbsRollup(node.id);
              const hasChildren = (node.children || []).length > 0;
              const isReparenting = reparenting?.nodeId === node.id;
              const blockedTargets = new Set([node.id, ...selectWbsDescendantIds(wbs, node.id)]);
              const parentCandidates = orderedRows.filter(({ node: candidate }) => !blockedTargets.has(candidate.id));
              const draggable = canEdit && node.parentId != null && !movePending;
              const siblingIndex = draggable ? wbsSiblings(wbs, node.parentId).findIndex((sibling) => sibling.id === node.id) : -1;
              const siblingCount = draggable ? wbsSiblings(wbs, node.parentId).length : 0;
              const hint = dropHint?.nodeId === node.id ? dropHint : null;
              const rowClass = [
                'wbs-tree-grid',
                'wbs-tree-row',
                draggable ? 'draggable' : '',
                drag?.id === node.id ? 'dragging' : '',
                hint ? `drop-${hint.position}` : '',
                hint && !hint.ok ? 'drop-blocked' : ''
              ].filter(Boolean).join(' ');
              return (
                <div
                  key={node.id}
                  className={rowClass}
                  draggable={draggable && dragHandleNodeId === node.id}
                  onDragStart={onRowDragStart(node)}
                  onDragEnd={endDrag}
                  onDragOver={onRowDragOver(node)}
                  onDragLeave={onRowDragLeave(node)}
                  onDrop={onRowDrop(node)}
                  title={hint && !hint.ok ? hint.message : undefined}
                >
                  <div className="row" style={{ gap: 8, minWidth: 0, paddingLeft: rowDepth * 22 }}>
                    {canEdit && (
                      <span
                        className="wbs-drag-handle"
                        aria-hidden="true"
                        title={draggable ? 'Sürükleyerek taşıyın' : 'Kök düğüm taşınamaz'}
                        data-disabled={draggable ? undefined : 'true'}
                        onPointerDown={() => draggable && setDragHandleNodeId(node.id)}
                        onPointerUp={() => setDragHandleNodeId(null)}
                      >
                        <Icons.Grip size={13} />
                      </span>
                    )}
                    <button className="icon-btn" style={{ width: 24, height: 24, visibility: hasChildren ? 'visible' : 'hidden' }} onClick={() => toggle(node.id)}>
                      {expanded.has(node.id) ? <Icons.ChevronDown size={12} /> : <Icons.ChevronRight size={12} />}
                    </button>
                    <div className="col" style={{ gap: 2, minWidth: 0 }}>
                      <div className="row" style={{ gap: 7, minWidth: 0 }}>
                        <span className="badge" style={{ fontFamily: 'var(--font-mono)' }}>{node.code}</span>
                        {editing?.mode === 'rename' && editing.nodeId === node.id ? (
                          <WbsNameInput
                            value={editing.value}
                            ariaLabel="Dağılım düğümü adı"
                            onChange={(value) => setEditing({ ...editing, value })}
                            onSubmit={submitEditing}
                            onCancel={() => setEditing(null)}
                          />
                        ) : (
                          <span style={{ fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
                        )}
                      </div>
                      <span className="muted" style={{ fontSize: 11 }}>
                        Seviye {node.level ?? rowDepth + 1} · {rollup.directTaskCount} doğrudan
                        {node.outlineCode ? ` · PYP ${node.outlineCode}` : ''}
                        {node.elementTypeCode ? ` · ${node.elementTypeCode}` : ''}
                        {node.statusCode ? ` · ${node.statusCode}` : ''}
                      </span>
                      {editing?.mode === 'add' && editing.nodeId === node.id && (
                        <div className="row wbs-inline-add" style={{ gap: 6 }}>
                          <Icons.ChevronRight size={11} />
                          <WbsNameInput
                            value={editing.value}
                            ariaLabel="Yeni alt düğüm adı"
                            placeholder="Yeni alt düğüm adı"
                            onChange={(value) => setEditing({ ...editing, value })}
                            onSubmit={submitEditing}
                            onCancel={() => setEditing(null)}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="tabular">{rollup.taskCount}</div>
                  <div className="col" style={{ gap: 4 }}>
                    <span className="tabular" style={{ fontSize: 12 }}>{rollup.progress}%</span>
                    <div style={{ height: 4, borderRadius: 99, background: 'var(--bg-elev-2)', overflow: 'hidden' }}>
                      <div style={{ width: `${rollup.progress}%`, height: '100%', background: 'var(--accent)' }} />
                    </div>
                  </div>
                  <div className="muted tabular" style={{ fontSize: 11.5 }}>
                    {rollup.plannedStart && rollup.plannedFinish
                      ? `${fmtDisplayDate(rollup.plannedStart)} → ${fmtDisplayDate(rollup.plannedFinish)}`
                      : 'Planlanmış aktivite yok'}
                    {rollup.criticalTaskCount > 0 && <div style={{ color: 'var(--status-overdue)', marginTop: 2 }}>{rollup.criticalTaskCount} kritik</div>}
                  </div>
                  <div className="row" style={{ gap: 5, flexWrap: 'wrap' }}>
                    {canEdit && (isReparenting ? (
                      <>
                        <SearchableSelect
                          value={reparenting.parentId}
                          options={parentCandidates.map(({ node: candidate }) => ({
                            value: candidate.id,
                            label: `${candidate.code} · ${candidate.name}`,
                            keywords: [candidate.code, candidate.name]
                          }))}
                          onChange={(parentId) => setReparenting({ ...reparenting, parentId })}
                          placeholder="Üst düğüm seçin..."
                          searchPlaceholder="WBS kodu veya adıyla ara"
                          emptyText="Taşınabilecek uygun üst düğüm yok."
                          compact
                          style={{ minWidth: 170 }}
                        />
                        <button className="btn" disabled={!reparenting.parentId || reparenting.parentId === node.parentId} onClick={applyReparent}>Uygula</button>
                        <button className="btn" onClick={() => setReparenting(null)}>Vazgeç</button>
                      </>
                    ) : pendingDelete === node.id ? (
                      <>
                        <span className="muted" style={{ fontSize: 11.5 }}>Silinsin mi?</span>
                        <button className="btn danger" onClick={() => confirmDelete(node)}>Evet, sil</button>
                        <button className="btn" onClick={() => setPendingDelete(null)}>Vazgeç</button>
                      </>
                    ) : (
                      <>
                        <button className="btn" onClick={() => startAddChild(node)}>Alt ekle</button>
                        <button className="btn" onClick={() => startRename(node)}>Ad</button>
                        {node.parentId != null && <button className="btn" onClick={() => startReparent(node)}>Taşı</button>}
                        {/* Kardeş sırası sürüklemeye bağlı bırakılamaz: fare
                            kullanmayan bir kullanıcı için bu düğmeler tek yoldur. */}
                        {node.parentId != null && (
                          <>
                            <button
                              className="icon-btn"
                              aria-label="Bir sıra yukarı taşı"
                              title="Bir sıra yukarı taşı"
                              disabled={!draggable || siblingIndex <= 0}
                              onClick={() => moveSibling(node, -1)}
                            >
                              <Icons.ChevronUp size={12} />
                            </button>
                            <button
                              className="icon-btn"
                              aria-label="Bir sıra aşağı taşı"
                              title="Bir sıra aşağı taşı"
                              disabled={!draggable || siblingIndex < 0 || siblingIndex >= siblingCount - 1}
                              onClick={() => moveSibling(node, 1)}
                            >
                              <Icons.ChevronDown size={12} />
                            </button>
                          </>
                        )}
                        <button className="btn" onClick={() => { setEditing(null); setPendingDelete(node.id); }}>Sil</button>
                      </>
                    ))}
                    {!canEdit && (
                      <span className="muted" style={{ fontSize: 11.5 }}>
                        {isCorporate ? 'CN43N kaynaklı · salt okunur' : 'Salt okunur'}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
