'use client';
/* ============================================================
   UI primitives — Avatar, Badge, charts, hero header, heptagon
   ============================================================ */
import React from 'react';
import { Icons } from './icons';
import { COLOR_MAP, personColorVar, personInitials, projectColorVar } from '../lib/colors';
import { getStatus } from '../scheduling/metrics';
import { personPhotoUrl } from '../lib/userPhoto';
import { resolveAvatarEntries } from './avatarIdentity.js';
import { usePersonLookup } from './PeopleDirectoryContext.jsx';
import { Tooltip } from './ui-extras';
import { DONUT_EMPHASIS, donutSegments, donutSlicePath } from './charts/donutGeometry.js';

// ── Avatar ─────────────────────────────────────────────────
const AVATAR_SIZE_CLASS = { xl: 'avatar xl', lg: 'avatar lg', sm: 'avatar sm', md: 'avatar' };

/**
 * Kurumsal fotoğraf + baş harf yedeği.
 *
 * `person` veya `employeeNo` verildiğinde ve fotoğraf taban adresi
 * yapılandırılmışsa kurumsal fotoğraf gösterilir. Fotoğraf yüklenemezse
 * (404, ağ hatası, adres yok) kırık görsel simgesi ÇIKMAZ: bileşen sessizce
 * baş harflere döner. Kişi kimliği çözülemediğinde de davranış eski hâliyle
 * aynıdır.
 */
export function Avatar({ name, size = 'md', person = null, personId = null, employeeNo = null, lookupPerson = true }) {
  const lookup = usePersonLookup();
  const [photoFailed, setPhotoFailed] = React.useState(false);

  // Çözüm sırası: doğrudan kişi → kanonik kimlik/Sicil → (son çare) ad.
  // Ad eşleşmesi belirsizse (aynı adlı iki çalışan) kişi çözülmez.
  const resolved = person
    || (personId == null ? null : lookup.byId(personId))
    || (lookupPerson && !employeeNo ? lookup.byName(name) : null);
  const displayName = String(person?.name || name || '').trim();
  const photoKey = String(employeeNo ?? resolved?.employeeNo ?? resolved?.sicil ?? '').trim();
  const photoSrc = photoFailed ? null : personPhotoUrl(photoKey ? { employeeNo: photoKey } : null);

  // Yedek durumu YALNIZCA kişi değiştiğinde sıfırlanır; aksi hâlde hatalı
  // görsel her denemede yeniden istenip döngü oluşur.
  React.useEffect(() => { setPhotoFailed(false); }, [photoKey]);

  if (!displayName && !photoSrc) return null;
  const cls = AVATAR_SIZE_CLASS[size] || AVATAR_SIZE_CLASS.md;
  const label = displayName || 'Kullanıcı';

  if (photoSrc) {
    return (
      // next/image kullanılmaz: kurum içi fotoğraf sunucusu uzak optimizasyon
      // gerektirmez ve çevrimdışı kurulumda ek yapılandırma istemez.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        className={`${cls} avatar-photo`}
        src={photoSrc}
        alt={label}
        title={label}
        loading="lazy"
        decoding="async"
        // Fotoğraf yoksa baş harf yedeğine geçilir; hata günlüğe yazılmaz.
        onError={() => setPhotoFailed(true)}
      />
    );
  }

  return (
    <div className={cls} style={{ background: personColorVar(label) }} title={label} aria-label={label} role="img">
      {personInitials(label)}
    </div>
  );
}

/**
 * Avatar yığını. Fotoğraf gösterebilmek için kanonik `personIds` (Sicil)
 * tercih edilir; `names` yalnızca görüntüleme yedeğidir.
 */
export function AvatarStack({ names = [], personIds = null, people = null, max = 3, size = 'md' }) {
  const lookup = usePersonLookup();
  const entries = resolveAvatarEntries({ people, personIds, names, lookup });
  const visible = entries.slice(0, max);
  const extra = entries.length - visible.length;
  return (
    <div className="avatar-stack">
      {visible.map((entry) => (
        <Avatar key={entry.key} name={entry.name} person={entry.person} size={size} />
      ))}
      {extra > 0 && (
        <div
          className={AVATAR_SIZE_CLASS[size] || AVATAR_SIZE_CLASS.md}
          style={{ background: 'var(--bg-elev-2)', color: 'var(--text-muted)' }}
          title={entries.slice(max).map((entry) => entry.name).filter(Boolean).join(', ')}
        >
          +{extra}
        </div>
      )}
    </div>
  );
}

