export function unsavedTaskEditorResult() {
  return {
    ok: false,
    error: {
      code: 'UNSAVED_TASK_EDITOR',
      message: 'Görev penceresindeki değişiklikleri önce Kaydet ile kaydedin veya pencereyi kapatarak vazgeçin.'
    }
  };
}

// Okuyucular güncel ref değerini sorgular; ilk tuş vuruşu render beklemez.
export function createTaskEditorDraftRegistry() {
  const readers = new Set();
  return {
    register(reader) {
      readers.add(reader);
      return () => readers.delete(reader);
    },
    hasPendingChanges(taskId = null) {
      return [...readers].some((reader) => reader(taskId));
    }
  };
}
