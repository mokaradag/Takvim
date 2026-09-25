/**
 * Ayarlar · Yapay zekâ erişimi kartı.
 *
 * Gerçek bileşen tarayıcı olmadan çizilir: Demo Kipinde istek atılmaması,
 * hangi anahtarın kullanılacağının dürüst gösterimi, kaydedilen anahtarın bir
 * daha çizilmemesi ve taslağın silinmesi, kaldırmanın onay istemesi, deneme
 * isteğinin iptali ve bayat sonucun uygulanmaması burada sınanır.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as immediate } from 'node:timers/promises';
import { findElement, mountComponent } from './helpers/clientComponentHarness.mjs';

const { AiAccessSettings } = await import('../src/features/ai/AiAccessSettings.jsx');
const presentation = await import('../src/features/ai/aiPresentation.js');
const { DataModeContext } = await import('../src/components/shell/DataModeContext.jsx');

const TYPED_KEY = 'rota-test-ui-typed-key-7Qm2Vx9b';

function withDataMode(t, dataMode) {
  const previous = DataModeContext._currentValue;
  DataModeContext._currentValue = { dataMode, async setDataMode() {} };
  t.after(() => { DataModeContext._currentValue = previous; });
}

function statusFixture(overrides = {}) {
  return {
    enabled: true,
    available: true,
    personalKeysSupported: true,
    personalKeysConfigured: true,
    defaultKeyConfigured: true,
    schemaReady: true,
    effectiveSource: 'default',
    credential: { configured: false },
    timeouts: { queueTimeoutMs: 20000, requestTimeoutMs: 90000, validationBudgetMs: 40000 },
    probe: { available: true, reason: null, timeoutMs: 90000, budgetMs: 115000 },
    ...overrides
  };
}

function personalStatus(credential = {}, overrides = {}) {
  return statusFixture({
    effectiveSource: 'personal',
    credential: {
      configured: true,
      readable: true,
      hint: 'Vx9b',
      updatedAt: '2026-09-20T08:30:00.000Z',
      lastValidatedAt: null,
      lastValidationStatus: null,
      ...credential
    },
    ...overrides
  });
}

/**
 * Yapay zekâ uçlarının ikizi. Yanıtlar kuyruğa alınır; `defer` ile verilen
 * yanıt test çözene kadar askıda kalır ve (gerçek fetch gibi) iptal edilince
 * AbortError ile reddedilir; `fail` ağ hatası üretir. Kuyrukta karşılığı
 * olmayan istek kaydedilir ve test sonunda başarısızlıktır: `requestJson`
 * fırlatan fetch'i ağ hatasına çevirdiği için beklenmeyen istek aksi hâlde
 * gözden kaçabilirdi.
 */
function stubAiServer(t) {
  const previous = globalThis.fetch;
  const calls = [];
  const unexpected = [];
  const queued = new Map();
  const reply = (route, body, status = 200) => {
    if (!queued.has(route)) queued.set(route, []);
    queued.get(route).push({ body, status });
  };
  const fail = (route) => {
    if (!queued.has(route)) queued.set(route, []);
    queued.get(route).push({ error: new TypeError('fetch failed') });
  };
  const defer = (route, { honorAbort = true } = {}) => {
    const pending = {};
    pending.promise = new Promise((resolve, reject) => {
      pending.resolve = (body, status = 200) => resolve(Response.json(body, { status }));
      pending.honorAbort = honorAbort;
      pending.reject = reject;
    });
    if (!queued.has(route)) queued.set(route, []);
    queued.get(route).push({ pending });
    return pending;
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^.*\/api\/mergen-rota\/ai/, '');
    const call = { url: String(url), path, method: init.method || 'GET', body: init.body ?? null, signal: init.signal };
    calls.push(call);
    const next = queued.get(`${call.method} ${path}`)?.shift();
    if (!next) {
      unexpected.push(`${call.method} ${path}`);
      throw new Error(`beklenmeyen istek: ${call.method} ${path}`);
    }
    if (next.error) throw next.error;
    if (!next.pending) return Response.json(next.body, { status: next.status });
    if (next.pending.honorAbort && init.signal) {
      const abort = () => next.pending.reject(new DOMException('İstek iptal edildi.', 'AbortError'));
      if (init.signal.aborted) abort();
      else init.signal.addEventListener('abort', abort, { once: true });
    }
    return next.pending.promise;
  };
  t.after(() => {
    try {
      assert.deepEqual(unexpected, [], 'beklenmeyen istek yapılmamalıdır');
    } finally {
      globalThis.fetch = previous;
    }
  });
  return { calls, reply, defer, fail };
}

/** Tarayıcı depolarına hiç dokunulmadığını kanıtlamak için erişimi kaydeder. */
function watchBrowserStorage(t) {
  const touched = [];
  for (const name of ['localStorage', 'sessionStorage']) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        touched.push(name);
        return undefined;
      }
    });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    });
  }
  return touched;
}

async function drain() {
  for (let round = 0; round < 6; round += 1) await immediate();
}

async function settle(view) {
  await drain();
  view.render();
}

async function mountActual(t) {
  withDataMode(t, 'actual');
  const view = mountComponent(AiAccessSettings, {});
  t.after(() => view.unmount());
  await settle(view);
  return view;
}

/** Görünür metin; `ProbeResult` gibi kancasız iç bileşenler de açılır. */
function textOf(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node.type === 'function' && node.props && Object.hasOwn(node.props, 'probe')) return textOf(node.type(node.props));
  return textOf(node.props?.children);
}

function findButton(tree, text) {
  const found = findElement(tree, (node) => node.type === 'button' && textOf(node).includes(text));
  assert.ok(found, `"${text}" düğmesi bulunmalıdır`);
  return found;
}

function hasButton(tree, text) {
  return Boolean(findElement(tree, (node) => node.type === 'button' && textOf(node).includes(text)));
}

function keyInput(tree) {
  const input = findElement(tree, (node) => node.type === 'input');
  assert.ok(input, 'anahtar alanı bulunmalıdır');
  return input;
}

function probeText(tree) {
  const result = findElement(tree, (node) => node.props && Object.hasOwn(node.props, 'probe'));
  return result ? textOf(result) : '';
}

/* ── Saf sunum kuralları ─────────────────────────────────── */

test('durum çipi hangi anahtarın kullanılacağını söyler', () => {
  const { aiAccessChip } = presentation;
  assert.equal(aiAccessChip(null), null);
  assert.deepEqual(aiAccessChip(statusFixture({ enabled: false })), { tone: 'muted', label: 'Kapalı' });
  assert.deepEqual(aiAccessChip(statusFixture({ available: false })), { tone: 'warn', label: 'Yapılandırılmadı' });
  assert.deepEqual(aiAccessChip(personalStatus()), { tone: 'accent', label: 'Kişisel anahtar' });
  assert.deepEqual(aiAccessChip(statusFixture()), { tone: 'neutral', label: 'Kurumsal anahtar' });
  assert.deepEqual(aiAccessChip(statusFixture({ effectiveSource: 'missing' })), { tone: 'warn', label: 'Anahtar gerekli' });
});

test('açıklamalar kurumsal anahtarın yalnızca kişisel anahtar yokken kullanıldığını anlatır', () => {
  const { missingKeyDescription, removalConsequence } = presentation;
  assert.match(missingKeyDescription(statusFixture()), /kurumsal varsayılan anahtarla/);
  assert.match(missingKeyDescription(statusFixture({ defaultKeyConfigured: false })), /kişisel anahtarınızı ekleyin/);
  assert.match(missingKeyDescription(statusFixture({ personalKeysSupported: false })), /etkin değil; istekler kurumsal anahtarla/);
  assert.match(removalConsequence(statusFixture()), /kurumsal varsayılan anahtarla yapılır/);
  assert.match(removalConsequence(statusFixture({ defaultKeyConfigured: false })), /kullanılamaz/);
  // Yapılandırma kullanılamazken kurumsal anahtara dönüş vaat edilmez.
  const unavailable = statusFixture({ available: false, personalKeysSupported: false });
  assert.doesNotMatch(removalConsequence(unavailable), /kurumsal/);
  assert.match(removalConsequence(unavailable), /yapılandırma düzeltilene kadar/);
  assert.doesNotMatch(missingKeyDescription(unavailable), /kurumsal/);
});

test('kullanılamayan kayıtlı anahtar dürüstçe anlatılır', () => {
  const { storedKeyNotice } = presentation;
  assert.equal(storedKeyNotice(personalStatus()), null);
  assert.match(storedKeyNotice(personalStatus({ readable: false })), /okunamıyor.*yeniden kaydedin/);
  // Ana anahtar kaldırıldıysa kayıtlı anahtar kullanılmaz; kurumsal anahtar kullanılır.
  const disabled = personalStatus({ readable: false, unreadableReason: 'PERSONAL_KEYS_DISABLED' }, { personalKeysSupported: false, effectiveSource: 'default' });
  assert.match(storedKeyNotice(disabled), /kayıtlı anahtarınız kullanılmıyor, istekler kurumsal anahtarla/);
  assert.doesNotMatch(storedKeyNotice(disabled), /şifreleme anahtarı değişti/, 'kapalı kullanım, değişen ana anahtar gibi anlatılmaz');
  // Kurumsal anahtara dönüş yoksa ya da yapılandırma kullanılamıyorsa dönüş vaat edilmez.
  const disabledUnavailable = personalStatus({ readable: false, unreadableReason: 'PERSONAL_KEYS_DISABLED' }, {
    available: false, personalKeysSupported: false, effectiveSource: 'missing'
  });
  assert.match(storedKeyNotice(disabledUnavailable), /kayıtlı anahtarınız kullanılmıyor\.$/);
  const rotated = personalStatus({ readable: false, unreadableReason: 'MASTER_KEY_CHANGED' });
  assert.match(storedKeyNotice(rotated), /şifreleme anahtarı değişti/);
});

