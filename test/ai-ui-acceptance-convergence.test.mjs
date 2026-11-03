/** Arayüz kabulünün kendi başarısızlıkları sürecin çıkış koduna yansır; gerçek modele ihtiyaç duymaz. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
const root = resolve('.');
const directory = (t) => { const dir = mkdtempSync(join(tmpdir(), 'rota-kabul-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const run = (file, args, env = {}) => spawnSync(process.execPath, [resolve(file), ...args], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10000 });

test('rapor yalnızca bu koşuyu sayar ve başarısız çağrıyı düşünme açık diye sınıflandırmaz', (t) => {
  const dir = directory(t); mkdirSync(join(dir, 'out'));
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ runId: 'güncel' }));
  const row = (runId, calls = []) => ({ runId, profile: 'A', conversation: 'deneme', detail: 'balanced', turn: 1, question: 'durum', ms: 1, rendered: { status: 'ready', charts: [], tables: [] }, server: null, failures: [], calls });
  writeFileSync(join(dir, 'out', 'A.json'), JSON.stringify([row('eski')]));
  writeFileSync(join(dir, 'out', 'B.json'), JSON.stringify([row('güncel', [{ purpose: 'plan', ok: false }])]));
  const result = run('scripts/ui-acceptance/report.cjs', [join(dir, 'out')], { UI_RUN_ID: '' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /Toplam tur: 1;/u);
  assert.match(result.stdout, /düşünme açık çağrı: 0/u);
  assert.match(result.stdout, /başarısız: 1/u);
});

test('sürücü tarayıcı turu hatasını kaydeder, önceki konuşmayı korur ve başarısız çıkar', (t) => {
  const dir = directory(t); const modules = join(dir, 'node_modules'); mkdirSync(join(modules, 'playwright'), { recursive: true });
  // Yalnızca tarayıcı sınırını taklit eder; uygulama yanıtı üretemeden hata verir.
  writeFileSync(join(modules, 'playwright', 'index.js'), `
const locator={first(){return this},getByRole(){return this},isVisible:async()=>false,click:async()=>{},getAttribute:async()=> 'true',waitFor:async()=>{},count:async()=>0,fill:async()=>{throw Error('sınama turu hatası')},screenshot:async()=>{}};
const page={goto:async()=>{},getByRole:()=>locator,locator:()=>locator,waitForTimeout:async()=>{}};
exports.chromium={launch:async()=>({newContext:async()=>({newPage:async()=>page}),close:async()=>{}})};`);
  mkdirSync(join(dir, 'out'));
  writeFileSync(join(dir, 'out', 'A.json'), JSON.stringify([{ runId: 'eski', conversation: 'önceki', calls: [] }]));
  const scenario = { profile: 'A', port: 8101, appLog: 'app-A.log', conversations: [{ name: 'seçilen', detail: 'balanced', turns: ['durum'] }] };
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario));
  const result = run('scripts/ui-acceptance/drive.cjs', [join(dir, 'scenario.json'), join(dir, 'out')], { UI_ACCEPTANCE_DIR: dir, UI_ONLY: 'seçilen', UI_RUN_ID: 'güncel', NODE_PATH: modules });
  assert.equal(result.status, 1, result.stderr);
  const rows = JSON.parse(readFileSync(join(dir, 'out', 'A.json'), 'utf8'));
  assert.equal(rows[0].conversation, 'önceki');
  assert.equal(rows[1].runId, 'güncel');
  assert.equal(rows[1].rendered.status, 'driver-error');
  assert.ok(rows[1].failures.includes('tarayıcı turu tamamlanamadı'));
});

test('koşucu dolu köprü bağlantı noktasını kullanmaz ve önceki koşuyu silmez', async (t) => {
  const dir = directory(t); const modules = join(dir, 'node_modules'); mkdirSync(join(modules, 'playwright'), { recursive: true });
  writeFileSync(join(modules, 'playwright', 'index.js'), 'module.exports = {};');
  mkdirSync(join(dir, 'bin')); writeFileSync(join(dir, 'bin', 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  mkdirSync(join(dir, 'runs')); mkdirSync(join(dir, 'runs', 'önceki')); writeFileSync(join(dir, 'runs', 'önceki', 'ledger.jsonl'), 'önceki kanıt');
  const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => server.close());
  const result = spawnSync('bash', ['scripts/ui-acceptance/run.sh', 'A'], { cwd: root, env: { ...process.env, UI_ACCEPTANCE_DIR: dir, BRIDGE_PORT: String(server.address().port), NODE_PATH: modules, PATH: `${join(dir, 'bin')}:${process.env.PATH}` }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(readFileSync(join(dir, 'runs', 'önceki', 'ledger.jsonl'), 'utf8'), 'önceki kanıt');
  assert.equal(readdirSync(join(dir, 'runs')).length, 2, 'yeni koşu ayrı bir dizine ayrılır');
});

test('boş JSON köprüyü çökertmez; geçersiz istekten sonra model listesi çalışır', async (t) => {
  const dir = directory(t);
  const child = spawn(process.execPath, ['scripts/ui-acceptance/haikuBridge.mjs'], { cwd: root, env: { ...process.env, BRIDGE_PORT: '0', BRIDGE_CALLS: join(dir, 'calls.jsonl') }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('köprü açılmadı')), 5000);
    child.stdout.on('data', (chunk) => { const match = /bridge listening (\d+)/u.exec(String(chunk)); if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
    child.once('error', reject);
  });
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', body: 'null' });
  assert.equal(response.status, 400);
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/models`)).status, 200);
});
