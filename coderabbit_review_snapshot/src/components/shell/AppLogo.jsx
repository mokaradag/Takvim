/* ── App logo (SVG mark) ────────────────────────────────── */
export function AppLogo({ size = 34 }) {
  return (
    <div className="brand-mark" style={{ width: size, height: size, borderRadius: Math.max(6, size * 0.26) }}>
      <svg width={size * 0.66} height={size * 0.66} viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        {/* Rota compass mark */}
        <circle cx="12" cy="12" r="8.5" opacity="0.95" />
        <polygon className="logo-compass-needle" points="16.4 7.6 13.5 13.5 7.6 16.4 10.5 10.5" fill="white" stroke="none" />
        <circle cx="12" cy="12" r="1.15" fill="white" stroke="none" />
      </svg>
    </div>
  );
}