test('doğrulama özeti ve bildirimi üç kalıcı sonucu ayırır', () => {
  const { validationNotice, validationSummary } = presentation;
  const at = '2026-09-21T09:15:00.000Z';
  assert.equal(validationSummary({ lastValidationStatus: null }), null);
  assert.equal(validationSummary({ lastValidationStatus: 'VALID', lastValidatedAt: at }).tone, 'ok');
  assert.match(validationSummary({ lastValidationStatus: 'REJECTED', lastValidatedAt: at }).text, /^Reddedildi \(/);
  assert.match(validationSummary({ lastValidationStatus: 'FORBIDDEN', lastValidatedAt: at }).text, /^Yetkisi yetersiz \(/);
  assert.equal(validationNotice({ status: 'VALID' }).tone, 'ok');
  assert.match(validationNotice({ status: 'REJECTED' }).text, /kurumsal anahtara aktarılmaz/);
  assert.equal(validationNotice({ status: 'FORBIDDEN' }).tone, 'warn');
  // Doğrulama sürerken değişen anahtar için sonuç bildirilmez.
  const stale = validationNotice({ status: null, stale: true });
  assert.equal(stale.tone, 'neutral');
  assert.match(stale.text, /sonuç yeni anahtara uygulanmadı/);
});

test('hata iletisi önce sunucunun Türkçe iletisini, sonra istemci ve katalog karşılığını kullanır', () => {
  const { aiFailureMessage } = presentation;
  assert.equal(aiFailureMessage({ code: 'AI_BUSY', message: 'Sunucu iletisi.' }), 'Sunucu iletisi.');
  assert.equal(aiFailureMessage({ code: 'REQUEST_CANCELLED' }), 'İstek iptal edildi.');
  assert.match(aiFailureMessage({ code: 'REQUEST_TIMEOUT' }), /süre sınırında/);
  assert.match(aiFailureMessage({ code: 'AI_RATE_LIMITED' }), /\S/);
  assert.equal(aiFailureMessage({ code: 'constructor' }), 'İşlem tamamlanamadı.');
  assert.equal(aiFailureMessage(null), 'İşlem tamamlanamadı.');
});

test('istek sarmalayıcısının gerçek sonuçlarında istemci ve katalog iletisi ham ya da genel metne yenilmez', async (t) => {
  const { aiFailureMessage } = presentation;
  const { requestJson } = await import('../src/features/shared/jsonRequest.js');
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });

  // Süre aşımı: sarmalayıcının `REQUEST_TIMEOUT: …` iletisi kullanıcıya taşınmaz.
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('iptal', 'AbortError')), { once: true });
  });
  const timedOut = await requestJson('/api/mergen-rota/ai/probe', { method: 'POST' }, { timeoutMs: 5 });
  assert.equal(timedOut.code, 'REQUEST_TIMEOUT');
  assert.equal(aiFailureMessage(timedOut), 'Sunucudan süre sınırında yanıt alınamadı.');

  // Ağ hatası: istemcinin kendi, yönlendiren iletisi kullanılır.
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  assert.match(aiFailureMessage(await requestJson('/api/mergen-rota/ai/probe', { method: 'POST' })), /Bağlantınızı denetleyip/);

  // Gövdesiz hata yanıtı: genel yedek metin yerine katalog iletisi kullanılır.
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 'AI_BUSY' }), { status: 503 });
  const busy = await requestJson('/api/mergen-rota/ai/probe', { method: 'POST' });
  assert.equal(busy.message, 'İşlem tamamlanamadı.');
  assert.match(aiFailureMessage(busy), /şu anda yoğun/);

  // Sunucunun özgül iletisi korunur.
  globalThis.fetch = async () => Response.json({ error: { code: 'AI_KEY_MISSING', message: 'Özgül sunucu iletisi.' } }, { status: 409 });
  assert.equal(aiFailureMessage(await requestJson('/api/mergen-rota/ai/probe', { method: 'POST' })), 'Özgül sunucu iletisi.');
});

test('istemci süre sınırı sunucunun sıra ve istek sınırlarından uzundur', () => {
  const { probeTimeoutMs, validationTimeoutMs } = presentation;
  const status = statusFixture({ timeouts: { queueTimeoutMs: 1000, requestTimeoutMs: 4000 } });
  assert.ok(probeTimeoutMs(status) > 1000 + 4000);
  assert.ok(validationTimeoutMs(status) > 1000 + 4000);
  // Sunucu sınırları bilinmiyorsa varsayılanlar ve kayıt okuma bütçesi kullanılır.
  assert.ok(probeTimeoutMs(null) > 5000 + 20000 + 90000);
  assert.ok(validationTimeoutMs(statusFixture({ timeouts: { queueTimeoutMs: 20000, requestTimeoutMs: 600000 } })) < 600000);
  // Profilin daha uzun süre sınırı ve dosya kaydının okunması sunucu bütçesindedir.
  const longProfile = statusFixture({ probe: { available: true, reason: null, timeoutMs: 180000, budgetMs: 5000 + 20000 + 180000 } });
  assert.ok(probeTimeoutMs(longProfile) > 5000 + 20000 + 180000);
});

test('deneme isteği yalnızca kullanılabilir bir anahtar varken açılır; özet okunur biçimdedir', () => {
  const { canRunAiProbe, probeSummary } = presentation;
  assert.equal(canRunAiProbe(statusFixture()), true);
  assert.equal(canRunAiProbe(personalStatus()), true);
  assert.equal(canRunAiProbe(statusFixture({ effectiveSource: 'missing' })), false);
  assert.equal(canRunAiProbe(statusFixture({ available: false })), false);
  // `chat.fast` çözülemiyorsa ya da kişisel anahtar okunamıyorsa deneme kapalıdır.
  const profileOff = statusFixture({ probe: { available: false, reason: 'PROFILE_DISABLED', timeoutMs: 90000, budgetMs: 110000 } });
  assert.equal(canRunAiProbe(profileOff), false);
  assert.match(presentation.probeUnavailableMessage(profileOff), /profili bu kurulumda kapalı/);
  assert.equal(presentation.probeUnavailableMessage(statusFixture()), null);
  assert.equal(canRunAiProbe(personalStatus({ readable: false })), false);
  const summary = probeSummary({ credentialSource: 'personal', profile: 'chat.fast', model: 'hizli-model', durationMs: 1234, queueWaitMs: 0 });
  assert.equal(summary.source, 'Kişisel anahtar');
  assert.equal(summary.profile, 'Hızlı sohbet');
  assert.equal(summary.model, 'hizli-model');
  assert.equal(summary.duration, '1,2 sn');
  assert.equal(summary.queueWait, null);
  assert.equal(summary.configuredModel, null);
  // Ağ geçidi başka bir modele yönlendirdiyse yapılandırılan model ayrıca gösterilir.
  const rerouted = probeSummary({ model: 'yedek-model', configuredModel: 'hizli-model', durationMs: 10 });
  assert.deepEqual([rerouted.model, rerouted.configuredModel], ['yedek-model', 'hizli-model']);
  // Sağlayıcı modeli bildirmediyse yapılandırılan model "yanıtlayan" diye gösterilmez.
  const unreported = probeSummary({ model: null, configuredModel: 'hizli-model', durationMs: 10 });
  assert.deepEqual(
    [unreported.model, unreported.modelReported, unreported.configuredModel],
    ['Sağlayıcı bildirmedi', false, 'hizli-model']
  );
});

/* ── Kart davranışı ──────────────────────────────────────── */

test('Demo Kipinde hiçbir istek atılmaz ve anahtar yönetimi gösterilmez', async (t) => {
  withDataMode(t, 'demo');
  const server = stubAiServer(t);
  const view = mountComponent(AiAccessSettings, {});
  t.after(() => view.unmount());
  await settle(view);
  assert.equal(server.calls.length, 0);
  assert.match(textOf(view.output), /yalnızca Gerçek Sistem verisiyle yönetilir/);
  assert.equal(hasButton(view.output, 'Anahtar ekle'), false);
  assert.equal(hasButton(view.output, 'Deneme isteği gönder'), false);
});

test('kişisel anahtar yokken kurumsal anahtarın kullanılacağı ve aktarım kuralı açıkça yazılır', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: statusFixture() });
  const view = await mountActual(t);
  assert.deepEqual(server.calls.map((call) => `${call.method} ${call.path}`), ['GET /credential']);
  const text = textOf(view.output);
  assert.match(text, /Kurumsal anahtar/);
  assert.match(text, /Tanımlı değil\. İstekleriniz kurumsal varsayılan anahtarla yapılır\./);
  assert.match(text, /anahtar reddedilirse istek kurumsal anahtara aktarılmaz/);
  assert.match(text, /Kişisel anahtar yoksa kurumsal varsayılan anahtar kullanılır\./);
  assert.ok(hasButton(view.output, 'Anahtar ekle'));
  assert.equal(hasButton(view.output, 'Doğrula'), false, 'kurumsal anahtar kullanıcı tarafından doğrulanmaz');
  assert.equal(findButton(view.output, 'Deneme isteği gönder').props.disabled, false);
});

test('kayıtlı anahtar yalnızca son dört karakteriyle ve son doğrulamasıyla gösterilir', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: personalStatus({ lastValidationStatus: 'VALID', lastValidatedAt: '2026-09-21T09:15:00.000Z' }) });
  const view = await mountActual(t);
  const text = textOf(view.output);
  assert.match(text, /••••Vx9b/);
  assert.match(text, /Doğrulandı \(/);
  assert.match(text, /Kişisel anahtar/);
  for (const label of ['Doğrula', 'Değiştir', 'Kaldır']) assert.ok(hasButton(view.output, label), label);
  assert.equal(hasButton(view.output, 'Anahtar ekle'), false);
});

