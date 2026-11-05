/** Sunucu çıktısı parçalı gelse de hazırlığı süre ve bellek sınırıyla bekler. */
export function waitForServerReady(server, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    const finish = (error) => {
      clearTimeout(timer);
      server.stdout.off('data', onOutput);
      server.stderr.off('data', onErrorOutput);
      server.off('error', onError);
      server.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onOutput = (chunk) => {
      output = (output + String(chunk)).slice(-8192);
      if (output.includes('Ready in')) finish();
    };
    const onErrorOutput = (chunk) => { errors = (errors + String(chunk)).slice(-8192); };
    const onError = (error) => finish(error);
    const onExit = (code, signal) => finish(new Error(`Sunucu hazır olmadan kapandı (${code ?? signal}): ${errors || output}`));
    const timer = setTimeout(() => finish(new Error(`Sunucu ${timeoutMs} ms içinde hazır olmadı: ${errors || output}`)), timeoutMs);
    server.stdout.on('data', onOutput);
    server.stderr.on('data', onErrorOutput);
    server.once('error', onError);
    server.once('exit', onExit);
  });
}

/** Başarıda ve hatada sunucunun kapanmasını bekler; yanıt vermezse sonlandırır. */
export async function stopServer(server) {
  if (server.exitCode != null || server.signalCode != null) return;
  await new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(force);
      clearTimeout(deadline);
      server.off('close', onClose);
      if (error) reject(error);
      else resolve();
    };
    const onClose = () => finish();
    const force = setTimeout(() => server.kill('SIGKILL'), 2000);
    const deadline = setTimeout(() => finish(new Error('Sınama sunucusu kapatılamadı.')), 5000);
    server.once('close', onClose);
    server.kill('SIGTERM');
  });
}
