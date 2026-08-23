export const WORKSPACE_STORAGE_KEY = 'mergen-rota.workspace.v1';

export function readWorkspacePreference(storage) {
  try {
    const target = storage || (typeof window !== 'undefined' ? window.localStorage : null);
    if (!target) return null;
    const raw = target.getItem(WORKSPACE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      workspaceMode: parsed?.workspaceMode || null,
      selectedProjectId: parsed?.selectedProjectId || null
    };
  } catch {
    return null;
  }
}

export function writeWorkspacePreference(preference, storage) {
  try {
    const target = storage || (typeof window !== 'undefined' ? window.localStorage : null);
    if (!target) return false;
    target.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({
      workspaceMode: preference?.workspaceMode || 'portfolio',
      selectedProjectId: preference?.selectedProjectId || null
    }));
    return true;
  } catch {
    return false;
  }
}
