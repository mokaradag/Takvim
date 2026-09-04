'use client';

/**
 * Yükleniyor göstergeleri — TEK merkez.
 *
 * Kayıt işlemleri veritabanına yazılırken birkaç saniye sürebilir. Görsel bir
 * geri bildirim olmadan kullanıcı düğmeye ikinci kez basıyor ya da işlemin
 * düştüğünü sanıyordu. Buradaki üç bileşen aynı hareket dilini paylaşır ve
 * `reduce-motion` tercihinde animasyonlar CSS tarafında durur.
 */

/** Satır içi dönen halka. Düğme ve durum satırlarında kullanılır. */
export function Spinner({ size = 14, label = null, className = '' }) {
  return (
    <span
      className={`app-spinner${className ? ` ${className}` : ''}`}
      style={{ '--spinner-size': `${size}px` }}
      role={label ? 'status' : 'presentation'}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : 'true'}
    />
  );
}

/** Düğme içeriği: kayıt sürerken dönen halka, sonrasında asıl simge. */
export function ButtonSpinner({ busy, children, size = 13 }) {
  return busy ? <Spinner size={size} /> : children;
}

/**
 * Kart/form üzerine yayılan kayıt perdesi. Alt içerik görünür kalır; böylece
 * kullanıcı ne kaydedildiğini görmeye devam eder.
 *
 * Perde yalnızca İŞARETÇİYİ durdurur: klavyeyle alt alanlara hâlâ geçilebilir.
 * Alt ağacı ÇAĞIRAN kapatır — perdeyi kullanan her yer, altındaki forma
 * `inert` vermelidir (bkz. SimpleModePanel). Perde `inert` ağacın dışında
 * durmalıdır, aksi hâlde bildirim erişilebilirlik ağacından düşer.
 */
export function SavingOverlay({ active, message = 'Kaydediliyor…' }) {
  if (!active) return null;
  return (
    <div className="saving-overlay" role="status" aria-live="polite">
      <div className="saving-overlay-card">
        <Spinner size={22} />
        <span>{message}</span>
        <span className="saving-overlay-track"><span className="saving-overlay-bar" /></span>
      </div>
    </div>
  );
}