// ── Keyword chip ───────────────────────────────────────────
export function Kw({ children, projectName, color }) {
  const c = color ? COLOR_MAP[color] : (projectName ? projectColorVar(projectName) : 'var(--c-blue)');
  return <span className="kw" style={{ '--kw-color': c }}>{children}</span>;
}

// ── Status pill — icon + color coded ─────────────────────
const STATUS_ICONS = {
  todo: (p) => <Icons.Circle {...p} />,
  in_progress: (p) => <Icons.Clock {...p} />,
  done: (p) => <Icons.Check {...p} />,
  overdue: (p) => <Icons.Alert {...p} />
};
export function StatusPill({ task, size = 11.5 }) {
  const s = getStatus(task);
  const I = STATUS_ICONS[s.id] || STATUS_ICONS.todo;
  return (
    <span className={`status-pill ${s.cls}`} style={{ fontSize: size }}>
      <I size={11} />
      {s.label}
    </span>
  );
}
export function StatusIcon({ id, size = 12 }) {
  const I = STATUS_ICONS[id] || STATUS_ICONS.todo;
  return <I size={size} />;
}
export function statusColorVar(id) {
  return id === 'done' ? 'var(--status-done)'
    : id === 'in_progress' ? 'var(--status-progress)'
    : id === 'overdue' ? 'var(--status-overdue)'
    : 'var(--status-todo)';
}

// ── Sorted Select — drop-in <select> that sorts options ─
export function SortedSelect({ options, value, onChange, placeholder, locale = 'tr', sortBy = 'label', ...rest }) {
  const sorted = React.useMemo(() => {
    return [...options].sort((a, b) => {
      const al = (sortBy === 'label' ? (a.label ?? a) : (a.value ?? a));
      const bl = (sortBy === 'label' ? (b.label ?? b) : (b.value ?? b));
      return String(al).localeCompare(String(bl), locale);
    });
  }, [options, locale, sortBy]);
  return (
    <select value={value} onChange={onChange} {...rest}>
      {placeholder && <option value="">{placeholder}</option>}
      {sorted.map(o => {
        const v = (typeof o === 'object') ? o.value : o;
        const l = (typeof o === 'object') ? o.label : o;
        return <option key={v} value={v}>{l}</option>;
      })}
    </select>
  );
}

// ── Empty state ────────────────────────────────────────────
export function Empty({ children = 'Henüz veri yok.' }) {
  return <div className="empty">{children}</div>;
}

// ── Sparkline (simple SVG) ─────────────────────────────────
export function Sparkline({ values, color = 'var(--accent)', width = 100, height = 28 }) {
  if (!values || values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const polyline = pts.join(' ');
  const area = `0,${height} ${polyline} ${width},${height}`;
  return (
    <svg width={width} height={height} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id={`spark-${color.replace(/[^a-z0-9]/gi, '')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#spark-${color.replace(/[^a-z0-9]/gi, '')})`} />
      <polyline points={polyline} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ── Donut chart (SVG) ─────────────────────────────────────
/**
 * Halka grafiği.
 *
 * Her dilim kendi yay YOLU olarak çizilir (bkz. charts/donutGeometry.js).
 * Kesik-desenli (`stroke-dasharray`) çizimde desen çevre boyunca tekrarlandığı
 * için yuvarlama artığı aynı dilimi halkanın iki yerinde parça parça
 * gösterebiliyordu; seçili dilimi dışarı ötelemek de dilimi halkadan kopararak
 * aynı bölünmüş görüntüyü üretiyordu. Yol tabanlı çizimde dilimler birbirinden
 * bağımsızdır, aradaki boşluk eşit ve bilinçlidir.
 */
export function Donut({ data, size = 180, thickness = 22, onSegmentClick, selected = null, label = 'Dağılım grafiği' }) {
  const [hover, setHover] = React.useState(null);
  const center = size / 2;
  const outer = center;
  const inner = Math.max(2, center - thickness);
  const segments = donutSegments(data);
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ display: 'block' }}
      role="img"
      aria-label={label}
    >
      {/* Zemin halkası: hiç veri yokken de grafiğin çerçevesi durur. */}
      <path
        d={donutSlicePath(center, center, outer, inner, -90, 270)}
        fill="var(--bg-elev-2)"
        fillRule="evenodd"
      />
      {/* Giriş animasyonu SARMALAYICIDA durur: dilimin kendi `opacity`
          değeri seçim sönümlemesini taşır, animasyon onu ezmemelidir. */}
      <g className="donut-slices">
      {segments.map((segment) => {
        const item = data[segment.index];
        const isSelected = selected === segment.index;
        const emphasised = hover === segment.index || isSelected;
        // Vurgu YALNIZCA kalınlığı içe doğru büyütür: dilim dış çapı aşmadığı
        // için ne kırpılır ne de komşusunun üstüne biner.
        const emphasisedInner = Math.max(2, inner - DONUT_EMPHASIS);
        return (
          <path
            key={item?.id ?? item?.label ?? segment.index}
            d={donutSlicePath(center, center, outer, emphasised ? emphasisedInner : inner, segment.startAngle, segment.endAngle)}
            fill={item?.color}
            className="donut-slice"
            style={{
              cursor: onSegmentClick ? 'pointer' : 'default',
              opacity: selected != null && !isSelected ? 0.42 : 1
            }}
            onMouseEnter={() => setHover(segment.index)}
            onMouseLeave={() => setHover(null)}
            onClick={(event) => {
              event.stopPropagation();
              if (onSegmentClick) onSegmentClick(segment.index, item);
            }}
          >
            <title>{`${item?.label}: ${segment.value} (${Math.round(segment.share * 100)}%)`}</title>
          </path>
        );
      })}
      </g>
      {total === 0 && (
        <text x={center} y={center} textAnchor="middle" dominantBaseline="middle" fontSize="11" fill="var(--text-dim)">
          Veri yok
        </text>
      )}
    </svg>
  );
}