test('anahtar kaydı: alan parola türündedir, taslak kayıttan sonra silinir ve anahtar bir daha çizilmez', async (t) => {
  const storage = watchBrowserStorage(t);
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: statusFixture() });
  const view = await mountActual(t);

  findButton(view.output, 'Anahtar ekle').props.onClick();
  view.render();
  const input = keyInput(view.output);
  assert.equal(input.props.type, 'password');
  assert.equal(input.props.autoComplete, 'off');
  assert.equal(input.props.spellCheck, false);
  input.props.onChange({ target: { value: `  ${TYPED_KEY}  ` } });
  view.render();

  server.reply('PUT /credential', { ok: true, ai: personalStatus({ hint: 'Vx9b' }) });
  const beforeSave = view.frames.length;
  findButton(view.output, 'Kaydet').props.onClick();
  await settle(view);

  const put = server.calls.find((call) => call.method === 'PUT');
  assert.deepEqual(JSON.parse(put.body), { apiKey: TYPED_KEY }, 'baştaki/sondaki boşluk kırpılır');
  for (const call of server.calls) assert.equal(call.url.includes(TYPED_KEY), false, 'anahtar adrese yazılmaz');
  const afterSave = view.frames.slice(beforeSave);
  assert.ok(afterSave.length > 0);
  for (const frame of afterSave) {
    assert.equal(JSON.stringify(frame).includes(TYPED_KEY), false, 'anahtar kayıttan sonra çizilmez');
  }
  assert.equal(findElement(view.output, (node) => node.type === 'input'), null, 'form kapanır');
  const text = textOf(view.output);
  assert.match(text, /şifrelenerek kaydedildi/);
  assert.match(text, /••••Vx9b/);
  assert.deepEqual(storage, [], 'tarayıcı deposuna dokunulmaz');
});

test('biçim hatası istek atmadan gösterilir; Esc taslağı atar', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: statusFixture() });
  const view = await mountActual(t);
  findButton(view.output, 'Anahtar ekle').props.onClick();
  view.render();

  keyInput(view.output).props.onChange({ target: { value: 'kisa' } });
  view.render();
  keyInput(view.output).props.onKeyDown({ key: 'Enter', preventDefault() {} });
  await settle(view);
  assert.equal(server.calls.length, 1, 'yalnızca ilk durum isteği');
  const hint = findElement(view.output, (node) => node.props?.role === 'alert');
  assert.match(textOf(hint), /en az 16 karakter/);
  assert.equal(keyInput(view.output).props['aria-invalid'], 'true');

  keyInput(view.output).props.onChange({ target: { value: 'boşluk içeren anahtar değeri' } });
  view.render();
  findButton(view.output, 'Kaydet').props.onClick();
  await settle(view);
  assert.match(textOf(findElement(view.output, (node) => node.props?.role === 'alert')), /boşluk ya da görünmeyen karakter/);

  keyInput(view.output).props.onKeyDown({ key: 'Escape', preventDefault() {} });
  view.render();
  assert.equal(findElement(view.output, (node) => node.type === 'input'), null);
  assert.equal(server.calls.length, 1);
});

test('sunucunun reddettiği kayıt form içinde Türkçe iletiyle gösterilir', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: statusFixture() });
  const view = await mountActual(t);
  findButton(view.output, 'Anahtar ekle').props.onClick();
  view.render();
  keyInput(view.output).props.onChange({ target: { value: TYPED_KEY } });
  view.render();
  server.reply('PUT /credential', {
    error: { code: 'AI_CONFIGURATION_ERROR', message: 'Yapay zekâ yapılandırması eksik ya da hatalı. Sistem yöneticinize başvurun.', details: { reason: 'SCHEMA_MISSING' } }
  }, 503);
  findButton(view.output, 'Kaydet').props.onClick();
  await settle(view);
  assert.match(textOf(findElement(view.output, (node) => node.props?.role === 'alert')), /Sistem yöneticinize başvurun/);
  assert.ok(findElement(view.output, (node) => node.type === 'input'), 'form açık kalır');
  assert.match(textOf(view.output), /Kurumsal anahtar/, 'durum değişmez');
});

test('kaldırma onay ister; Vazgeç istek atmaz, onay kurumsal anahtara dönüşü bildirir', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: personalStatus() });
  const view = await mountActual(t);

  findButton(view.output, 'Kaldır').props.onClick();
  view.render();
  const confirm = findElement(view.output, (node) => node.props?.role === 'group');
  assert.equal(confirm.props['aria-label'], 'Kişisel anahtarı kaldırma onayı');
  assert.match(textOf(confirm), /kurumsal varsayılan anahtarla yapılır/);
  findButton(view.output, 'Vazgeç').props.onClick();
  view.render();
  assert.equal(findElement(view.output, (node) => node.props?.role === 'group'), null);
  assert.equal(server.calls.some((call) => call.method === 'DELETE'), false);

  findButton(view.output, 'Kaldır').props.onClick();
  view.render();
  server.reply('DELETE /credential', { ok: true, ai: statusFixture() });
  findButton(view.output, 'Anahtarı kaldır').props.onClick();
  await settle(view);
  assert.equal(server.calls.filter((call) => call.method === 'DELETE').length, 1);
  const text = textOf(view.output);
  assert.match(text, /Kişisel anahtar kaldırıldı\. Kaldırıldıktan sonra istekleriniz kurumsal varsayılan anahtarla yapılır\./);
  assert.ok(hasButton(view.output, 'Anahtar ekle'));
  assert.equal(text.includes('••••'), false);
});

test('doğrulama sonucu kalıcı özete ve bildirime yansır; hizmet hatası sonucu değiştirmez', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: personalStatus() });
  const view = await mountActual(t);

  server.reply('POST /credential/validation', {
    ok: true,
    validation: { status: 'REJECTED', stale: false, credential: { hint: 'Vx9b', updatedAt: '2026-09-20T08:30:00.000Z', lastValidatedAt: '2026-09-21T10:00:00.000Z', lastValidationStatus: 'REJECTED' } }
  });
  findButton(view.output, 'Doğrula').props.onClick();
  await settle(view);
  let text = textOf(view.output);
  assert.match(text, /Anahtar reddedildi\. Geçerli bir anahtarla değiştirin; istekler kurumsal anahtara aktarılmaz\./);
  assert.match(text, /Reddedildi \(/);

  server.reply('POST /credential/validation', {
    error: { code: 'AI_BUSY', message: 'Yapay zekâ hizmeti şu anda yoğun. Biraz sonra yeniden deneyin.', details: null }
  }, 503);
  findButton(view.output, 'Doğrula').props.onClick();
  await settle(view);
  text = textOf(view.output);
  assert.match(text, /şu anda yoğun/);
  assert.match(text, /Reddedildi \(/, 'erişilemeyen hizmet önceki kalıcı sonucu silmez');
});

test('deneme isteği süre sayar, İptal ile iptal edilir ve sunucu isteği de kesilir', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: statusFixture() });
  const view = await mountActual(t);

  const pending = server.defer('POST /probe');
  findButton(view.output, 'Deneme isteği gönder').props.onClick();
  view.render();
  assert.match(textOf(view.output), /Yanıt bekleniyor · 0 sn/);
  const probeCall = server.calls.find((call) => call.path === '/probe');
  assert.equal(probeCall.signal.aborted, false);

  findButton(view.output, 'İptal').props.onClick();
  await settle(view);
  assert.equal(probeCall.signal.aborted, true, 'tarayıcı isteği kesilir; sunucu request.signal ile sağlayıcıyı durdurur');
  assert.equal(probeText(view.output), 'İstek iptal edildi.');
  assert.ok(hasButton(view.output, 'Deneme isteği gönder'));
  pending.resolve({ ok: true, result: {} });
});

test('başarılı deneme anahtar kaynağını, profili, modeli ve süreyi gösterir', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: personalStatus() });
  const view = await mountActual(t);
  server.reply('POST /probe', {
    ok: true,
    result: { credentialSource: 'personal', profile: 'chat.fast', model: 'hizli-model', configuredModel: 'hizli-model', durationMs: 900, queueWaitMs: 1200, text: 'Merhaba.' }
  });
  findButton(view.output, 'Deneme isteği gönder').props.onClick();
  await settle(view);
  const text = probeText(view.output);
  assert.match(text, /Yanıt alındı · 0,9 sn/);
  assert.match(text, /Kişisel anahtar/);
  assert.match(text, /Hızlı sohbet/);
  assert.match(text, /hizli-model/);
  assert.match(text, /Sırada bekleme1,2 sn/);
  assert.match(text, /Merhaba\./);

  // Anahtar kaldırılınca eski sonuç (kişisel anahtar) artık geçerli değildir.
  findButton(view.output, 'Kaldır').props.onClick();
  view.render();
  server.reply('DELETE /credential', { ok: true, ai: statusFixture() });
  findButton(view.output, 'Anahtarı kaldır').props.onClick();
  await settle(view);
  assert.equal(probeText(view.output), '');
});

