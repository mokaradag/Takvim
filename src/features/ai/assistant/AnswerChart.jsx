'use client';
import { useRef, useState } from 'react';
import { DONUT_EMPHASIS, donutSegments, donutSlicePath } from '../../../components/charts/donutGeometry.js';
import { Tooltip } from '../../../components/ui-extras';
import { answerChartValue } from '../../../domain/ai/answerChart.js';

/**
 * Kanıta dayalı yanıttaki grafik — sunucunun doğruladığı kapalı tanımdan uygulamanın kendi bileşeniyle
 * çizilir. Değerler ve etiketler yalnızca metin düğümüdür; renkler tema belirteçlerinden sıra sınıfıyla
 * gelir (tanım renk taşımaz). İpuçları uygulamanın ortak zengin ipucudur (fare ve klavye); satırlar tek
 * sekme durağıdır ve ok tuşlarıyla gezilir. Halka dilimleri uygulamanın ortak dilim geometrisini kullanır;
 * halkanın erişilebilir karşılığı açıklama listesidir (dilime dokunmak onu odaklar).
 */

const COPY = Object.freeze({
  tr: { rank: 'Sıra', share: 'Pay', total: 'Toplam', values: 'değer', source: 'Kaynak', verified: 'Doğrulanmış Rota verisi' },
  en: { rank: 'Rank', share: 'Share', total: 'Total', values: 'values', source: 'Source', verified: 'Verified Rota data' }
});
/** Dizi renkleri yalnızca tema belirteçleridir; ipucunun vurgu çizgisi de aynı rengi alır. */
const SERIES_COLORS = Object.freeze(['var(--accent)', 'var(--c-purple)', 'var(--c-cyan)', 'var(--c-emerald)', 'var(--c-amber)', 'var(--c-rose)']);
const series = (index) => `assistant-chart-series-${(index % SERIES_COLORS.length) + 1}`;
const seriesColor = (index) => SERIES_COLORS[index % SERIES_COLORS.length];

/** Satırlar arasında ok tuşlarıyla gezinme: liste tek sekme durağıdır. */
function useRovingFocus(count) {
  const [active, setActive] = useState(0);
  const refs = useRef([]);
  const move = (event, index) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const next = { ArrowDown: index + 1, ArrowRight: index + 1, ArrowUp: index - 1, ArrowLeft: index - 1, Home: 0, End: count - 1 }[event.key];
    if (next == null) return;
    event.preventDefault();
    const target = Math.max(0, Math.min(count - 1, next));
    setActive(target);
    refs.current[target]?.focus();
  };
  return { active, setActive, refs, move };
}

function percentText(value, locale) {
  return answerChartValue(value * 100, 'percent', locale);
}

/** Değerin büyükten küçüğe sırası (eşit değerler aynı sırayı alır). */
const rankOf = (items, value) => 1 + items.filter((other) => other.value > value).length;

/**
 * Zengin ipucunun gövdesi: değer, halkada toplamdaki pay, çubukta sıra; küçük çubuk grafikteki oranın aynısıdır
 * (halkada pay, çubukta en büyük değere oran) ve kaynak notu.
 */
function TipBody({ spec, item, ratio, copy }) {
  const donut = spec.type === 'donut';
  return (
    <>
      <div className="rt-row"><span className="rt-label">{spec.title}</span><span className="rt-val">{answerChartValue(item.value, spec.unit, spec.locale)}</span></div>
      <div className="rt-row"><span className="rt-label">{donut ? copy.share : copy.rank}</span><span className="rt-val">{donut ? percentText(ratio, spec.locale) : `${rankOf(spec.items, item.value)} / ${spec.items.length}`}</span></div>
      <div className="rt-bar"><div style={{ width: `${Math.max(0, Math.min(1, ratio)) * 100}%` }} /></div>
      <div className="rt-foot">{`${copy.source}: ${spec.evidence.join(', ')} · ${copy.verified}`}</div>
    </>
  );
}

const Swatch = ({ index = 0 }) => <span className={`assistant-chart-swatch ${series(index)}`} aria-hidden="true" />;

function BarChart({ spec, copy }) {
  const max = Math.max(...spec.items.map((item) => item.value));
  const roving = useRovingFocus(spec.items.length);
  return (
    <ol className="assistant-chart-bars">
      {spec.items.map((item, index) => {
        const value = answerChartValue(item.value, spec.unit, spec.locale);
        const ratio = max > 0 ? item.value / max : 0;
        return (
          <li key={`${index}-${item.label}`}>
            <Tooltip asChild title={item.label} icon={<Swatch />} content={<TipBody spec={spec} item={item} ratio={ratio} copy={copy} />}>
              <div
                ref={(node) => { roving.refs.current[index] = node; }}
                className="assistant-chart-row"
                role="group"
                tabIndex={roving.active === index ? 0 : -1}
                aria-label={`${item.label}: ${value}`}
                onFocus={() => roving.setActive(index)}
                onKeyDown={(event) => roving.move(event, index)}
              >
                <span className="assistant-chart-label">{item.label}</span>
                <span className="assistant-chart-track" aria-hidden="true">
                  <span className="assistant-chart-fill" style={{ '--chart-ratio': ratio }} />
                </span>
                <span className="assistant-chart-value" aria-hidden="true">{value}</span>
              </div>
            </Tooltip>
          </li>
        );
      })}
    </ol>
  );
}

