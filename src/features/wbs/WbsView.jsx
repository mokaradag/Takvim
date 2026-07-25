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
  const { addWbsChild, renameWbs, reparentWbs, deleteWbs, clearWbsError, error } = useWbsActions();
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
  const validationIssues = useMemo(() => validateWbsStructure(wbs), [wbs]);
  // Toplulaştırmalar satır başına değil, ağacın tamamı için tek geçişte
  // hesaplanır; 38 bin düğümlü kurumsal ağaçta satır çizimi böylece ucuz kalır.
  const rollups = useMemo(
    () => selectWbsRollupIndex(wbs, tasks, projectSchedule?.tasks || {}),
    [wbs, tasks, projectSchedule]
  );

  useEffect(() => {
    setExpanded(expandedIdsForDepth(orderedRows, DEFAULT_WBS_DEPTH));
    setDepth(DEFAULT_WBS_DEPTH);
    setMoveOpen(false);
    setMoveSourceWbsId('');
    setMoveTargetWbsId('');
    setSelectedTaskIds(new Set());
    setReparenting(null);
  }, [workspace.selectedProjectId, orderedRows]);

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

  const onAddChild = (node) => {
    const name = prompt(`${node.code} ${node.name} altında yeni dağılım düğümü adı:`);
    if (name?.trim()) addWbsChild(node.id, name.trim());
  };

  const onRename = (node) => {
    const name = prompt('Yeni dağılım düğümü adı:', node.name);
    if (name?.trim() && name.trim() !== node.name) renameWbs(node.id, name.trim());
  };

  const onDelete = (node) => {
    if (confirm(`${node.code} ${node.name} silinsin mi? Yalnızca boş dağılım düğümleri silinebilir.`)) deleteWbs(node.id);
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

      {(isCorporate || (!canEdit && !isCorporate) || validationIssues.length > 0 || error) && (
        <div className="wbs-notices">
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
              return (
                <div key={node.id} className="wbs-tree-grid wbs-tree-row">
                  <div className="row" style={{ gap: 8, minWidth: 0, paddingLeft: rowDepth * 22 }}>
                    <button className="icon-btn" style={{ width: 24, height: 24, visibility: hasChildren ? 'visible' : 'hidden' }} onClick={() => toggle(node.id)}>
                      {expanded.has(node.id) ? <Icons.ChevronDown size={12} /> : <Icons.ChevronRight size={12} />}
                    </button>
                    <div className="col" style={{ gap: 2, minWidth: 0 }}>
                      <div className="row" style={{ gap: 7, minWidth: 0 }}>
                        <span className="badge" style={{ fontFamily: 'var(--font-mono)' }}>{node.code}</span>
                        <span style={{ fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
                      </div>
                      <span className="muted" style={{ fontSize: 11 }}>
                        Seviye {node.level ?? rowDepth + 1} · {rollup.directTaskCount} doğrudan
                        {node.outlineCode ? ` · PYP ${node.outlineCode}` : ''}
                        {node.elementTypeCode ? ` · ${node.elementTypeCode}` : ''}
                        {node.statusCode ? ` · ${node.statusCode}` : ''}
                      </span>
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
                    ) : (
                      <>
                        <button className="btn" onClick={() => onAddChild(node)}>Alt ekle</button>
                        <button className="btn" onClick={() => onRename(node)}>Ad</button>
                        {node.parentId != null && <button className="btn" onClick={() => startReparent(node)}>Taşı</button>}
                        <button className="btn" onClick={() => onDelete(node)}>Sil</button>
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
