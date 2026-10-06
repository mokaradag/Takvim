/**
 * Rota AI · kapalıyken görünmezlik.
 *
 * MERGEN_ROTA_AI_ENABLED açık değilse sayfa bunu her istekte bildirir; kabuk
 * başlatıcıyı, paneli ve komut paletindeki girdiyi göstermez ve hiçbir istek
 * göndermez.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { setImmediate as immediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'next/dist/build/swc/index.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { mountComponent } from './helpers/clientComponentHarness.mjs';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

registerServerOnlyShim();

// Kök yerleşim gerçek kodudur; yalnızca stil dosyaları boş modüle çözülür.
const LAYOUT = new URL('../src/app/layout.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === LAYOUT && specifier.endsWith('.css')) return { url: 'data:text/javascript,export default {};', shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url !== LAYOUT) return nextLoad(url, context);
    const filename = fileURLToPath(url);
    const source = transformSync(readFileSync(filename, 'utf8'), {
      filename,
      jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'automatic' } }, target: 'es2022' },
      module: { type: 'es6' }
    }).code;
    return { format: 'module', source, shortCircuit: true };
  }
});

const layout = await import(LAYOUT);
const { useRotaAssistant, RotaAssistantLauncher, RotaAssistantPanel } = await import('../src/features/ai/assistant/RotaAssistant.jsx');
const { assistantEnabledInDocument } = await import('../src/features/ai/assistant/assistantInteraction.js');
const { ASSISTANT_AVAILABILITY_META } = await import('../src/domain/ai/assistantContract.js');
const { readRuntimeFeatures, RUNTIME_FEATURES_COOKIE } = await import('../src/lib/runtimeFeatures.js');
const { middleware } = await import('../src/middleware.js');
const { NextRequest } = await import('next/server.js');
const { DataModeContext } = await import('../src/components/shell/DataModeContext.jsx');

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

function withEnv(t, name, value) {
  const previous = process.env[name];
  if (value == null) delete process.env[name];
  else process.env[name] = value;
  t.after(() => { if (previous == null) delete process.env[name]; else process.env[name] = previous; });
}

function withDocument(t, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value, configurable: true, writable: true });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document; });
}

const documentWith = (content) => ({
  querySelector: (selector) => (content != null && selector === `meta[name="${ASSISTANT_AVAILABILITY_META}"]`
    ? { getAttribute: (name) => (name === 'content' ? content : null) } : null)
});

const runtime = await import('../src/app/runtime.js/route.js');

test('runtime availability changes without a global probe, dynamic page rendering or AI initialization', async (t) => {
  assert.equal(layout.dynamic, undefined);
  assert.doesNotMatch(read('src/app/layout.js'), /readAiConfig|server\/ai|assistant\.css/);
  const html = renderToStaticMarkup(layout.default({ children: 'Rota' }));
  assert.doesNotMatch(html, /runtime\.js|assistant\.(?:js|css)/);
  assert.doesNotMatch(read('src/middleware.js'), /server\/ai|readAiConfig|sql|fetch\(/);
  assert.match(read('src/components/shell/AppShell.jsx'), /enabled: assistantEnabledInDocument\(\)/);
  for (const [value, expected] of [['false', false], [null, false], ['tru', false], ['true', true], ['0', false]]) {
    withEnv(t, 'MERGEN_ROTA_AI_ENABLED', value);
    const flag = middleware(new NextRequest('https://rota.example.test/'));
    assert.equal(flag.cookies.get(RUNTIME_FEATURES_COOKIE)?.value, expected ? 'enabled' : 'disabled');
    assert.equal(flag.cookies.get(RUNTIME_FEATURES_COOKIE)?.secure, true);
    assert.equal(flag.headers.get('x-middleware-next'), '1');
    const response = runtime.GET();
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await response.text(), `globalThis.__MERGEN_ROTA_FEATURES__=Object.freeze({assistant:${expected}});`);
  }
  withEnv(t, 'MERGEN_ROTA_AI_DEFAULT_API_KEY', 'sk-test-0123456789abcdef');
  withEnv(t, 'MERGEN_ROTA_AI_BASE_URL', 'https://ai.example.test/v1');
  const body = await runtime.GET().text();
  for (const secret of ['sk-test-0123456789abcdef', 'ai.example.test']) assert.equal(body.includes(secret), false);
});

test('the document response supplies the public flag without requests and excludes APIs and assets', (t) => {
  withEnv(t, 'MERGEN_ROTA_AI_ENABLED', 'true');
  const flag = middleware(new NextRequest('http://rota.example.test/'));
  const cookie = flag.cookies.get(RUNTIME_FEATURES_COOKIE);
  assert.equal(cookie.path, '/');
  assert.equal(cookie.httpOnly, undefined);
  assert.equal(cookie.secure, false);
  for (const pathname of ['/api/mergen-rota/snapshot', '/_next/static/chunks/page.js', '/runtime.js', '/auth/callback']) {
    assert.equal(middleware(new NextRequest(`http://rota.example.test${pathname}`)).headers.get('set-cookie'), null);
  }
  for (const [value, enabled] of [['enabled', true], ['disabled', false]]) {
    const doc = { ...documentWith(enabled ? 'disabled' : 'enabled'), cookie: `other=x; ${RUNTIME_FEATURES_COOKIE}=${value}` };
    assert.deepEqual(readRuntimeFeatures(doc), { assistant: enabled });
    assert.equal(assistantEnabledInDocument(doc), enabled);
  }
  for (const cookie of ['', `${RUNTIME_FEATURES_COOKIE}=true`, `other-${RUNTIME_FEATURES_COOKIE}=enabled`]) {
    assert.equal(readRuntimeFeatures({ cookie }), null);
  }
});

test('a disabled response flag prevents assistant activation without legacy metadata or a runtime request', async (t) => {
  withDocument(t, { cookie: `${RUNTIME_FEATURES_COOKIE}=disabled` });
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(url); throw new Error('unexpected fetch'); };
  t.after(() => { globalThis.fetch = previous; });
  const probe = mountComponent(() => useRotaAssistant(), {});
  probe.output.openPanel();
  probe.render();
  await immediate();
  assert.equal(probe.output.enabled, false);
  assert.equal(probe.output.open, false);
  assert.deepEqual(calls, []);
  probe.unmount();
});

test('the flag works through proxy-stripped and direct prefixed roots without sharing another deployment cookie', () => {
  for (const prefix of ['/rota', '/bilge', '/apps/rota']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { NextRequest } from 'next/server.js';
      import { middleware } from './src/middleware.js';
      import { RUNTIME_FEATURES_COOKIE, readRuntimeFeatures } from './src/lib/runtimeFeatures.js';
      const prefix = process.env.NEXT_PUBLIC_MERGEN_ROTA_PUBLIC_BASE_PATH;
      assert.equal(RUNTIME_FEATURES_COOKIE, 'mergen-rota-ai' + encodeURIComponent(prefix));
      for (const path of ['/', prefix, prefix + '/']) {
        const response = middleware(new NextRequest('http://rota.example.test' + path));
        const cookie = response.cookies.get(RUNTIME_FEATURES_COOKIE);
        assert.equal(cookie.value, 'enabled');
        assert.deepEqual(readRuntimeFeatures({ cookie: 'mergen-rota-ai=disabled; ' + cookie.name + '=' + cookie.value }), { assistant: true });
      }
      assert.equal(middleware(new NextRequest('http://rota.example.test' + prefix + '/api/mergen-rota/snapshot')).headers.get('set-cookie'), null);
    `], { cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...process.env, NEXT_PUBLIC_MERGEN_ROTA_PUBLIC_BASE_PATH: prefix, MERGEN_ROTA_AI_ENABLED: 'true' }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
});

test('the document flag hides the assistant only when the server says disabled', () => {
  assert.equal(assistantEnabledInDocument(documentWith('disabled')), false);
  assert.equal(assistantEnabledInDocument(documentWith('enabled')), true);
  assert.equal(assistantEnabledInDocument(documentWith(null)), true);
  assert.equal(assistantEnabledInDocument({}), true);
});

test('runtime availability controls the lazily loaded assistant independently of legacy metadata', () => {
  assert.equal(assistantEnabledInDocument(documentWith('disabled'), { assistant: true }), true);
  assert.equal(assistantEnabledInDocument(documentWith('enabled'), { assistant: false }), false);
});

test('with Rota AI disabled the launcher and panel render nothing, cannot be opened and send no request', async (t) => {
  withDocument(t, documentWith('disabled'));
  const previousMode = DataModeContext._currentValue;
  DataModeContext._currentValue = { dataMode: 'actual', async setDataMode() {} };
  t.after(() => { DataModeContext._currentValue = previousMode; });
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error('no request while Rota AI is disabled'); };
  t.after(() => { globalThis.fetch = previousFetch; });

  const probe = mountComponent(() => ({ assistant: useRotaAssistant() }), {});
  t.after(() => probe.unmount());
  assert.equal(probe.output.assistant.enabled, false);
  probe.output.assistant.openPanel();
  probe.render();
  probe.output.assistant.toggle();
  probe.render();
  for (let round = 0; round < 6; round += 1) await immediate();
  const { assistant } = probe.output;
  assert.equal(assistant.open, false);
  assert.deepEqual(calls, []);
  assert.equal(mountComponent(RotaAssistantLauncher, { assistant }).output, null);
  assert.equal(mountComponent(RotaAssistantPanel, { assistant, onOpenSettings() {} }).output, null);
});

test('with Rota AI enabled the launcher stays in the top bar', (t) => {
  withDocument(t, documentWith('enabled'));
  const previousMode = DataModeContext._currentValue;
  DataModeContext._currentValue = { dataMode: 'demo', async setDataMode() {} };
  t.after(() => { DataModeContext._currentValue = previousMode; });
  const probe = mountComponent(() => ({ assistant: useRotaAssistant() }), {});
  t.after(() => probe.unmount());
  assert.equal(probe.output.assistant.enabled, true);
  const launcher = mountComponent(RotaAssistantLauncher, { assistant: probe.output.assistant }).output;
  assert.equal(launcher.props.title, 'Bilgin');
  probe.output.assistant.openPanel();
  probe.render();
  assert.equal(probe.output.assistant.open, true);
});

test('the command palette offers the assistant only when it is enabled', () => {
  const shell = read('src/components/shell/AppShell.jsx');
  assert.match(shell, /onOpenAssistant=\{assistantActions\.enabled \? openAssistantPanel : null\}/);
  // Geç yüklenen asistan bağlandığında komut listesi yeniden kurulmalıdır: geri çağrı
  // her çizimde değişmeyecek biçimde saklanır ve listenin bağımlılığıdır.
  assert.match(shell, /const openAssistantPanel = useCallback\(async \(\) => \{\s*await closeTask\(\);\s*assistantActions\.openPanel\?\.\(\);\s*\}, \[closeTask, assistantActions\]\);/);
  const palette = read('src/components/shell/CommandPalette.jsx');
  assert.match(palette, /\.\.\.\(onOpenAssistant \? \[\{ kind: 'cmd', icon: 'Sparkles', label: 'Bilgin’e sor'/);
  assert.match(palette, /\}, \[q, tasks, navItems, onOpenAssistant\]\);/);
});