test('yerine yenisi başlatılan denemenin geç gelen sonucu uygulanmaz', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: statusFixture() });
  const view = await mountActual(t);

  // Çift tıklama: ikinci çağrı ilkini iptal eder. İlk isteğin yanıtı iptali
  // yok sayıp GEÇ gelse bile ekrana yansımamalıdır.
  const first = server.defer('POST /probe', { honorAbort: false });
  const second = server.defer('POST /probe');
  const start = findButton(view.output, 'Deneme isteği gönder').props.onClick;
  start();
  start();
  const [firstCall, secondCall] = server.calls.filter((call) => call.path === '/probe');
  assert.equal(firstCall.signal.aborted, true);
  assert.equal(secondCall.signal.aborted, false);

  second.resolve({ ok: true, result: { credentialSource: 'default', profile: 'chat.fast', model: 'ikinci-model', configuredModel: 'ikinci-model', durationMs: 400, text: 'İkinci.' } });
  await settle(view);
  assert.match(probeText(view.output), /ikinci-model/);

  first.resolve({ ok: true, result: { credentialSource: 'default', profile: 'chat.fast', model: 'ilk-model', configuredModel: 'ilk-model', durationMs: 900, text: 'İlk.' } });
  await settle(view);
  assert.match(probeText(view.output), /ikinci-model/);
  assert.equal(probeText(view.output).includes('ilk-model'), false);
});

test('hizmet hatası denemede Türkçe iletiyle gösterilir', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: personalStatus() });
  const view = await mountActual(t);
  server.reply('POST /probe', {
    error: { code: 'AI_RATE_LIMITED', message: 'Yapay zekâ hizmeti istek sınırına ulaştı.', details: { credentialSource: 'personal' } }
  }, 429);
  findButton(view.output, 'Deneme isteği gönder').props.onClick();
  await settle(view);
  assert.match(probeText(view.output), /istek sınırına ulaştı/);
  assert.ok(hasButton(view.output, 'Deneme isteği gönder'), 'yeniden denenebilir');
});

test('kullanılabilir anahtar yoksa deneme kapalıdır ve anahtar eklemek istenir', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: statusFixture({ defaultKeyConfigured: false, effectiveSource: 'missing' }) });
  const view = await mountActual(t);
  assert.equal(findButton(view.output, 'Deneme isteği gönder').props.disabled, true);
  const text = textOf(view.output);
  assert.match(text, /Anahtar gerekli/);
  assert.match(text, /kişisel anahtarınızı ekleyin/);
  assert.equal(text.includes('Kişisel anahtar yoksa kurumsal varsayılan anahtar kullanılır.'), false);
});

test('kapalı kurulum dürüstçe anlatılır ve anahtar yönetimi gösterilmez', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', {
    ok: true,
    ai: statusFixture({ enabled: false, available: false, personalKeysSupported: false, defaultKeyConfigured: false, effectiveSource: 'missing' })
  });
  const view = await mountActual(t);
  const text = textOf(view.output);
  assert.match(text, /bu kurulumda kapalı/);
  assert.match(text, /Kapalı/);
  assert.equal(hasButton(view.output, 'Anahtar ekle'), false);
  assert.equal(hasButton(view.output, 'Deneme isteği gönder'), false);
});

test('yapılandırılmamış kurulum yöneticiye yönlendirir', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: statusFixture({ available: false, personalKeysSupported: false, effectiveSource: 'missing' }) });
  const view = await mountActual(t);
  const text = textOf(view.output);
  assert.match(text, /henüz yapılandırılmadı/);
  assert.match(text, /Yapılandırılmadı/);
  assert.equal(hasButton(view.output, 'Anahtar ekle'), false);
  assert.equal(hasButton(view.output, 'Deneme isteği gönder'), false);
});

test('yükleme hatası yeniden denenebilir', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { error: { code: 'DATABASE_UNAVAILABLE', message: 'Veritabanına ulaşılamadı.', details: null } }, 503);
  const view = await mountActual(t);
  assert.match(textOf(findElement(view.output, (node) => node.props?.role === 'alert')), /Veritabanına ulaşılamadı\./);

  server.reply('GET /credential', { ok: true, ai: statusFixture() });
  findButton(view.output, 'Yeniden dene').props.onClick();
  await settle(view);
  assert.equal(findElement(view.output, (node) => node.props?.role === 'alert'), null);
  assert.match(textOf(view.output), /Kurumsal anahtar/);
});

test('kart kapanınca süren deneme isteği iptal edilir', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: statusFixture() });
  const view = await mountActual(t);
  server.defer('POST /probe');
  findButton(view.output, 'Deneme isteği gönder').props.onClick();
  view.render();
  const probeCall = server.calls.find((call) => call.path === '/probe');
  view.unmount();
  assert.equal(probeCall.signal.aborted, true);
  await drain();
});

/* ── Kip değişimi, bayat sonuçlar ve çakışan eylemler ───────── */

test('Demo Kipine geçince kart sıfırlanır; süren isteklerin geç sonucu uygulanmaz ve istek atılamaz', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: personalStatus() });
  const view = await mountActual(t);
  assert.ok(hasButton(view.output, 'Doğrula'));

  const probe = server.defer('POST /probe', { honorAbort: false });
  findButton(view.output, 'Deneme isteği gönder').props.onClick();
  const validation = server.defer('POST /credential/validation');
  findButton(view.output, 'Doğrula').props.onClick();
  view.render();
  const probeCall = server.calls.find((call) => call.path === '/probe');

  DataModeContext._currentValue = { dataMode: 'demo', async setDataMode() {} };
  view.render();
  await settle(view);
  let text = textOf(view.output);
  assert.match(text, /yalnızca Gerçek Sistem verisiyle yönetilir/);
  assert.equal(probeCall.signal.aborted, true, 'süren deneme kesilir');
  for (const label of ['Doğrula', 'Değiştir', 'Kaldır', 'Deneme isteği gönder']) assert.equal(hasButton(view.output, label), false, label);
  assert.equal(text.includes('••••'), false, 'gerçek anahtar künyesi gösterilmez');

  // Önceki kipte başlamış isteklerin geç gelen sonuçları kartı geri getirmez.
  probe.resolve({ ok: true, result: { credentialSource: 'personal', profile: 'chat.fast', model: 'gec-model', configuredModel: 'gec-model', durationMs: 5, text: 'Geç.' } });
  validation.resolve({ ok: true, validation: { status: 'VALID', stale: false, credential: { hint: 'Vx9b', lastValidationStatus: 'VALID' } } });
  await settle(view);
  text = textOf(view.output);
  assert.match(text, /yalnızca Gerçek Sistem verisiyle yönetilir/);
  assert.equal(text.includes('gec-model'), false);
  assert.equal(text.includes('kabul edildi'), false);
  const callsInDemo = server.calls.length;

  // Gerçek Sisteme dönünce durum yeniden okunur.
  server.reply('GET /credential', { ok: true, ai: statusFixture() });
  DataModeContext._currentValue = { dataMode: 'actual', async setDataMode() {} };
  view.render();
  await settle(view);
  assert.equal(server.calls.length, callsInDemo + 1);
  assert.match(textOf(view.output), /Kurumsal anahtar/);
});

test('Demo Kipine geçişten sonra gelen durum yanıtı kartı Gerçek Sistem görünümüne döndürmez', async (t) => {
  withDataMode(t, 'actual');
  const server = stubAiServer(t);
  const pending = server.defer('GET /credential');
  const view = mountComponent(AiAccessSettings, {});
  t.after(() => view.unmount());
  view.render();
  DataModeContext._currentValue = { dataMode: 'demo', async setDataMode() {} };
  view.render();
  pending.resolve({ ok: true, ai: personalStatus() });
  await settle(view);
  assert.match(textOf(view.output), /yalnızca Gerçek Sistem verisiyle yönetilir/);
  assert.equal(hasButton(view.output, 'Kaldır'), false);
});

test('anahtar değişince süren denemenin sonucu yeni anahtara yazılmaz', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: personalStatus() });
  const view = await mountActual(t);
  const probe = server.defer('POST /probe', { honorAbort: false });
  findButton(view.output, 'Deneme isteği gönder').props.onClick();
  view.render();
  const probeCall = server.calls.find((call) => call.path === '/probe');

  findButton(view.output, 'Değiştir').props.onClick();
  view.render();
  keyInput(view.output).props.onChange({ target: { value: TYPED_KEY } });
  view.render();
  server.reply('PUT /credential', { ok: true, ai: personalStatus({ hint: '7Qm2' }) });
  findButton(view.output, 'Kaydet').props.onClick();
  await settle(view);
  assert.equal(probeCall.signal.aborted, true, 'eski anahtarla süren deneme kesilir');
  assert.ok(hasButton(view.output, 'Deneme isteği gönder'), 'deneme yeniden başlatılabilir');

  probe.resolve({ ok: true, result: { credentialSource: 'personal', profile: 'chat.fast', model: 'eski-anahtar-modeli', configuredModel: 'eski-anahtar-modeli', durationMs: 5, text: 'Eski.' } });
  await settle(view);
  assert.equal(probeText(view.output), '', 'eski anahtarın geç sonucu gösterilmez');
});

test('kayıt sürerken Esc formu kapatmaz; hata aynı formda görünür', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: statusFixture() });
  const view = await mountActual(t);
  findButton(view.output, 'Anahtar ekle').props.onClick();
  view.render();
  keyInput(view.output).props.onChange({ target: { value: TYPED_KEY } });
  view.render();
  const pending = server.defer('PUT /credential');
  findButton(view.output, 'Kaydet').props.onClick();
  view.render();
  keyInput(view.output).props.onKeyDown({ key: 'Escape', preventDefault() {} });
  view.render();
  assert.ok(findElement(view.output, (node) => node.type === 'input'), 'form açık kalır');

  pending.resolve({ error: { code: 'AI_CONFIGURATION_ERROR', message: 'Anahtar tablosu kurulmamış.', details: null } }, 503);
  await settle(view);
  assert.match(textOf(findElement(view.output, (node) => node.props?.role === 'alert')), /Anahtar tablosu kurulmamış/);
  assert.equal(keyInput(view.output).props.value, TYPED_KEY, 'yazılan anahtar kaybolmaz');
});

