export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NEXT_PHASE !== 'phase-production-build') {
    const { startOutlookWorker } = await import('./server/outlook/outlookWorker.js');
    startOutlookWorker();
    // Telemetri turu: ölçüm toplamlarını kalıcılaştırır, işletim olaylarını
    // yazar ve otomatik uyarıları değerlendirir (bkz. server/observability).
    const { startTelemetryWorker } = await import('./server/observability/telemetryWorker.js');
    startTelemetryWorker();
  }
}
