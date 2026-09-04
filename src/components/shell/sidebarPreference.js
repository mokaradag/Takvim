export const SIDEBAR_PREFERENCE_KEY = 'mergen_rota_sidebar_v1';
export const DEFAULT_SIDEBAR_PREFERENCE = Object.freeze({ pinned: true, collapsed: false });

export function readSidebarPreference(storage) {
  try {
    // Bazı gömülü/sandbox tarayıcı bağlamlarında `localStorage` özelliğini
    // OKUMAK bile SecurityError fırlatır. Varsayılan parametre fonksiyonun
    // `try` bloğundan önce değerlendirildiği için erişimi burada çöz.
    const resolvedStorage = storage === undefined ? globalThis.localStorage : storage;
    const value = JSON.parse(resolvedStorage?.getItem(SIDEBAR_PREFERENCE_KEY) || 'null');
    if (!value || typeof value !== 'object') return { ...DEFAULT_SIDEBAR_PREFERENCE };
    return { pinned: value.pinned !== false, collapsed: value.collapsed === true };
  } catch {
    return { ...DEFAULT_SIDEBAR_PREFERENCE };
  }
}

export function writeSidebarPreference(preference, storage) {
  try {
    const resolvedStorage = storage === undefined ? globalThis.localStorage : storage;
    resolvedStorage?.setItem(SIDEBAR_PREFERENCE_KEY, JSON.stringify({
      pinned: preference?.pinned !== false,
      collapsed: preference?.collapsed === true
    }));
  } catch {}
}
