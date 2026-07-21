'use client';
import { useEffect, useMemo, useState } from 'react';
import { Icons } from '../../components/icons';
import {
  buildWbsTree,
  selectWbsTaskRollup
} from '../../domain/selectors/index.js';
import { validateWbsStructure } from '../../domain/validation/index.js';
import {
  useProjectSchedule,
  useWbsActions,
  useWorkspace,
  useWorkspaceTasks,
  useWorkspaceWbs
} from '../../state/hooks';

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

export function WbsView() {
  const workspace = useWorkspace();
  const tasks = useWorkspaceTasks();
  const wbs = useWorkspaceWbs();
  const projectSchedule = useProjectSchedule(workspace.selectedProjectId);
  const { addWbsChild, renameWbs, deleteWbs, clearWbsError, error } = useWbsActions();
  const tree = useMemo(() => buildWbsTree(wbs), [wbs]);
  const [expanded, setExpanded] = useState(() => new Set());
  const validationIssues = useMemo(() => validateWbsStructure(wbs), [wbs]);

  useEffect(() => {
    setExpanded(new Set(wbs.map((node) => node.id)));
  }, [workspace.selectedProjectId, wbs]);

  if (workspace.mode === 'portfolio') {
    return (
      <div className="col" style={{ gap: 16 }}>
        <div className="card">
          <div className="col" style={{ gap: 10 }}>
            <div style={{ fontSize: 17, fontWeight: 700 }}>İş Kırılım Yapısı</div>
            <div className="muted" style={{ maxWidth: 760, lineHeight: 1.6 }}>
              WBS bir proje yapısıdır. Hiyerarşiyi ve proje aktivitelerini görmek ya da düzenlemek için bir proje çalışma alanına geçin.
            </div>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {workspace.projects.map((project) => (
                <button key={project.id} className="btn" onClick={() => workspace.selectWorkspace(project.id)}>
                  {project.name}
                </button>
              ))}
              {!workspace.projects.length && <span className="muted">Henüz proje yok.</span>}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const rows = visibleRows(tree, expanded);
  const scheduleTasks = projectSchedule?.tasks || {};

  const toggle = (id) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onAddChild = (node) => {
    const name = prompt(`${node.code} ${node.name} altında yeni WBS adı:`);
    if (name?.trim()) addWbsChild(node.id, name.trim());
  };

  const onRename = (node) => {
    const name = prompt('Yeni WBS adı:', node.name);
    if (name?.trim() && name.trim() !== node.name) renameWbs(node.id, name.trim());
  };

  const onDelete = (node) => {
    if (confirm(`${node.code} ${node.name} silinsin mi? Yalnızca boş WBS düğümleri silinebilir.`)) deleteWbs(node.id);
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <div className="col" style={{ gap: 4 }}>
            <div style={{ fontSize: 17, fontWeight: 700 }}>{workspace.selectedProject?.name}</div>
            <div className="muted" style={{ fontSize: 12.5 }}>
              {wbs.length} WBS düğümü · {tasks.length} aktivite · hiyerarşi proje düzeyinde yönetilir
            </div>
          </div>
          <button className="btn" onClick={() => setExpanded(new Set(wbs.map((node) => node.id)))}>Tümünü aç</button>
        </div>
      </div>

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
                {item.code} · {item.nodeId || 'WBS'}
              </div>
            ))}
          </div>
        </div>
      )}

      {!wbs.length ? (
        <div className="card muted">Bu proje için WBS tanımlı değil.</div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 1fr) 110px 110px 190px 160px', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            <span>WBS</span><span>Aktivite</span><span>İlerleme</span><span>Plan Aralığı</span><span>İşlemler</span>
          </div>
          {rows.map(({ node, depth }) => {
            const rollup = selectWbsTaskRollup(wbs, tasks, node.id, scheduleTasks);
            const hasChildren = (node.children || []).length > 0;
            return (
              <div key={node.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 1fr) 110px 110px 190px 160px', alignItems: 'center', minHeight: 54, padding: '8px 14px', borderBottom: '1px solid var(--border)' }}>
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
                  {rollup.plannedStart && rollup.plannedFinish ? `${rollup.plannedStart} → ${rollup.plannedFinish}` : 'Planlanmış aktivite yok'}
                  {rollup.criticalTaskCount > 0 && <div style={{ color: 'var(--status-overdue)', marginTop: 2 }}>{rollup.criticalTaskCount} kritik</div>}
                </div>
                <div className="row" style={{ gap: 5, flexWrap: 'wrap' }}>
                  <button className="btn" onClick={() => onAddChild(node)}>Alt ekle</button>
                  <button className="btn" onClick={() => onRename(node)}>Ad</button>
                  <button className="btn" onClick={() => onDelete(node)}>Sil</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