test('düzenleme sürerken kaldırma açılamaz; yeni anahtar kaydedilince açık kaldırma onayı kapanır', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: personalStatus() });
  const view = await mountActual(t);

  findButton(view.output, 'Kaldır').props.onClick();
  view.render();
  assert.ok(findElement(view.output, (node) => node.props?.role === 'group'));
  findButton(view.output, 'Değiştir').props.onClick();
  view.render();
  assert.equal(findElement(view.output, (node) => node.props?.role === 'group'), null, 'düzenleme onayı kapatır');
  assert.equal(hasButton(view.output, 'Kaldır'), false, 'düzenlerken kaldırma sunulmaz');

  keyInput(view.output).props.onChange({ target: { value: TYPED_KEY } });
  view.render();
  server.reply('PUT /credential', { ok: true, ai: personalStatus({ hint: '7Qm2' }) });
  findButton(view.output, 'Kaydet').props.onClick();
  await settle(view);
  assert.equal(findElement(view.output, (node) => node.props?.role === 'group'), null);
  assert.equal(hasButton(view.output, 'Anahtarı kaldır'), false, 'yeni anahtarı eski onay silemez');
  assert.equal(server.calls.some((call) => call.method === 'DELETE'), false);
});

test('doğrulama sürerken değişen anahtarın sonucu uygulanmaz; güncel durum yeniden okunur', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: personalStatus() });
  const view = await mountActual(t);
  server.reply('POST /credential/validation', {
    ok: true,
    validation: { status: null, stale: true, credential: { hint: '7Qm2', lastValidationStatus: null, lastValidatedAt: null } }
  });
  server.reply('GET /credential', { ok: true, ai: personalStatus({ hint: '7Qm2' }) });
  findButton(view.output, 'Doğrula').props.onClick();
  await settle(view);
  const text = textOf(view.output);
  assert.match(text, /sonuç yeni anahtara uygulanmadı/);
  assert.equal(text.includes('Doğrulandı'), false);
  assert.match(text, /••••7Qm2/);
  assert.equal(server.calls.filter((call) => call.method === 'GET').length, 2);
});

test('başka oturumda değiştirilen anahtarın kaldırılması çakışma olarak gösterilir ve durum yenilenir', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: personalStatus() });
  const view = await mountActual(t);
  findButton(view.output, 'Kaldır').props.onClick();
  view.render();
  server.reply('DELETE /credential', {
    error: { code: 'CONFLICT', message: 'Kişisel anahtar bu arada başka bir oturumda değiştirildi; yeni anahtar kaldırılmadı.', details: null }
  }, 409);
  server.reply('GET /credential', { ok: true, ai: personalStatus({ hint: '7Qm2' }) });
  findButton(view.output, 'Anahtarı kaldır').props.onClick();
  await settle(view);
  const text = textOf(view.output);
  assert.match(text, /yeni anahtar kaldırılmadı/);
  assert.match(text, /••••7Qm2/);
});

test('okunamayan kayıtlı anahtar açıkça bildirilir; doğrulama ve deneme sunulmaz', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: personalStatus({ readable: false }) });
  const view = await mountActual(t);
  const text = textOf(view.output);
  assert.match(text, /okunamıyor/);
  assert.equal(hasButton(view.output, 'Doğrula'), false);
  assert.ok(hasButton(view.output, 'Değiştir'), 'yeniden kaydedilebilir');
  assert.equal(findButton(view.output, 'Deneme isteği gönder').props.disabled, true);
});

test('çözülemeyen `chat.fast` profili denemeyi nedeniyle birlikte kapatır; sunucu bütçesi süre sınırına yansır', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', {
    ok: true,
    ai: statusFixture({ probe: { available: false, reason: 'PROFILE_NOT_CONFIGURED', timeoutMs: 90000, budgetMs: 110000 } })
  });
  const view = await mountActual(t);
  assert.equal(findButton(view.output, 'Deneme isteği gönder').props.disabled, true);
  assert.match(textOf(view.output), /Hızlı sohbet profili bu kurulumda tanımlı değil/);
});

test('2xx ama beklenen biçimde olmayan yanıt kartı çökertmez ve başarı gibi gösterilmez', async (t) => {
  const client = await import('../src/features/ai/aiClient.js');
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  const html = () => new Response('<!doctype html><title>Vekil</title>', { status: 200, headers: { 'content-type': 'text/html' } });
  globalThis.fetch = async () => html();
  for (const request of [
    client.loadAiCredentialStatusRequest(),
    client.saveAiCredentialRequest(TYPED_KEY),
    client.removeAiCredentialRequest(),
    client.validateAiCredentialRequest(),
    client.runAiProbeRequest()
  ]) {
    const response = await request;
    assert.equal(response.ok, false);
    assert.equal(response.code, client.AI_INVALID_RESPONSE);
    assert.match(presentation.aiFailureMessage(response), /beklenmeyen bir yanıt/);
  }
  globalThis.fetch = previous;

  // Kart: bozuk durum yanıtı yeniden denenebilir yükleme hatasıdır.
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true });
  const view = await mountActual(t);
  assert.match(textOf(findElement(view.output, (node) => node.props?.role === 'alert')), /beklenmeyen bir yanıt/);
  server.reply('GET /credential', { ok: true, ai: statusFixture() });
  findButton(view.output, 'Yeniden dene').props.onClick();
  await settle(view);
  assert.match(textOf(view.output), /Kurumsal anahtar/);

  // Boş başarılı kayıt yanıtı "kaydedildi" diye gösterilmez. Sunucu 2xx
  // döndürdüğü için kayıt yapılmış olabilir: sonuç tahmin edilmez, güncel durum
  // okunur ve belirsizlik gerçek nedeniyle söylenir.
  findButton(view.output, 'Anahtar ekle').props.onClick();
  view.render();
  keyInput(view.output).props.onChange({ target: { value: TYPED_KEY } });
  view.render();
  server.reply('PUT /credential', { ok: true });
  server.reply('GET /credential', { ok: true, ai: personalStatus({ hint: TYPED_KEY.slice(-4) }) });
  findButton(view.output, 'Kaydet').props.onClick();
  await settle(view);
  const text = textOf(view.output);
  assert.doesNotMatch(text, /şifrelenerek kaydedildi/);
  assert.match(text, /Sunucudan beklenmeyen bir yanıt alındı\. Anahtarın kaydedilip kaydedilmediği doğrulanamadı; güncel durum yeniden yüklendi\./);
  assert.match(text, new RegExp(`••••${TYPED_KEY.slice(-4)}`), 'güncel durum gösterilir');
  assert.equal(server.calls.filter((call) => call.method === 'GET').length, 3);
});

/* ── İnceleme düzeltmeleri ─────────────────────────────────── */

test('özellik kapalıyken kaldırma onayı anahtar eklemeyi bir çıkış yolu olarak göstermez', () => {
  const { removalConsequence } = presentation;
  const disabled = personalStatus({}, { enabled: false, available: false, personalKeysSupported: false, defaultKeyConfigured: false, effectiveSource: 'missing' });
  const text = removalConsequence(disabled);
  assert.match(text, /kapalı/);
  assert.doesNotMatch(text, /yeni bir anahtar ekleyene kadar/);
});

test('dekoratif bilgi simgesi erişilebilirlik niteliklerini SVG’ye aktarır', async () => {
  const { Icons } = await import('../src/components/icons.jsx');
  const element = Icons.Info({ size: 12, 'aria-hidden': 'true' });
  const svg = element.type(element.props);
  assert.equal(svg.type, 'svg');
  assert.equal(svg.props['aria-hidden'], 'true');
  assert.equal(svg.props.width, 12);
});

