'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Icons } from '../../components/icons.jsx';
import {
  DIRECTORY_MIN_QUERY_LENGTH,
  DIRECTORY_SEARCH_DEBOUNCE_MS,
  searchDirectory
} from '../../data/api/directoryClient.js';

/**
 * Kurum dışı personel arama denetimi.
 *
 * Dizin uygulama anlık görüntüsüne yüklenmez: arama en az
 * {@link DIRECTORY_MIN_QUERY_LENGTH} karakterden sonra, gecikmeli olarak
 * sunucuya gider ve sınırlı sayıda satır döner. Geç gelen yanıt sıra numarasıyla
 * elenir; ekrana yalnızca son sorgunun sonucu yazılır.
 *
 * Kimlik SİCİL'dir: aynı adlı iki çalışan ayrı satır olarak kalır ve seçim her
 * zaman sicille taşınır.
 */
export function DirectoryPersonSearch({
  onSelect,
  selected = null,
  disabled = false,
  placeholder = 'Ad veya sicil ile ara',
  ariaLabel = 'Personel ara',
  excludeSicils = null,
  autoFocus = false
}) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const requestRef = useRef(0);
  const listId = useId();

  useEffect(() => {
    const text = query.trim();
    if (text.length < DIRECTORY_MIN_QUERY_LENGTH) {
      setItems([]);
      setStatus('idle');
      setError(null);
      return undefined;
    }
    setStatus('loading');
    const sequence = requestRef.current + 1;
    requestRef.current = sequence;
    const timer = setTimeout(async () => {
      const result = await searchDirectory(text);
      // Geç gelen yanıt EKRANA yazılmaz: kullanıcı yazmayı sürdürürken eski
      // sorgunun sonucu yenisinin üzerine düşmemelidir.
      if (requestRef.current !== sequence) return;
      if (!result.ok) {
        setItems([]);
        setStatus('error');
        setError(result.message || 'Personel araması yapılamadı.');
        return;
      }
      setItems(result.value?.items || []);
      setStatus('ready');
      setError(null);
    }, DIRECTORY_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const excluded = excludeSicils instanceof Set ? excludeSicils : null;
  const visible = excluded ? items.filter((person) => !excluded.has(String(person.sicil))) : items;

  return (
    <div className="directory-search">
      <div className="topbar-search directory-search-input">
        <Icons.Search size={13} aria-hidden="true" />
        <input
          type="search"
          value={query}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-controls={listId}
          autoFocus={autoFocus}
          placeholder={placeholder}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && (
          <button type="button" className="icon-btn" aria-label="Aramayı temizle" onClick={() => setQuery('')}>
            <Icons.Close size={11} />
          </button>
        )}
      </div>
      {selected && (
        <div className="directory-selected">
          <Icons.Check size={12} aria-hidden="true" />
          <span>{selected.name}</span>
          <small className="tabular">Sicil {selected.sicil}</small>
          <button type="button" className="icon-btn" aria-label="Seçimi kaldır" onClick={() => onSelect?.(null)}>
            <Icons.Close size={11} />
          </button>
        </div>
      )}
      <div id={listId} className="directory-results" role="listbox" aria-label="Arama sonuçları" aria-busy={status === 'loading'}>
        {status === 'idle' && query.trim().length > 0 && query.trim().length < DIRECTORY_MIN_QUERY_LENGTH && (
          <p className="muted">En az {DIRECTORY_MIN_QUERY_LENGTH} karakter yazın.</p>
        )}
        {status === 'loading' && <p className="muted" role="status">Aranıyor…</p>}
        {status === 'error' && <p className="schedule-modal-error" role="alert">{error}</p>}
        {status === 'ready' && !visible.length && <p className="muted">Eşleşen personel bulunamadı.</p>}
        {visible.map((person) => (
          <button
            key={person.sicil}
            type="button"
            role="option"
            aria-selected={String(selected?.sicil ?? '') === String(person.sicil)}
            className="directory-result"
            disabled={disabled}
            onClick={() => onSelect?.(person)}
          >
            <span className="directory-result-name">{person.name}</span>
            <span className="directory-result-sicil tabular">{person.sicil}</span>
            <span className="directory-result-org">
              {[person.organization?.directorate, person.organization?.department, person.organization?.unit]
                .filter(Boolean).join(' / ') || '—'}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
