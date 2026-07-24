'use client';
import { useEffect, useMemo, useState } from 'react';
import { Icons } from '../../components/icons';
import {
  buildWbsTree,
  flattenWbsTree,
  formatWbsPath,
  selectWbsDescendantIds,
  selectWbsTaskRollup
} from '../../domain/selectors/index.js';
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
import { canWriteProject } from '../../state/projectWritePolicy.js';

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

export function WbsView() {
  const workspace = useWorkspace();
  const tasks = useWorkspaceTasks();
  const wbs = useWorkspaceWbs();
  const projectSchedule = useProjectSchedule(workspace.selectedProjectId);
  const { moveTasksToWbs } = useTaskActions();
  const { addWbsChild, renameWbs, reparentWbs, deleteWbs, clearWbsError, error } = useWbsActions();
  const tree = useMemo(() => buildWbsTree(wbs), [wbs]);
  const orderedRows = useMemo(() => flattenWbsTree(tree), [tree]);
  const [expanded, setExpanded] = useState(() => new Set());
  const [moveSourceWbsId, setMoveSourceWbsId] = useState('');
  const [moveTargetWbsId, setMoveTargetWbsId] = useState('');
  const [selectedTaskIds, setSelectedTaskIds] = useState(() => new Set());
  const [reparenting, setReparenting] = useState(null);
  const validationIssues = useMemo(() => validateWbsStructure(wbs), [wbs]);

  useEffect(() => {
    setExpanded(new Set(wbs.map((node) => node.id)));
    setMoveSourceWbsId('');
    setMoveTargetWbsId('');
    setSelectedTaskIds(new Set());
    setReparenting(null);
  }, [workspace.selectedProjectId, wbs]);

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

  const canEdit = canWriteProject(workspace.selectedProject);
  const rows = visibleRows(tree, expanded);
  const scheduleTasks = projectSchedule?.tasks || {};
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
    <div className="col" style={{ gap: 16 }}>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <div className="col" style={{ gap: 4 }}>
            <div style={{ fontSize: 17, fontWeight: 700 }}>{projectLabel(workspace.selectedProject)}</div>
            <div className="muted" style={{ fontSize: 12.5 }}>
              {wbs.length} dağılım düğümü · {tasks.length} aktivite · hiyerarşi proje düzeyinde yönetilir
            </div>
          </div>
          <button className="btn" onClick={() => setExpanded(new Set(wbs.map((node) => node.id)))}>Tümünü aç</button>
        </div>
      </div>

      {!canEdit && (
        <div className="card" style={{ borderColor: 'color-mix(in oklab, var(--accent) 35%, var(--border))' }}>
          <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.55 }}>
            Bu projenin iş dağılım ağacı salt okunur görünürlükle açıldı. Hiyerarşiyi ve görev dağılımını görüntüleyebilirsiniz; düzenleme için tam proje yazma yetkisi gerekir.
          </div>
        </div>
      )}

      {(validationIssues.length > 0 || error) && (
        <div className="card" style={{ borderColor: 'color-mix(in oklab, var(--status-overdue) 45%, var(--border))' }}>
          <div className="col" style={{ gap: 6 }}>
            {error && (
              <div className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
                <span style={{ color: 'var(--status-overdue)', fontSize: 12.5 }}>{error.message}</span>
                <button className="btn" onClick={clearWbsError}>Kapat</button>
              </div>
            )}
            {validationIssues.map((item, index) => (
              <div key={`${item.code}-${item.nodeId}-${index}`} className="muted" style={{ fontSize: 12 }}>
                {item.code} · {item.nodeId || 'Dağılım ağacı'}
              </div>
            ))}
          </div>
        </div>
      )}

      {canEdit && wbs.length > 0 && (
        <div className="card">
          <div className="col" style={{ gap: 12 }}>
            <div className="col" style={{ gap: 4 }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>Görevleri dağılım düğümleri arasında taşı</div>
              <div className="muted" style={{ fontSize: 12.5 }}>
                Kaynak düğüme doğrudan atanmış görevlerden birini veya birden çoğunu seçin. Taşıma yalnızca bu proje içindeki geçerli bir hedef düğüme uygulanır.
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) minmax(220px, 1fr)', gap: 12 }}>
              <label className="col" style={{ gap: 6 }}>
                <span className="label">Kaynak düğüm</span>
                <select className="input" value={moveSourceWbsId} onChange={(event) => onSourceChange(event.target.value)}>
                  <option value="">Kaynak seçin...</option>
                  {orderedRows.map(({ node, depth }) => (
                    <option key={node.id} value={node.id}>{`${'— '.repeat(depth)}${formatWbsPath(wbs, node.id)}`}</option>
                  ))}
                </select>
              </label>
              <label className="col" style={{ gap: 6 }}>
                <span className="label">Hedef düğüm</span>
                <select className="input" value={moveTargetWbsId} onChange={(event) => setMoveTargetWbsId(event.target.value)} disabled={!moveSourceWbsId}>
                  <option value="">Hedef seçin...</option>
                  {orderedRows.filter(({ node }) => node.id !== moveSourceWbsId).map(({ node, depth }) => (
                    <option key={node.id} value={node.id}>{`${'— '.repeat(depth)}${formatWbsPath(wbs, node.id)}`}</option>
                  ))}
                </select>
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
        <div className="card wbs-tree-table" style={{ padding: 0, overflow: 'auto' }}>
          <div className="wbs-tree-grid wbs-tree-head">
            <span>Dağılım ağacı</span><span>Aktivite</span><span>İlerleme</span><span>Plan Aralığı</span><span>İşlemler</span>
          </div>
          {rows.map(({ node, depth }) => {
            const rollup = selectWbsTaskRollup(wbs, tasks, node.id, scheduleTasks);
            const hasChildren = (node.children || []).length > 0;
            const isReparenting = reparenting?.nodeId === node.id;
            const blockedTargets = new Set([node.id, ...selectWbsDescendantIds(wbs, node.id)]);
            const parentCandidates = orderedRows.filter(({ node: candidate }) => !blockedTargets.has(candidate.id));
            return (
              <div key={node.id} className="wbs-tree-grid wbs-tree-row">
                <div className="row" style={{ gap: 8, minWidth: 0, paddingLeft: depth * 22 }}>
                  <button className="icon-btn" style={{ width: 24, height: 24, visibility: hasChildren ? 'visible' : 'hidden' }} onClick={() => toggle(node.id)}>
                    {expanded.has(node.id) ? <Icons.ChevronDown size={12} /> : <Icons.ChevronRight size={12} />}
                  </button>
                  <div className="col" style={{ gap: 2, minWidth: 0 }}>
                    <div className="row" style={{ gap: 7, minWidth: 0 }}>
                      <span className="badge" style={{ fontFamily: 'var(--font-mono)' }}>{node.code}</span>
                      <span style={{ fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
                    </div>
                    <span className="muted" style={{ fontSize: 11 }}>Seviye {depth + 1} · {rollup.directTaskCount} doğrudan</span>
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
                      <select className="input" style={{ minWidth: 145, maxWidth: 175 }} value={reparenting.parentId} onChange={(event) => setReparenting({ ...reparenting, parentId: event.target.value })}>
                        <option value="">Üst düğüm seçin...</option>
                        {parentCandidates.map(({ node: candidate }) => <option key={candidate.id} value={candidate.id}>{candidate.code} {candidate.name}</option>)}
                      </select>
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
                  {!canEdit && <span className="muted" style={{ fontSize: 11.5 }}>Salt okunur</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