test('eylemleri yöneten alanları eksik ya da tanınmayan başarılı yanıtlar başarı sayılmaz', async (t) => {
  const client = await import('../src/features/ai/aiClient.js');
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  const respond = (body) => { globalThis.fetch = async () => Response.json(body); };

  // Durum: etkin kaynak ya da deneme bilgisi olmadan sınama açılamaz; saklama
  // durumu alanları olmadan eksik göç bilinçli kapatmadan ayrılamaz.
  for (const ai of [
    { enabled: true, available: true, credential: {} },
    { ...statusFixture(), effectiveSource: undefined },
    { ...statusFixture(), probe: undefined },
    { ...statusFixture(), credential: { configured: true } },
    { ...statusFixture(), schemaReady: undefined },
    { ...statusFixture(), personalKeysConfigured: 'true' }
  ]) {
    respond({ ok: true, ai });
    assert.equal((await client.loadAiCredentialStatusRequest()).code, client.AI_INVALID_RESPONSE, JSON.stringify(ai));
  }
  assert.equal(presentation.canRunAiProbe({ ...statusFixture(), probe: undefined }), false, 'bilinmeyen deneme durumu kapalıdır');
  assert.equal(presentation.canRunAiProbe({ ...statusFixture(), effectiveSource: undefined }), false);

  // Doğrulama: yalnızca sunucunun üç kalıcı sonucu ya da açık bayat sonuç.
  // Bayat olmayan sonuç `stale: false` ve sonucun yazıldığı anahtarın künyesini
  // (aynı sonuç ve doğrulama zamanıyla) taşımalıdır.
  const written = { hint: 'Vx9b', lastValidatedAt: '2026-09-21T10:00:00.000Z', lastValidationStatus: 'FORBIDDEN' };
  for (const validation of [
    { status: 'UNKNOWN' },
    { status: 'VALID', credential: 'x' },
    { status: null },
    { status: 'FORBIDDEN', credential: written },
    { status: 'FORBIDDEN', stale: false, credential: null },
    { status: 'FORBIDDEN', stale: false, credential: {} },
    { status: 'VALID', stale: false, credential: written },
    { status: 'FORBIDDEN', stale: false, credential: { ...written, lastValidatedAt: null } },
    { status: null, stale: true, credential: { configured: true } }
  ]) {
    respond({ ok: true, validation });
    assert.equal((await client.validateAiCredentialRequest()).code, client.AI_INVALID_RESPONSE, JSON.stringify(validation));
  }
  respond({ ok: true, validation: { status: 'FORBIDDEN', stale: false, credential: written } });
  assert.equal((await client.validateAiCredentialRequest()).ok, true);
  for (const credential of [null, { hint: '7Qm2', lastValidatedAt: null, lastValidationStatus: null }]) {
    respond({ ok: true, validation: { status: null, stale: true, credential } });
    assert.equal((await client.validateAiCredentialRequest()).ok, true, 'bayat sonuç güncel künyeyi ya da boşluğu taşır');
  }

  // Deneme: kaynak, profil, yapılandırılan model, süre ve metin olmadan "Yanıt alındı" gösterilmez.
  const probeResult = { credentialSource: 'personal', profile: 'chat.fast', model: 'm', configuredModel: 'm', durationMs: 5, text: 'x' };
  for (const result of [
    {},
    { ...probeResult, text: undefined },
    { ...probeResult, credentialSource: 'missing' },
    { ...probeResult, configuredModel: undefined },
    { ...probeResult, model: '  ' }
  ]) {
    respond({ ok: true, result });
    assert.equal((await client.runAiProbeRequest()).code, client.AI_INVALID_RESPONSE, JSON.stringify(result));
  }
  // Yanıtlayan modeli bildirmeyen sağlayıcı geçerli bir sonuçtur; model `null` kalır.
  respond({ ok: true, result: { ...probeResult, model: null } });
  assert.equal((await client.runAiProbeRequest()).ok, true);
  globalThis.fetch = previous;

  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: statusFixture() });
  const view = await mountActual(t);
  server.reply('POST /probe', { ok: true, result: {} });
  findButton(view.output, 'Deneme isteği gönder').props.onClick();
  await settle(view);
  assert.doesNotMatch(probeText(view.output), /Yanıt alındı/);
  assert.match(probeText(view.output), /beklenmeyen bir yanıt/);
});

test('Strict Mode etkileri yeniden kurduğunda kart yüklemede takılmaz ve eylem sonuçları uygulanır', async (t) => {
  const server = stubAiServer(t);
  withDataMode(t, 'actual');
  server.reply('GET /credential', { ok: true, ai: statusFixture() });
  server.reply('GET /credential', { ok: true, ai: statusFixture() });
  const view = mountComponent(AiAccessSettings, {});
  t.after(() => view.unmount());
  view.remountEffects();
  await settle(view);
  assert.match(textOf(view.output), /Kurumsal anahtar/);
  server.reply('POST /probe', { ok: true, result: { credentialSource: 'default', profile: 'chat.fast', model: 'hizli-model', configuredModel: 'hizli-model', durationMs: 5, text: 'Merhaba.' } });
  findButton(view.output, 'Deneme isteği gönder').props.onClick();
  await settle(view);
  assert.match(probeText(view.output), /Yanıt alındı/);
});

test('istemci süreleri sunucunun rehber denetimi dâhil bütçesinden uzundur; anahtar işlemleri kendi süresini kullanır', async () => {
  const { probeTimeoutMs, validationTimeoutMs } = presentation;
  assert.equal(validationTimeoutMs(statusFixture({ timeouts: { queueTimeoutMs: 1000, requestTimeoutMs: 4000, validationBudgetMs: 10000 } })), 15000);
  assert.ok(validationTimeoutMs(statusFixture({ timeouts: { queueTimeoutMs: 1000, requestTimeoutMs: 4000 } })) >= 5000 + 1000 + 4000 + 5000,
    'sunucu bütçesi bilinmiyorsa kira öncesi rehber denetimi de hesaba katılır');
  assert.ok(probeTimeoutMs(null) >= 5000 + 5000 + 20000 + 90000 + 5000);
  const { AI_CREDENTIAL_REQUEST_TIMEOUT_MS } = await import('../src/features/ai/aiClient.js');
  const { AI_CREDENTIAL_OPERATION_TIMEOUT_MS } = await import('../src/domain/ai/aiCredentialPolicy.js');
  assert.ok(AI_CREDENTIAL_REQUEST_TIMEOUT_MS > AI_CREDENTIAL_OPERATION_TIMEOUT_MS, 'tarayıcı sunucudan önce vazgeçmez');
});

test('sonucu bilinmeyen kayıt ve kaldırma sonrasında güncel durum okunur ve belirsizlik söylenir', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: statusFixture() });
  const view = await mountActual(t);
  findButton(view.output, 'Anahtar ekle').props.onClick();
  view.render();
  keyInput(view.output).props.onChange({ target: { value: TYPED_KEY } });
  view.render();
  server.fail('PUT /credential');
  // Kayıt aslında sunucuda tamamlanmıştı: güncel durum yeni anahtarı gösterir.
  server.reply('GET /credential', { ok: true, ai: personalStatus({ hint: '7Qm2' }) });
  findButton(view.output, 'Kaydet').props.onClick();
  await settle(view);
  let text = textOf(view.output);
  assert.match(text, /kaydedilip kaydedilmediği doğrulanamadı; güncel durum yeniden yüklendi/);
  assert.match(text, /••••7Qm2/);
  assert.equal(server.calls.filter((call) => call.method === 'GET').length, 2);

  findButton(view.output, 'Vazgeç').props.onClick();
  view.render();
  findButton(view.output, 'Kaldır').props.onClick();
  view.render();
  server.fail('DELETE /credential');
  server.reply('GET /credential', { ok: true, ai: statusFixture() });
  findButton(view.output, 'Anahtarı kaldır').props.onClick();
  await settle(view);
  text = textOf(view.output);
  assert.match(text, /kaldırılıp kaldırılmadığı doğrulanamadı/);
  assert.equal(text.includes('••••'), false);
});

test('güncel anahtarın doğrulama sonucu önceki deneme sonucunun yerini alır', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: personalStatus() });
  const view = await mountActual(t);
  server.reply('POST /probe', { ok: true, result: { credentialSource: 'personal', profile: 'chat.fast', model: 'hizli-model', configuredModel: 'hizli-model', durationMs: 5, text: 'Merhaba.' } });
  findButton(view.output, 'Deneme isteği gönder').props.onClick();
  await settle(view);
  assert.match(probeText(view.output), /Yanıt alındı/);
  server.reply('POST /credential/validation', {
    ok: true,
    validation: { status: 'REJECTED', stale: false, credential: { hint: 'Vx9b', lastValidationStatus: 'REJECTED', lastValidatedAt: '2026-09-21T10:00:00.000Z' } }
  });
  findButton(view.output, 'Doğrula').props.onClick();
  await settle(view);
  assert.equal(probeText(view.output), '', 'reddedilen anahtar için eski "Yanıt alındı" sonucu kalmaz');
  assert.match(textOf(view.output), /Anahtar reddedildi/);
});

test('deneme sürerken canlı bölge yalnızca sabit metni duyurur; saniye sayacı okunmaz', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: statusFixture() });
  const view = await mountActual(t);
  server.defer('POST /probe');
  findButton(view.output, 'Deneme isteği gönder').props.onClick();
  view.render();
  const live = findElement(view.output, (node) => node.props?.role === 'status' && textOf(node).includes('Yanıt bekleniyor'));
  assert.equal(textOf(live), 'Yanıt bekleniyor');
  const counter = findElement(view.output, (node) => node.props?.['aria-hidden'] === 'true' && /sn$/.test(textOf(node)));
  assert.ok(counter, 'sayaç görünür ama yardımcı teknolojiden gizlidir');
  findButton(view.output, 'İptal').props.onClick();
  await settle(view);
});

test('Demo Kipine geçiş süren kayıt, kaldırma ve doğrulama isteklerini keser', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: personalStatus() });
  const view = await mountActual(t);
  server.defer('POST /credential/validation');
  findButton(view.output, 'Doğrula').props.onClick();
  view.render();
  const validationCall = server.calls.find((call) => call.path === '/credential/validation');

  DataModeContext._currentValue = { dataMode: 'demo', async setDataMode() {} };
  view.render();
  await settle(view);
  assert.equal(validationCall.signal.aborted, true, 'doğrulama isteği kesilir; sunucu sağlayıcı çağrısını durdurur');

  // Gerçek Sisteme dönüp kayıt ve kaldırmayı başlatır, sonra yeniden Demo'ya geçer.
  server.reply('GET /credential', { ok: true, ai: personalStatus() });
  DataModeContext._currentValue = { dataMode: 'actual', async setDataMode() {} };
  view.render();
  await settle(view);
  findButton(view.output, 'Değiştir').props.onClick();
  view.render();
  keyInput(view.output).props.onChange({ target: { value: TYPED_KEY } });
  view.render();
  server.defer('PUT /credential');
  findButton(view.output, 'Kaydet').props.onClick();
  view.render();
  const saveCall = server.calls.find((call) => call.method === 'PUT');
  DataModeContext._currentValue = { dataMode: 'demo', async setDataMode() {} };
  view.render();
  await settle(view);
  assert.equal(saveCall.signal.aborted, true, 'kayıt isteği kesilir; sunucu iptal edilen kaydı geri alır');

  server.reply('GET /credential', { ok: true, ai: personalStatus() });
  DataModeContext._currentValue = { dataMode: 'actual', async setDataMode() {} };
  view.render();
  await settle(view);
  findButton(view.output, 'Kaldır').props.onClick();
  view.render();
  server.defer('DELETE /credential');
  findButton(view.output, 'Anahtarı kaldır').props.onClick();
  view.render();
  const deleteCall = server.calls.find((call) => call.method === 'DELETE');
  DataModeContext._currentValue = { dataMode: 'demo', async setDataMode() {} };
  view.render();
  await settle(view);
  assert.equal(deleteCall.signal.aborted, true, 'kaldırma isteği kesilir');
  assert.match(textOf(view.output), /yalnızca Gerçek Sistem verisiyle yönetilir/);
});

