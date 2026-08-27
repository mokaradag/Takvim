function parsedDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function dataRefreshLabel(value, now = new Date()) {
  const date = parsedDate(value);
  if (!date) return 'Verileri yenile';
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  const time = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' }).format(date);
  if (sameDay) return `Son güncelleme ${time}`;
  const day = new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: '2-digit' }).format(date);
  return `Son güncelleme ${day} ${time}`;
}

export function dataRefreshTitle(value) {
  const date = parsedDate(value);
  return date
    ? `Son başarılı veri yüklemesi: ${new Intl.DateTimeFormat('tr-TR', { dateStyle: 'full', timeStyle: 'medium' }).format(date)}`
    : 'Uygulama verilerini yeniden yükle';
}

export function dataRefreshFailure({ localFailure = null, dataStatus, loadError = null } = {}) {
  if (localFailure) return localFailure;
  if (dataStatus !== 'error') return null;
  return loadError?.message || 'Veriler yenilenemedi.';
}
