'use client';
import { useRef, useState } from 'react';
import { Icons } from '../icons';
import { Spinner } from '../Loader';
import {
  buildProjectCsv,
  buildProjectCsvBundle,
  buildProjectWorkbook,
  safeExportName
} from '../../lib/exportProjectData';
import { XLSX_CONTENT_TYPE } from '../../lib/xlsx/xlsxWorkbook';

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

export function ProjectExportMenu({ project, projects = [], tasks = [], wbs = [], people = [] }) {
  const baseName = safeExportName(project?.name || 'MERGEN_Rota_Portfoy');
  // Kişi dizini proje sorumlusunun ADINI çözmek için taşınır: Gerçek Sistem
  // anlık görüntüsü projede yalnızca `leadId` (Sicil) tutar.
  const payload = { project, projects, tasks, wbs, people };
  const [busy, setBusy] = useState(null);
  const [failure, setFailure] = useState('');
  // Yeniden girişi DURUM DEĞİL ref engeller: `busy` bir sonraki çizime kadar
  // güncellenmez ve arka arkaya iki tıklama iki kare kuyruğa girebilirdi.
  // Büyük bir portföyde bu, aynı çalışma kitabını iki kez kurup iki indirme
  // başlatıyordu.
  const runningRef = useRef(false);

  const run = (kind, produce) => (event) => {
    const menu = event.currentTarget.closest('details');
    if (runningRef.current) return;
    runningRef.current = true;
    setBusy(kind);
    setFailure('');
    // Çizim, indirme başlamadan ÖNCE güncellensin diye bir kare beklenir.
    requestAnimationFrame(() => {
      try {
        produce();
        menu?.removeAttribute('open');
      } catch (error) {
        // Hata yutulursa arayüz başarılı bir dışa aktarma gibi görünür ama
        // dosya inmez; menü açık kalır ve neden görünür olur.
        console.error('Dışa aktarma tamamlanamadı', error);
        setFailure('Dışa aktarma tamamlanamadı. Daha dar bir kapsam seçip yeniden deneyin.');
      } finally {
        runningRef.current = false;
        setBusy(null);
      }
    });
  };

  const exportExcel = run('excel', () => download(
    buildProjectWorkbook(payload),
    `${baseName}_Raporu.xlsx`,
    XLSX_CONTENT_TYPE
  ));

  const exportCsvBundle = run('csv-bundle', () => download(
    buildProjectCsvBundle(payload, { baseName }),
    `${baseName}_CSV.zip`,
    'application/zip'
  ));

  const exportCsv = run('csv', () => download(
    `﻿${buildProjectCsv(payload)}`,
    `${baseName}_Gorevler.csv`,
    'text/csv;charset=utf-8'
  ));

  return (
    <details className="export-menu">
      <summary className="btn sm" title="Dışa aktar">
        {busy ? <Spinner size={13} /> : <Icons.Table size={13} />} Dışa aktar
      </summary>
      <div className="export-menu-pop">
        <button type="button" onClick={exportExcel} disabled={Boolean(busy)}>
          <Icons.Table size={14} />
          <span><strong>Excel çalışma kitabı</strong><small>Özet, görevler, dağılım ağacı · süzgeçli ve dondurulmuş başlık</small></span>
        </button>
        <button type="button" onClick={exportCsvBundle} disabled={Boolean(busy)}>
          <Icons.Layers size={14} />
          <span><strong>CSV paketi (ZIP)</strong><small>Her sayfa ayrı CSV dosyası</small></span>
        </button>
        <button type="button" onClick={exportCsv} disabled={Boolean(busy)}>
          <Icons.ArrowRight size={14} />
          <span><strong>Görev listesi (CSV)</strong><small>Tek dosya · veri aktarımı için</small></span>
        </button>
        {failure && <p className="export-menu-error" role="alert">{failure}</p>}
      </div>
    </details>
  );
}