test('satır içi denetimler kapanınca odak onları açan düğmeye döner', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: personalStatus() });
  const view = await mountActual(t);
  const focused = [];
  const attach = (label, name) => {
    const button = findButton(view.output, label);
    button.ref.current = { focus: () => focused.push(name) };
  };
  attach('Değiştir', 'edit');
  attach('Kaldır', 'remove');

  findButton(view.output, 'Değiştir').props.onClick();
  view.render();
  keyInput(view.output).props.onKeyDown({ key: 'Escape', preventDefault() {} });
  view.render();
  assert.deepEqual(focused, ['edit'], 'Esc ile kapanan form odağı Değiştir düğmesine bırakır');

  findButton(view.output, 'Kaldır').props.onClick();
  view.render();
  findButton(view.output, 'Vazgeç').props.onClick();
  view.render();
  assert.deepEqual(focused, ['edit', 'remove'], 'vazgeçilen kaldırma onayı odağı Kaldır düğmesine bırakır');

  findButton(view.output, 'Değiştir').props.onClick();
  view.render();
  keyInput(view.output).props.onChange({ target: { value: TYPED_KEY } });
  view.render();
  server.reply('PUT /credential', { ok: true, ai: personalStatus({ hint: '7Qm2' }) });
  findButton(view.output, 'Kaydet').props.onClick();
  await settle(view);
  assert.deepEqual(focused, ['edit', 'remove', 'edit'], 'kayıttan sonra odak Değiştir düğmesine döner');
});

test('yeni anahtar taslağı yazılırken kayıtlı anahtarın doğrulaması sunulmaz', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: personalStatus() });
  const view = await mountActual(t);
  assert.ok(hasButton(view.output, 'Doğrula'));
  findButton(view.output, 'Değiştir').props.onClick();
  view.render();
  assert.equal(hasButton(view.output, 'Doğrula'), false, 'taslağın doğrulandığı sanılmaz');
  keyInput(view.output).props.onKeyDown({ key: 'Escape', preventDefault() {} });
  view.render();
  assert.ok(hasButton(view.output, 'Doğrula'));
});

test('Performans · yapay zekâ yükü süreç başına ortalama olarak ve örnek sayısıyla anlatılır', async () => {
  const { aiLoadDescription, gaugeInstanceCount } = await import('../src/features/system-admin/tabs/SystemPerformanceTab.jsx');
  const gauges = {
    'ai.active_requests': [{ bucketStart: '2026-09-25T09:00:00.000Z', value: 8, instanceCount: 1 }, { bucketStart: '2026-09-25T09:05:00.000Z', value: 8, instanceCount: 2 }],
    'ai.queued_requests': [{ bucketStart: '2026-09-25T09:00:00.000Z', value: 0 }]
  };
  assert.equal(gaugeInstanceCount(gauges, ['ai.active_requests', 'ai.queued_requests']), 2);
  assert.equal(gaugeInstanceCount({}, ['ai.active_requests']), 1);
  assert.match(aiLoadDescription(1), /süreç\) başına zaman ağırlıklı ortalamadır; kapasite sınırları da süreç başınadır/);
  // Örnek sayısı bilgi olarak verilir; "örnek sayısı × ortalama" toplam yük diye sunulmaz.
  assert.match(aiLoadDescription(2), /2 uygulama örneği ölçüm yazdı; örnekler aynı sürede çalışmamış olabileceği için toplam yük bu değerden türetilemez/);
  assert.doesNotMatch(aiLoadDescription(2), /katıdır/);
});

test('model kaydı kullanılamıyorsa kurumsal anahtarla isteklerin çalışacağı vaat edilmez', () => {
  const { missingKeyDescription, removalConsequence, storedKeyNotice } = presentation;
  const blocked = statusFixture({ probe: { available: false, reason: 'MODEL_REGISTRY_INVALID', timeoutMs: 90000, budgetMs: 120000 } });
  assert.doesNotMatch(missingKeyDescription(blocked), /İstekleriniz kurumsal varsayılan anahtarla yapılır/);
  assert.match(missingKeyDescription(blocked), /Kurumsal varsayılan anahtar seçilir; ancak yapay zekâ yapılandırması/);
  assert.doesNotMatch(removalConsequence(blocked), /istekleriniz kurumsal varsayılan anahtarla yapılır/);
  assert.match(removalConsequence(blocked), /şu anda kullanılamıyor/);
  const disabledKey = personalStatus({ readable: false, unreadableReason: 'PERSONAL_KEYS_DISABLED' }, {
    personalKeysSupported: false, effectiveSource: 'default', probe: blocked.probe
  });
  assert.doesNotMatch(storedKeyNotice(disabledKey), /istekler kurumsal anahtarla yapılır/);
  // Kullanılabilir kurulumda vaat korunur.
  assert.match(missingKeyDescription(statusFixture()), /İstekleriniz kurumsal varsayılan anahtarla yapılır/);
});

test('kaldırma çakışmasında yeni anahtar gösterilirken eski anahtarın deneme sonucu kaldırılır', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: personalStatus() });
  const view = await mountActual(t);
  server.reply('POST /probe', { ok: true, result: { credentialSource: 'personal', profile: 'chat.fast', model: 'hizli-model', configuredModel: 'hizli-model', durationMs: 5, text: 'Merhaba.' } });
  findButton(view.output, 'Deneme isteği gönder').props.onClick();
  await settle(view);
  assert.match(probeText(view.output), /Yanıt alındı/);
  findButton(view.output, 'Kaldır').props.onClick();
  view.render();
  server.reply('DELETE /credential', {
    error: { code: 'CONFLICT', message: 'Kişisel anahtar bu arada başka bir oturumda değiştirildi; yeni anahtar kaldırılmadı.', details: null }
  }, 409);
  server.reply('GET /credential', { ok: true, ai: personalStatus({ hint: '7Qm2' }) });
  findButton(view.output, 'Anahtarı kaldır').props.onClick();
  await settle(view);
  assert.match(textOf(view.output), /••••7Qm2/);
  assert.equal(probeText(view.output), '', 'değiştirilen anahtarın deneme sonucu gösterilmez');
});

test('eksik 0016 tablosu bilinçli kapatılmış kişisel anahtar gibi anlatılmaz', () => {
  const { missingKeyDescription } = presentation;
  const schemaMissing = statusFixture({ personalKeysSupported: false, personalKeysConfigured: true, schemaReady: false });
  assert.match(missingKeyDescription(schemaMissing), /veritabanı göçü 0016 eksik/);
  assert.match(missingKeyDescription(schemaMissing), /İstekler şimdilik kurumsal anahtarla yapılır/);
  assert.doesNotMatch(missingKeyDescription(schemaMissing), /bu kurulumda etkin değil/);
  const disabled = statusFixture({ personalKeysSupported: false, personalKeysConfigured: false, schemaReady: true });
  assert.match(missingKeyDescription(disabled), /bu kurulumda etkin değil/);
});

/* ── İnceleme düzeltmeleri: belirsiz işlemler, iptal ve yanıt biçimi ── */

async function beginSave(view, server) {
  findButton(view.output, 'Anahtar ekle').props.onClick();
  view.render();
  keyInput(view.output).props.onChange({ target: { value: TYPED_KEY } });
  view.render();
  return server;
}

test('belirsiz işlemden sonraki durum okuması da başarısızsa kart "yüklendi" demez; durum çözülmemiş gösterilir', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: personalStatus() });
  const view = await mountActual(t);
  findButton(view.output, 'Kaldır').props.onClick();
  view.render();
  server.fail('DELETE /credential');
  server.fail('GET /credential');
  findButton(view.output, 'Anahtarı kaldır').props.onClick();
  await settle(view);
  const alert = findElement(view.output, (node) => node.props?.role === 'alert');
  assert.ok(alert, 'çözülmemiş durum açıkça gösterilir');
  assert.match(textOf(alert), /Sunucuyla bağlantı kesildi\. Anahtarın kaldırılıp kaldırılmadığı doğrulanamadı ve güncel durum da okunamadı/);
  const text = textOf(view.output);
  assert.doesNotMatch(text, /yeniden yüklendi/);
  assert.equal(text.includes('••••Vx9b'), false, 'eski anahtar künyesi güncelmiş gibi gösterilmez');
  // Yeniden deneme güncel durumu okur.
  server.reply('GET /credential', { ok: true, ai: statusFixture() });
  findButton(view.output, 'Yeniden dene').props.onClick();
  await settle(view);
  assert.match(textOf(view.output), /Kurumsal anahtar/);
});

