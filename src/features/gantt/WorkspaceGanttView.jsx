'use client';
import { useEffect, useMemo, useState } from 'react';
import { DateInput } from '../../components/DateInput';
import { fmt, fmtISO, today } from '../../scheduling/dates';
import {
  MAX_GANTT_RANGE_DAYS,
  calculateTaskDateRange,
  clearGanttDateRangeOverride,
  setGanttDateRangeOverride
} from '../../scheduling/metrics';
import { useWorkspace, useWorkspaceTasks } from '../../state/hooks';
import { GanttView } from './GanttView';
import { WbsGanttView } from './WbsGanttView';

export function WorkspaceGanttView() {
  const workspace = useWorkspace();
  const tasks = useWorkspaceTasks();
  const [mode, setMode] = useState('wbs');
  const [rangeMode, setRangeMode] = useState('auto');
  const [rangeRevision, setRangeRevision] = useState(0);
  const [rangeError, setRangeError] = useState('');

  const automaticRange = useMemo(
    () => calculateTaskDateRange(tasks, { paddingDays: 3, fallbackStart: today(), fallbackDays: 30 }),
    [tasks]
  );
  const autoStart = fmtISO(automaticRange.start);
  const autoEnd = fmtISO(automaticRange.end);
  const [rangeStart, setRangeStart] = useState(autoStart);
  const [rangeEnd, setRangeEnd] = useState(autoEnd);

  // GÖRÜNÜM sıfırlaması yalnızca PROJE değişiminde yapılır.
  //
  // Etki `autoStart`/`autoEnd` değerlerine de bağlıydı; ikisi de `tasks`
  // üzerinden `calculateTaskDateRange` ile türetilir. Bu yüzden bir iş
  // arkadaşının tek bir tarih düzenlemesi (60 saniyelik otomatik yenilemeyle
  // gelen) çalışma alanının en erken başlangıcını ya da en geç bitişini
  // oynattığında etki yeniden çalışıyor, `rangeRevision` artıyor, `chartKey`
  // değişiyor ve grafik SÖKÜLÜP yeniden kuruluyordu: yakınlaştırma, sütun
  // süzgeçleri, sıralama, açık WBS dalları, kip seçimi ve kullanıcının açıkça
  // uyguladığı özel aralık sessizce kayboluyordu.
  useEffect(() => {
    setMode('wbs');
    setRangeMode('auto');
    setRangeStart(autoStart);
    setRangeEnd(autoEnd);
    setRangeError('');
    clearGanttDateRangeOverride();
    setRangeRevision((value) => value + 1);
    // `autoStart`/`autoEnd` BİLEREK dışarıda: bunlar veriden türer, kullanıcı
    // eyleminden değil. Aşağıdaki etki onları izler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.selectedProjectId]);

  // Otomatik kipteyken görünen aralık veriyle birlikte güncellenir; ÖZEL aralık
  // korunur ve grafik yeniden kurulmaz (`rangeRevision` artmaz).
  useEffect(() => {
    if (rangeMode !== 'auto') return;
    setRangeStart(autoStart);
    setRangeEnd(autoEnd);
  }, [autoStart, autoEnd, rangeMode]);

  useEffect(() => () => clearGanttDateRangeOverride(), []);

  const applyRange = () => {
    if (!rangeStart || !rangeEnd) {
      setRangeError('Başlangıç ve bitiş tarihlerini seçin.');
      return;
    }
    if (rangeStart > rangeEnd) {
      setRangeError('Başlangıç tarihi bitiş tarihinden sonra olamaz.');
      return;
    }
    // UYGULANAN aralık geri okunur. `setGanttDateRangeOverride` sınırı aşan bir
    // aralığı kırpar; dönen değer yok sayılıp denetimler kullanıcının yazdığı
    // tarihlerde bırakılsaydı, grafik yalnızca kırpılmış bölümü çizerken üstteki
    // özet ve tarih kutuları tam aralığın etkin olduğunu söylerdi — kullanıcı
    // görmediği bir aralığa güvenip dışarıda kalan görevleri kaçırırdı.
    const applied = setGanttDateRangeOverride({ start: rangeStart, end: rangeEnd });
    if (applied) {
      setRangeStart(fmtISO(applied.start));
      setRangeEnd(fmtISO(applied.end));
    }
    setRangeMode('custom');
    setRangeError(applied?.truncated
      ? `Görüntü aralığı en fazla ${MAX_GANTT_RANGE_DAYS} gün olabilir; bitiş ${fmt(fmtISO(applied.end), 'dd MMM yyyy')} tarihine kısaltıldı.`
      : '');
    setRangeRevision((value) => value + 1);
  };

  const resetRange = () => {
    clearGanttDateRangeOverride();
    setRangeMode('auto');
    setRangeStart(autoStart);
    setRangeEnd(autoEnd);
    setRangeError('');
    setRangeRevision((value) => value + 1);
  };

  const chartKey = `${workspace.selectedProjectId || 'portfolio'}:${mode}:${rangeRevision}`;

  return (
    <div className="gantt-page col" style={{ gap: 12 }}>
      <div className="row gantt-page-controls" style={{ justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        {workspace.mode === 'project' ? (
          <ProjectGanttModeSwitch mode={mode} setMode={setMode} />
        ) : (
          <div className="muted" style={{ fontSize: 11.5 }}>Portföy Gantt görünümü tüm projeleri birlikte gösterir.</div>
        )}
        <div className="gantt-range-controls">
          <span className="muted" style={{ fontSize: 11.5 }}>Görüntü aralığı</span>
          <DateInput value={rangeStart} onChange={setRangeStart} allowEmpty={false} ariaLabel="Gantt görüntü başlangıç tarihi" />
          <span className="muted">—</span>
          <DateInput value={rangeEnd} onChange={setRangeEnd} allowEmpty={false} ariaLabel="Gantt görüntü bitiş tarihi" />
          <button type="button" className="btn primary sm" onClick={applyRange}>Uygula</button>
          <button type="button" className={`btn sm${rangeMode === 'auto' ? ' ghost' : ''}`} onClick={resetRange}>Otomatik</button>
        </div>
      </div>
      <div className="gantt-range-summary">
        {rangeMode === 'auto'
          ? `Otomatik aralık: ${fmt(autoStart, 'dd MMM yyyy')} – ${fmt(autoEnd, 'dd MMM yyyy')}`
          : `Seçili aralık: ${fmt(rangeStart, 'dd MMM yyyy')} – ${fmt(rangeEnd, 'dd MMM yyyy')}`}
        {/* Otomatik kırpma uyarısı YALNIZCA otomatik kipte anlamlıdır; özel
            aralığın kırpılması `rangeError` ile ayrıca bildirilir. */}
        {rangeMode === 'auto' && automaticRange.truncated && (
          <span style={{ marginLeft: 10, color: 'var(--status-overdue)', fontWeight: 600 }}>
            {`Görüntü aralığı ${MAX_GANTT_RANGE_DAYS} güne kısaltıldı; planda çok uzak tarihli görevler var.`}
          </span>
        )}
        {rangeError && <span style={{ marginLeft: 10, color: 'var(--status-overdue)', fontWeight: 600 }}>{rangeError}</span>}
      </div>

      <div className="gantt-chart-host">
        {workspace.mode === 'portfolio'
          ? <GanttView key={chartKey} />
          : mode === 'wbs'
            ? <WbsGanttView key={chartKey} />
            : <GanttView key={chartKey} />}
      </div>
    </div>
  );
}

function ProjectGanttModeSwitch({ mode, setMode }) {
  return (
    <div className="gantt-mode-switch row" style={{ gap: 12, flexWrap: 'wrap' }}>
      <div className="seg">
        <button className={mode === 'wbs' ? 'active' : ''} onClick={() => setMode('wbs')}>WBS</button>
        <button className={mode === 'person' ? 'active' : ''} onClick={() => setMode('person')}>Sorumlu / Kritik Yol</button>
      </div>
    </div>
  );
}