const RING = Object.freeze({ size: 132, thickness: 18 });

function DonutChart({ spec, copy }) {
  const segments = donutSegments(spec.items);
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  const roving = useRovingFocus(spec.items.length);
  const [hoveredSlice, setHoveredSlice] = useState(null);
  const [hoveredLegend, setHoveredLegend] = useState(null);
  const [focusedLegend, setFocusedLegend] = useState(null);
  // Açıklamanın ipucu ve dilim vurgusu aynı öğeyi izler; fare ayrılınca odak geri gelir.
  const activeLegend = hoveredLegend ?? focusedLegend;
  const active = activeLegend ?? hoveredSlice;
  const center = RING.size / 2;
  const inner = center - RING.thickness;
  const tip = (index) => ({
    title: spec.items[index].label,
    accent: seriesColor(index),
    icon: <Swatch index={index} />,
    content: <TipBody spec={spec} item={spec.items[index]} ratio={total > 0 ? spec.items[index].value / total : 0} copy={copy} />
  });
  return (
    <div className="assistant-chart-donut">
      <svg className="assistant-chart-ring" viewBox={`0 0 ${RING.size} ${RING.size}`} aria-hidden="true" focusable="false">
        <path className="assistant-chart-ring-track" d={donutSlicePath(center, center, center, inner, -90, 270)} fillRule="evenodd" />
        <g className="assistant-chart-slices">
          {segments.map((segment) => (
            <Tooltip key={segment.index} asChild disabled={activeLegend !== null} {...tip(segment.index)}>
              <path
                className={`assistant-chart-slice ${series(segment.index)}${active === segment.index ? ' is-active' : ''}`}
                d={donutSlicePath(center, center, center, active === segment.index ? inner - DONUT_EMPHASIS : inner, segment.startAngle, segment.endAngle)}
                onMouseEnter={() => setHoveredSlice(segment.index)}
                onMouseLeave={() => setHoveredSlice(null)}
                // Dokunmatik ekranda dilime dokunmak açıklamadaki karşılığını odaklar: aynı ipucu klavye ve dokunuşla da açılır.
                onClick={() => roving.refs.current[segment.index]?.focus()}
              />
            </Tooltip>
          ))}
        </g>
        <text className="assistant-chart-ring-total" x={center} y={center - 2} textAnchor="middle">{answerChartValue(total, spec.unit, spec.locale)}</text>
        <text className="assistant-chart-ring-caption" x={center} y={center + 15} textAnchor="middle">{copy.total}</text>
      </svg>
      <ul className="assistant-chart-legend">
        {spec.items.map((item, index) => {
          const value = answerChartValue(item.value, spec.unit, spec.locale);
          return (
            <li key={`${index}-${item.label}`}>
              <Tooltip asChild disabled={activeLegend !== index} {...tip(index)}
                onFocusOwnershipChange={(owned) => {
                  if (owned) setHoveredLegend(null);
                  setFocusedLegend(current => owned ? index : current === index ? null : current);
                }}>
                <div
                  ref={(node) => { roving.refs.current[index] = node; }}
                  className={`assistant-chart-legend-item${active === index ? ' is-active' : ''}`}
                  role="group"
                  tabIndex={roving.active === index ? 0 : -1}
                  aria-label={`${item.label}: ${value}`}
                  onFocus={() => roving.setActive(index)}
                  onMouseEnter={() => setHoveredLegend(index)}
                  onMouseLeave={() => setHoveredLegend(null)}
                  onKeyDown={(event) => roving.move(event, index)}
                >
                  <Swatch index={index} />
                  <span className="assistant-chart-label">{item.label}</span>
                  <span className="assistant-chart-value" aria-hidden="true">{value}</span>
                </div>
              </Tooltip>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** `spec` önceden `normalizeAnswerChart` ile doğrulanmış ve yanıtın kanıtlarına bağlanmış olmalıdır. */
export function AnswerChart({ spec }) {
  const copy = COPY[spec.locale] || COPY.tr;
  return (
    <figure className={`assistant-chart is-${spec.type}`} role="group" aria-label={spec.title}>
      <figcaption className="assistant-chart-head">
        <span className="assistant-chart-title">{spec.title}</span>
        <span className="assistant-chart-meta">{`${spec.items.length} ${copy.values} · ${copy.source} ${spec.evidence.join(', ')}`}</span>
      </figcaption>
      {spec.type === 'donut' ? <DonutChart spec={spec} copy={copy} /> : <BarChart spec={spec} copy={copy} />}
    </figure>
  );
}