test('belirsizlik bildirimi gerçek nedeni söyler: ağ kesintisi süre aşımı gibi anlatılmaz', () => {
  const { ambiguousMutationNotice, isAmbiguousMutation } = presentation;
  assert.match(ambiguousMutationNotice('save', { code: 'NETWORK' }).text, /^Sunucuyla bağlantı kesildi\./);
  assert.match(ambiguousMutationNotice('save', { code: 'REQUEST_TIMEOUT' }).text, /^Sunucudan süre sınırında yanıt alınamadı\./);
  assert.match(ambiguousMutationNotice('remove', { code: 'INVALID_RESPONSE' }).text, /^Sunucudan beklenmeyen bir yanıt alındı\. Anahtarın kaldırılıp/);
  const serverTimeout = { ok: false, code: 'DATABASE_UNAVAILABLE', error: { code: 'DATABASE_UNAVAILABLE', details: { reason: 'CREDENTIAL_OPERATION_TIMEOUT' } } };
  assert.equal(isAmbiguousMutation(serverTimeout), true, 'sunucunun kendi süre sınırı da sonucu belirsiz bırakır');
  assert.match(ambiguousMutationNotice('save', serverTimeout).text, /^Anahtar işlemi sunucunun süre sınırında tamamlanamadı\./);
  // Başka bir veritabanı hatası belirsiz sayılmaz (işlem yapılmadı).
  assert.equal(isAmbiguousMutation({ code: 'DATABASE_UNAVAILABLE', error: { details: { reason: 'OTHER' } } }), false);
  assert.equal(isAmbiguousMutation({ code: 'CONFLICT' }), false);
});

test('sunucunun anahtar işlemi süre sınırı dolunca kayıt sonrasında güncel durum okunur', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: statusFixture() });
  const view = await mountActual(t);
  await beginSave(view, server);
  server.reply('PUT /credential', {
    error: { code: 'DATABASE_UNAVAILABLE', message: 'Anahtar işlemi süre sınırında tamamlanamadı.', details: { reason: 'CREDENTIAL_OPERATION_TIMEOUT' } }
  }, 503);
  server.reply('GET /credential', { ok: true, ai: personalStatus({ hint: TYPED_KEY.slice(-4) }) });
  findButton(view.output, 'Kaydet').props.onClick();
  await settle(view);
  const text = textOf(view.output);
  assert.match(text, /Anahtar işlemi sunucunun süre sınırında tamamlanamadı\. Anahtarın kaydedilip kaydedilmediği doğrulanamadı; güncel durum yeniden yüklendi/);
  assert.match(text, new RegExp(`••••${TYPED_KEY.slice(-4)}`));
});

test('belirsiz işlemden sonraki durum okuması sürerken yeni işlem başlatılamaz', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: personalStatus() });
  const view = await mountActual(t);
  findButton(view.output, 'Değiştir').props.onClick();
  view.render();
  keyInput(view.output).props.onChange({ target: { value: TYPED_KEY } });
  view.render();
  server.fail('PUT /credential');
  const reconcile = server.defer('GET /credential');
  findButton(view.output, 'Kaydet').props.onClick();
  await settle(view);
  // Okuma sürüyor: kayıt yeniden gönderilemez ve form kapatılamaz; eski okuma
  // daha yeni bir işlemin sonucunu ezemez.
  assert.equal(findButton(view.output, 'Kaydet').props.disabled, true);
  assert.equal(findButton(view.output, 'Vazgeç').props.disabled, true);
  reconcile.resolve({ ok: true, ai: personalStatus({ hint: TYPED_KEY.slice(-4) }) });
  await settle(view);
  assert.equal(findButton(view.output, 'Kaydet').props.disabled, false);
  assert.equal(findButton(view.output, 'Vazgeç').props.disabled, false);
  assert.match(textOf(view.output), new RegExp(`••••${TYPED_KEY.slice(-4)}`));
});

test('kart kapanınca süren kayıt ve kaldırma istekleri de kesilir', async (t) => {
  for (const action of ['save', 'remove']) {
    const server = stubAiServer(t);
    withDataMode(t, 'actual');
    server.reply('GET /credential', { ok: true, ai: personalStatus() });
    const view = mountComponent(AiAccessSettings, {});
    await settle(view);
    if (action === 'save') {
      findButton(view.output, 'Değiştir').props.onClick();
      view.render();
      keyInput(view.output).props.onChange({ target: { value: TYPED_KEY } });
      view.render();
      server.defer('PUT /credential');
      findButton(view.output, 'Kaydet').props.onClick();
    } else {
      findButton(view.output, 'Kaldır').props.onClick();
      view.render();
      server.defer('DELETE /credential');
      findButton(view.output, 'Anahtarı kaldır').props.onClick();
    }
    view.render();
    const call = server.calls.find((entry) => entry.method === (action === 'save' ? 'PUT' : 'DELETE'));
    assert.equal(call.signal.aborted, false);
    view.unmount();
    assert.equal(call.signal.aborted, true, `${action}: sayfadan ayrılınca istek kesilir; sunucu commit'ten önce geri alır`);
    await drain();
  }
});

test('Demo Kipine geçiş ve kartın kapanması süren durum okumasını da keser', async (t) => {
  withDataMode(t, 'actual');
  const server = stubAiServer(t);
  server.defer('GET /credential');
  const view = mountComponent(AiAccessSettings, {});
  t.after(() => view.unmount());
  view.render();
  const first = server.calls.find((call) => call.method === 'GET');
  DataModeContext._currentValue = { dataMode: 'demo', async setDataMode() {} };
  view.render();
  await settle(view);
  assert.equal(first.signal.aborted, true, 'Demo Kipine geçince gerçek durum okuması sürmez');

  server.defer('GET /credential');
  DataModeContext._currentValue = { dataMode: 'actual', async setDataMode() {} };
  view.render();
  await settle(view);
  const second = server.calls.filter((call) => call.method === 'GET').at(-1);
  assert.notEqual(second, first);
  view.unmount();
  assert.equal(second.signal.aborted, true, 'kart kapanınca durum okuması kesilir');
  await drain();
});

test('doğrulama sırasında değişen anahtarın bildirimi durum yenilenirken ve sonrasında görünür kalır', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: personalStatus() });
  const view = await mountActual(t);
  server.reply('POST /credential/validation', {
    ok: true,
    validation: { status: null, stale: true, credential: { hint: '7Qm2', lastValidationStatus: null, lastValidatedAt: null } }
  });
  const reconcile = server.defer('GET /credential');
  findButton(view.output, 'Doğrula').props.onClick();
  await settle(view);
  // Kart yükleme ekranına düşmez: anahtar paneli yerinde kalır.
  assert.doesNotMatch(textOf(view.output), /yükleniyor/);
  assert.ok(hasButton(view.output, 'Doğrula'));
  reconcile.resolve({ ok: true, ai: personalStatus({ hint: '7Qm2' }) });
  await settle(view);
  const text = textOf(view.output);
  assert.match(text, /Anahtar doğrulama sırasında değiştirildi; sonuç yeni anahtara uygulanmadı/);
  assert.match(text, /••••7Qm2/);
});

test('kaldırma çakışmasının bildirimi durum yenilendikten sonra da görünür kalır', async (t) => {
  const server = stubAiServer(t);
  server.reply('GET /credential', { ok: true, ai: personalStatus() });
  const view = await mountActual(t);
  findButton(view.output, 'Kaldır').props.onClick();
  view.render();
  server.reply('DELETE /credential', {
    error: { code: 'CONFLICT', message: 'Bu arada başka bir oturumda yeni bir kişisel anahtar kaydedildi; yeni anahtar kaldırılmadı.', details: null }
  }, 409);
  server.reply('GET /credential', { ok: true, ai: personalStatus({ hint: '7Qm2' }) });
  findButton(view.output, 'Anahtarı kaldır').props.onClick();
  await settle(view);
  const text = textOf(view.output);
  assert.match(text, /yeni anahtar kaldırılmadı/);
  assert.match(text, /••••7Qm2/);
});

test('okunamayan kayıt nedeni doğru açıklanır: bozuk şifreli kayıt ana anahtar değişimi gibi anlatılmaz', () => {
  const { storedKeyNotice } = presentation;
  assert.match(storedKeyNotice(personalStatus({ readable: false, unreadableReason: 'RECORD_INVALID' })), /şifreli kayıt doğrulanamadı/);
  assert.match(storedKeyNotice(personalStatus({ readable: false, unreadableReason: 'MASTER_KEY_CHANGED' })), /şifreleme anahtarı değişti/);
  // Özellik kapalıyken okunabilirlik sınanmaz; uyarı gösterilmez.
  assert.equal(storedKeyNotice(personalStatus({ readable: false, unreadableReason: 'AI_DISABLED' }, { enabled: false, available: false })), null);
});

test('süren deneme, ondan sonra gelen reddedildi/yetersiz doğrulama sonucunu çürütemez', async (t) => {
  for (const status of ['REJECTED', 'FORBIDDEN']) {
    const server = stubAiServer(t);
    withDataMode(t, 'actual');
    server.reply('GET /credential', { ok: true, ai: personalStatus() });
    const view = mountComponent(AiAccessSettings, {});
    await settle(view);
    const probe = server.defer('POST /probe', { honorAbort: false });
    findButton(view.output, 'Deneme isteği gönder').props.onClick();
    view.render();
    const probeCall = server.calls.find((call) => call.path === '/probe');
    server.reply('POST /credential/validation', {
      ok: true,
      validation: { status, stale: false, credential: { hint: 'Vx9b', lastValidationStatus: status, lastValidatedAt: '2026-09-21T10:00:00.000Z' } }
    });
    findButton(view.output, 'Doğrula').props.onClick();
    await settle(view);
    assert.equal(probeCall.signal.aborted, true, `${status}: daha eski deneme kesilir`);
    // Eski deneme yine de yanıt verse bile uygulanmaz.
    probe.resolve({ ok: true, result: { credentialSource: 'personal', profile: 'chat.fast', model: 'hizli-model', configuredModel: 'hizli-model', durationMs: 5, text: 'Merhaba.' } });
    await settle(view);
    assert.equal(probeText(view.output).includes('Yanıt alındı'), false, status);
    assert.ok(hasButton(view.output, 'Deneme isteği gönder'));
    view.unmount();
    await drain();
  }
});
