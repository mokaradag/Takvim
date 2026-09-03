'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icons } from '../icons';
import { NAV_ITEMS, PAGE_META } from './navigation';

/* ── Command palette (Cmd+K) ────────────────────────── */
export function CommandPalette({ onClose, onNavigate, onOpenTask, onSetTheme, tasks }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);

  // Etkin satır DURUMUN KENDİSİNDE sınırlanır. `setActive((a) => a + 1)`
  // sınırsız artıyor, çizim ise `Math.min(active, items.length - 1)` ile
  // kırpıyordu: kullanıcı ArrowDown tuşuna sonuç sayısından fazla bastıktan
  // sonra ArrowUp'a bastığında seçim oynamıyor, önce fazladan basılan her tuş
  // için bir kez geri saymak gerekiyordu.
  const itemCountRef = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, Math.max(0, itemCountRef.current - 1)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => Math.max(0, a - 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const items = useMemo(() => {
    const nav = NAV_ITEMS.map((n) => ({
      kind: 'nav', icon: n.icon, label: n.label, sub: `${PAGE_META[n.id].sub}`,
      action: () => { onNavigate(n.id); onClose(); }
    }));
    const themes = [
      { kind: 'cmd', icon: 'Sun', label: 'Tema: Açık', action: () => { onSetTheme('light'); onClose(); } },
      { kind: 'cmd', icon: 'Moon', label: 'Tema: Koyu', action: () => { onSetTheme('dark'); onClose(); } }
    ];
    const taskItems = tasks.map((t) => ({
      kind: 'task', icon: 'Target', label: t.task, sub: `${t.proje} · ${t.keyword}`,
      action: () => { onOpenTask(t); onClose(); }
    }));
    let all = [...nav, ...themes, ...taskItems];
    if (q) {
      const Q = q.toLowerCase();
      all = all.filter((i) => i.label.toLowerCase().includes(Q) || (i.sub || '').toLowerCase().includes(Q));
    } else {
      all = [...nav, ...themes, ...taskItems.slice(0, 5)];
    }
    return all;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, tasks]);

  // Sayaç RENDER İÇİNDE değil, işlemeden sonra güncellenir: render saf kalır
  // (React yarıda kesilen bir render'ı atabilir ya da yeniden oynatabilir).
  useEffect(() => {
    itemCountRef.current = items.length;
    // DURUMUN KENDİSİ de kırpılır, yalnızca çizilen değer değil. Sonuç listesi
    // kısaldığında `active` eski (büyük) değerinde kalırsa, kullanıcının bir
    // sonraki ArrowUp'ı görünür seçimi oynatmaz: fazlalık kadar tuşa basması
    // gerekirdi.
    setActive((current) => {
      const max = items.length - 1;
      if (max < 0) return 0;
      return current > max ? max : current;
    });
  }, [items.length]);

  const a = Math.min(active, items.length - 1);

  const onSubmit = (e) => {
    e.preventDefault();
    const it = items[a];
    if (it) it.action();
  };

  // group display
  const grouped = useMemo(() => {
    const out = { Sayfa: [], Komut: [], Görev: [] };
    items.forEach((i) => out[i.kind === 'nav' ? 'Sayfa' : i.kind === 'cmd' ? 'Komut' : 'Görev'].push(i));
    return out;
  }, [items]);

  let idx = -1;
  return (
    <div className="cmd-backdrop" onClick={onClose}>
      <form className="cmd-panel" onClick={(e) => e.stopPropagation()} onSubmit={onSubmit}>
        <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--border)' }}>
          <Icons.Search size={15} className="muted" style={{ marginLeft: 18 }} />
          <input
            ref={inputRef} className="cmd-input"
            placeholder="Sayfaya geç, görev ara veya komut çalıştır..."
            value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }}
            style={{ borderBottom: 0, padding: '14px 14px 14px 10px' }}
          />
        </div>
        <div className="cmd-results">
          {items.length === 0 && <div className="empty" style={{ padding: 28, fontSize: 13 }}>Eşleşme yok.</div>}
          {Object.entries(grouped).map(([group, list]) => {
            if (!list.length) return null;
            return (
              <div key={group}>
                <div className="cmd-group-title">{group}</div>
                {list.map((it) => {
                  // Satır dizini KOPYALANIR: `onMouseEnter` işleyicileri ortak
                  // ve değişebilir `idx` bağlamasını kapatıyordu; çizim
                  // bittiğinde `idx` son satırın dizinine eşit olduğu için
                  // hangi satırın üzerine gelinirse gelinsin SON satır etkin
                  // hâle geliyordu.
                  const itemIndex = ++idx;
                  const isActive = itemIndex === a;
                  const I = Icons[it.icon] || Icons.Target;
                  return (
                    <div key={itemIndex} className={`cmd-row${isActive ? ' active' : ''}`} onMouseEnter={() => setActive(itemIndex)} onClick={() => it.action()}>
                      <I size={14} className="cmd-icon" />
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
                      {it.sub && <span className="cmd-meta">{it.sub}</span>}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </form>
    </div>
  );
}
