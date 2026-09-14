'use client';
import { Icons } from '../../../components/icons';

/**
 * Yönetim konsolunun bölüm kartı.
 *
 * Yükleme, boş ve hata durumları TEK yerde tanımlanır: her sekme aynı iskelet,
 * aynı boşluk ve aynı başlık hiyerarşisini kullanır.
 */
export function AdminSection({
  title,
  icon = 'Activity',
  description = null,
  actions = null,
  loading = false,
  error = null,
  empty = false,
  emptyMessage = 'Gösterilecek kayıt yok.',
  emptyHint = null,
  skeletonRows = 3,
  children,
  className = ''
}) {
  const Icon = Icons[icon] || Icons.Activity;
  return (
    <section className={`card sysadmin-section ${className}`.trim()}>
      <header className="sysadmin-section-head">
        <div className="sysadmin-section-title">
          <Icon size={14} aria-hidden="true" />
          <h3>{title}</h3>
        </div>
        {description && <p className="sysadmin-section-desc">{description}</p>}
        {actions && <div className="sysadmin-section-actions">{actions}</div>}
      </header>
      {loading ? <SkeletonRows count={skeletonRows} />
        : error ? (
          <p className="sysadmin-inline-error" role="status">
            <Icons.Alert size={13} aria-hidden="true" /> {error}
          </p>
        )
          : empty ? (
            <div className="sysadmin-empty">
              <Icons.Check size={18} aria-hidden="true" />
              <p>{emptyMessage}</p>
              {emptyHint && <small>{emptyHint}</small>}
            </div>
          )
            : children}
    </section>
  );
}

export function SkeletonRows({ count = 3 }) {
  return (
    <div className="sysadmin-skeleton" aria-hidden="true">
      {Array.from({ length: Math.max(1, count) }, (unused, index) => (
        <span key={index} className="sysadmin-skeleton-row" style={{ animationDelay: `${index * 60}ms` }} />
      ))}
    </div>
  );
}
