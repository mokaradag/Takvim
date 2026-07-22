'use client';
import { Icons } from '../icons';
import { buildProjectCsv, buildProjectExcelHtml, safeExportName } from '../../lib/exportProjectData';

function download(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function ProjectExportMenu({ project, projects = [], tasks = [], wbs = [] }) {
  const baseName = safeExportName(project?.name || 'MERGEN_Rota_Portfoy');
  const payload = { project, projects, tasks, wbs };

  const exportCsv = (event) => {
    download(`\ufeff${buildProjectCsv(payload)}`, `${baseName}_Gorevler.csv`, 'text/csv;charset=utf-8');
    event.currentTarget.closest('details')?.removeAttribute('open');
  };

  const exportExcel = (event) => {
    download(`\ufeff${buildProjectExcelHtml(payload)}`, `${baseName}_Proje_Raporu.xls`, 'application/vnd.ms-excel;charset=utf-8');
    event.currentTarget.closest('details')?.removeAttribute('open');
  };

  return (
    <details className="export-menu">
      <summary className="btn sm" title="Dışa aktar">
        <Icons.Download size={13} /> Dışa aktar
      </summary>
      <div className="export-menu-pop">
        <button type="button" onClick={exportExcel}>
          <Icons.Table size={14} />
          <span><strong>Excel raporu</strong><small>Biçimlendirilmiş görev ve WBS tabloları</small></span>
        </button>
        <button type="button" onClick={exportCsv}>
          <Icons.Download size={14} />
          <span><strong>CSV görev listesi</strong><small>Filtreleme ve veri aktarımı için</small></span>
        </button>
      </div>
    </details>
  );
}