// ── Horizontal bar chart ──────────────────────────────────
export function BarRows({ data, maxLabel = 110, animated = false, tipFormat }) {
  const max = Math.max(...data.map(d => d.value), 1);
  return (
    <div className={`col${animated ? ' stagger' : ''}`} style={{ gap: 10 }}>
      {data.map((d, i) => {
        const row = (
          <div className="row bar-row" style={{ gap: 12 }}>
            <div style={{ width: maxLabel, fontSize: 12.5, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.label}>{d.label}</div>
            <div style={{ flex: 1, background: 'var(--bg-elev-2)', borderRadius: 4, height: 18, position: 'relative', overflow: 'hidden' }}>
              <div style={{ width: `${(d.value / max) * 100}%`, height: '100%', background: d.color || 'var(--accent)', borderRadius: 'inherit', transition: 'width 0.9s cubic-bezier(0.2, 0.8, 0.2, 1)' }} />
            </div>
            <div className="tabular" style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', minWidth: 28, textAlign: 'right' }}>{d.value}</div>
          </div>
        );
        const tip = tipFormat ? tipFormat(d) : (
          <>
            <div className="rt-row"><span className="rt-label">Değer</span><span className="rt-val">{d.value}</span></div>
            <div className="rt-row"><span className="rt-label">Oran</span><span className="rt-val">{Math.round(d.value / max * 100)}%</span></div>
            {d.done != null && <div className="rt-row"><span className="rt-label">Tamamlanan</span><span className="rt-val" style={{ color: 'var(--status-done)' }}>{d.done}</span></div>}
            {d.late != null && d.late > 0 && <div className="rt-row"><span className="rt-label">Geciken</span><span className="rt-val" style={{ color: 'var(--status-overdue)' }}>{d.late}</span></div>}
          </>
        );
        return (
          <Tooltip
            key={i}
            title={d.label}
            icon={<span style={{ width: 10, height: 10, borderRadius: 2, background: d.color || 'var(--accent)', display: 'inline-block' }} />}
            content={tip}
          >
            {row}
          </Tooltip>
        );
      })}
    </div>
  );
}

// ── Area / line chart (small) ──────────────────────────────
export function AreaChart({ data, width = 600, height = 160, color = 'var(--accent)', labels = [], animated = false }) {
  const [hover, setHover] = React.useState(null);
  const svgRef = React.useRef(null);
  // Degrade kimliği belge genelinde benzersizdir. Sabit bir kimlikle aynı
  // sayfadaki ikinci grafik, `url(#...)` ilk tanımı çözdüğü için birincinin
  // rengiyle boyanıyordu.
  const gradientId = `areagrad-${React.useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  if (!data || !data.length) return null;
  const min = Math.min(...data, 0);
  const max = Math.max(...data, 1);
  const range = max - min || 1;
  const pad = 24;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const pts = data.map((v, i) => {
    const x = pad + (i / Math.max(1, data.length - 1)) * innerW;
    const y = pad + innerH - ((v - min) / range) * innerH;
    return [x, y];
  });
  const polyline = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${pts[0][0]},${pad + innerH} ${polyline} ${pts[pts.length - 1][0]},${pad + innerH}`;
  const gridLines = [0, 0.5, 1];

  const onMove = (e) => {
    const svg = svgRef.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * width;
    let bestI = 0; let bestD = Infinity;
    pts.forEach(([px], i) => {
      const dd = Math.abs(px - x);
      if (dd < bestD) { bestD = dd; bestI = i; }
    });
    setHover(bestI);
  };
  const onLeave = () => setHover(null);

  return (
    <div style={{ position: 'relative', width: '100%', overflow: 'visible' }}>
      <svg
        ref={svgRef}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block', width: '100%', height: 'auto', cursor: 'crosshair', overflow: 'visible' }}
        onMouseMove={onMove}
        onMouseLeave={onLeave}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.22" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {gridLines.map((g, i) => (
          <line key={i} x1={pad} x2={width - pad} y1={pad + g * innerH} y2={pad + g * innerH} stroke="var(--border)" strokeDasharray="3 3" />
        ))}
        <polygon points={area} fill={`url(#${gradientId})`} className={animated ? 'chart-area' : ''} />
        <polyline
          points={polyline}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {pts.map(([x, y], i) => (
          <circle
            key={i} cx={x} cy={y}
            r={hover === i ? '4.5' : '3'}
            fill={hover === i ? color : 'var(--bg-elev)'}
            stroke={color}
            strokeWidth="2"
            className={animated ? 'chart-dot' : ''}
            style={animated ? { animationDelay: `${0.25 + i * 0.02}s` } : null}
          />
        ))}
        {hover != null && (
          <line x1={pts[hover][0]} x2={pts[hover][0]} y1={pad} y2={pad + innerH} stroke={color} strokeWidth="1" strokeDasharray="2 2" opacity="0.5" />
        )}
      </svg>
      {/* Eksen etiketleri SVG DIŞINDA, gerçek HTML metni olarak çizilir. SVG
          kart genişliğine göre ölçeklendiği için içerideki `font-size`
          değeri de ölçekleniyor ve geniş kartlarda etiketler devasa
          görünüyordu. HTML metni ölçekten etkilenmez. */}
      {labels.length === data.length && (
        <div className="chart-axis-labels" aria-hidden="true">
          {labels.map((text, index) => (
            text
              ? <span key={index} style={{ left: `${(pts[index][0] / width) * 100}%` }}>{text}</span>
              : null
          ))}
        </div>
      )}
      {hover != null && (
        <div className="rich-tip" style={{
          position: 'absolute',
          left: `${(pts[hover][0] / width) * 100}%`,
          top: 0,
          transform: 'translate(-50%, -110%)',
          pointerEvents: 'none'
        }}>
          <div className="rich-tip-body" style={{ padding: '8px 11px' }}>
            <div className="rt-row"><span className="rt-label">Değer</span><span className="rt-val" style={{ color }}>{data[hover]}</span></div>
            {labels[hover] && <div className="rt-row"><span className="rt-label">Gün</span><span className="rt-val">{labels[hover]}</span></div>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Heptagon emblem (MERGEN brand mark) ────────────────────
// Nested rounded heptagons lifted from the MERGEN Bilge loading emblem.
// Used as a sleek, partially-clipped decoration behind hero titles and the
// sidebar. Decorative only (pointer-events disabled via CSS).
const HEPT_PATHS = [
  { tone: 'teal', d: 'M4.07617 68.3876C-6.36271 63.3152 -18.4952 63.0941 -29.1006 67.7626L-29.6045 67.9891L-57.3223 80.6552C-68.1177 85.5882 -76.1136 95.1087 -79.1162 106.571L-79.2559 107.119L-85.7109 133.281C-88.5535 144.801 -86.0648 156.979 -78.9541 166.453L-78.6123 166.902L-57.3623 194.391C-49.8822 204.067 -38.3416 209.732 -26.1113 209.732H-1.2832C10.7559 209.732 22.126 204.242 29.6133 194.841L29.9678 194.391L50.8477 167.38C58.3082 157.729 60.8848 145.183 57.8535 133.39L57.7051 132.828L50.3564 105.882C47.4521 95.233 40.2303 86.3015 30.4648 81.2264L29.5117 80.7479L4.07617 68.3876Z' },
  { tone: 'teal', d: 'M3.79175 89.1091C-6.6471 84.0367 -18.7796 83.8158 -29.385 88.4841L-29.8889 88.7107L-40.4153 93.5203C-51.2109 98.4533 -59.2067 107.975 -62.2092 119.437L-62.3479 119.984L-64.4778 128.613C-67.3204 140.133 -64.8314 152.311 -57.7209 161.785L-57.3782 162.234L-48.5383 173.67C-41.0582 183.346 -29.5175 189.011 -17.2874 189.011H-10.1067C1.93233 189.011 13.3025 183.521 20.7898 174.12L21.1433 173.67L29.614 162.713C37.0746 153.062 39.6513 140.515 36.6199 128.721L36.4714 128.161L33.905 118.748C31.0008 108.099 23.7782 99.1676 14.0125 94.0925L13.0603 93.613L3.79175 89.1091Z' },
  { tone: 'teal', d: 'M4.32886 50.0105C-6.10996 44.9381 -18.2425 44.7172 -28.8479 49.3855L-29.3518 49.6121L-72.3176 69.2449C-83.1133 74.178 -91.1091 83.6991 -94.1116 95.1619L-94.2502 95.7087L-104.543 137.422C-107.386 148.942 -104.897 161.119 -97.7864 170.594L-97.4446 171.043L-65.1877 212.768C-57.7076 222.444 -46.167 228.11 -33.9368 228.11H6.54175C18.5808 228.11 29.9519 222.62 37.4392 213.219L37.7927 212.768L69.6794 171.52C77.14 161.87 79.7165 149.323 76.6853 137.53L76.5369 136.969L64.947 94.4724C62.0428 83.8235 54.821 74.8923 45.0554 69.8171L44.1023 69.3376L4.32886 50.0105Z' },
  { tone: 'orange', d: 'M7.98242 32.6036C-4.5705 26.504 -19.1598 26.238 -31.9131 31.8517L-32.5195 32.1241L-84.3486 55.8077C-97.3306 61.7399 -106.946 73.1886 -110.557 86.9728L-110.724 87.631L-123.143 137.962C-126.561 151.816 -123.569 166.459 -115.018 177.853L-114.606 178.393L-75.7041 228.716C-66.7091 240.352 -52.8311 247.165 -38.124 247.165H10.7295C25.2068 247.165 38.8801 240.563 47.8838 229.258L48.3096 228.716L86.7686 178.966C95.7401 167.361 98.8386 152.273 95.1934 138.091L95.0156 137.416L81.0322 86.1447C77.4835 73.1325 68.5735 62.253 56.541 56.2042L55.9658 55.9191L7.98242 32.6036Z' },
  { tone: 'orange', d: 'M11.6797 11.9863C-2.98763 4.85926 -20.0342 4.54795 -34.9355 11.1074L-35.6436 11.4248L-99 40.376C-114.169 47.3072 -125.403 60.6852 -129.622 76.791L-129.817 77.5596L-145.033 139.226C-149.027 155.412 -145.531 172.523 -135.54 185.835L-135.06 186.466L-87.5869 247.875C-77.0769 261.47 -60.862 269.431 -43.6777 269.431H16.2832C33.199 269.431 49.1751 261.717 59.6953 248.508L60.1924 247.875L107.148 187.135C117.631 173.575 121.251 155.946 116.992 139.376L116.783 138.587L99.666 75.8242C95.5196 60.6205 85.1088 47.9083 71.0498 40.8408L70.3779 40.5078L11.6797 11.9863Z' }
];
export function Heptagon({ variant = '', style }) {
  return (
    <svg className={`hept-emblem ${variant}`} viewBox="-147.15 5.9 266.39 264.03" fill="none" aria-hidden="true" style={style}>
      <g className="hept-spin">
        {HEPT_PATHS.map((p, i) => (
          <path key={i} className={`hept-p hept-${p.tone}`} d={p.d} />
        ))}
      </g>
    </svg>
  );
}

// ── HeroHeader — gradient page title + decorative heptagon ──
export function HeroHeader({ title, children }) {
  return (
    <div className="hero-head">
      <div className="col hero-head-text" style={{ gap: 6 }}>
        <div className="hero-title">{title}</div>
        {children}
      </div>
    </div>
  );
}
