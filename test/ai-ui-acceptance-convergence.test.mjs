/** Arayüz kabulünün kendi başarısızlıkları sürecin çıkış koduna yansır; gerçek modele ihtiyaç duymaz. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
  copyFileSync(resolve('scripts/ui-acceptance/drive.cjs'), join(dir, 'drive.cjs'));
  copyFileSync(resolve('scripts/ui-acceptance/expectations.cjs'), join(dir, 'expectations.cjs'));
  const result = run(join(dir, 'drive.cjs'), [join(dir, 'scenario.json'), join(dir, 'out')], { UI_ACCEPTANCE_DIR: dir, UI_ONLY: 'seçilen', UI_RUN_ID: 'güncel' });
  assert.equal(result.status, 1, result.stderr);
  const rows = JSON.parse(readFileSync(join(dir, 'out', 'A.json'), 'utf8'));
  assert.equal(rows[0].conversation, 'önceki');
  assert.equal(rows[1].runId, 'güncel');
  assert.equal(rows[1].rendered.status, 'driver-error');
  assert.ok(rows[1].failures.includes('tarayıcı turu tamamlanamadı'));
});

test('koşucu dolu köprü bağlantı noktasını kullanmaz ve önceki koşuyu silmez', { skip: process.platform === 'win32' }, async (t) => {
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

/** Süreç sınırını taklit eder; ağ dinleyicisi açmadan gerçek kabuk koşucusu ve rapor çalışır. */
function runnerFixture(t) {
  const dir = directory(t);
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const log = join(dir, 'başlatmalar.jsonl');
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'node'), `#!${process.execPath}
const fs=require('fs'),path=require('path'),cp=require('child_process'),args=process.argv.slice(2);
const record=(kind)=>fs.appendFileSync(process.env.KABUL_SINAMA_LOG,JSON.stringify({kind,budget:process.env.BRIDGE_MAX_CALLS})+'\\n');
if(args[0]==='--input-type=module'&&args[2]?.includes('import net from'))process.exit(0);
if(args[0]==='-e'&&args[1].includes("require.resolve('playwright')"))process.exit(0);
if(args[0]?.endsWith('haikuBridge.mjs')){record('köprü');setInterval(()=>{},1000);}
else if(args[0]==='node_modules/next/dist/bin/next'){record('uygulama');setInterval(()=>{},1000);}
else if(args[0]?.endsWith('drive.cjs')){
 record('sürücü');
 const profile=path.basename(args[1],'.json');
 fs.writeFileSync(path.join(args[2],profile+'.json'),JSON.stringify([{runId:process.env.UI_RUN_ID,profile,conversation:'başarısız sınama',detail:'balanced',turn:1,question:'durum',ms:1,rendered:{status:'driver-error',charts:[],tables:[]},server:null,calls:[],failures:['sınama hatası']}]));
 process.exit(1);
}else{const result=cp.spawnSync(${JSON.stringify(process.execPath)},args,{stdio:'inherit'});process.exit(result.status??1);}
`, { mode: 0o755 });
  const invoke = (profiles, env = {}) => spawnSync('bash', ['scripts/ui-acceptance/run.sh', ...profiles], { cwd: root, env: { ...process.env, UI_ACCEPTANCE_DIR: dir, PATH: `${bin}:${process.env.PATH}`, KABUL_SINAMA_LOG: log, BRIDGE_MAX_CALLS: '', ...env }, encoding: 'utf8', timeout: 10000 });
  const starts = () => readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  return { dir, invoke, starts };
}

test('sonraki geçersiz profil bütün süreçler ve kanıt dizini açılmadan reddedilir', { skip: process.platform === 'win32' }, (t) => {
  const fixture = runnerFixture(t);
  const result = fixture.invoke(['A', 'X']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Geçersiz profil: X/u);
  assert.deepEqual(readdirSync(fixture.dir), ['bin']);
});

test('koşucu başarısız profilin raporunu ve kanıt yolunu verir, sonraki profili başlatmaz', { skip: process.platform === 'win32' }, (t) => {
  const fixture = runnerFixture(t);
  const result = fixture.invoke(['A', 'B']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /driver-error/u);
  const evidence = /Kabul kanıtı: (.+)/u.exec(result.stdout)?.[1];
  assert.ok(evidence, result.stdout);
  assert.match(readFileSync(join(evidence, 'report.md'), 'utf8'), /driver-error/u);
  assert.equal(JSON.parse(readFileSync(join(evidence, 'out', 'A.json'), 'utf8'))[0].failures[0], 'sınama hatası');
  assert.equal(fixture.starts().filter((item) => item.kind === 'uygulama').length, 1);
  assert.equal(fixture.starts().filter((item) => item.kind === 'sürücü').length, 1);
});

test('varsayılan çağrı bütçesi seçilen bütün senaryo turlarını kapsar ve açık sınır korunur', { skip: process.platform === 'win32' }, (t) => {
  const fixture = runnerFixture(t);
  const result = fixture.invoke([]);
  assert.equal(result.status, 1, result.stderr);
  const turns = readdirSync('scripts/ui-acceptance/scenarios').filter((name) => /^[A-G]\.json$/u.test(name)).reduce((total, name) => total + JSON.parse(readFileSync(join('scripts/ui-acceptance/scenarios', name), 'utf8')).conversations.reduce((count, item) => count + item.turns.length, 0), 0);
  assert.ok(turns * 2 > 140, 'eski sabit bütçe normal iki çağrılı yolu bile karşılamaz');
  assert.equal(Number(fixture.starts().find((item) => item.kind === 'köprü').budget), turns * 4);
  const explicit = fixture.invoke(['A'], { BRIDGE_MAX_CALLS: '7' });
  assert.equal(explicit.status, 1, explicit.stderr);
  assert.equal(fixture.starts().filter((item) => item.kind === 'köprü').at(-1).budget, '7');
});

test('köprü büyük girdiyi okumadan kapanan bağdaştırıcıyı başarısız kaydeder ve yaşamaya devam eder', async (t) => {
  const dir = directory(t);
  const child = spawn(process.execPath, ['scripts/ui-acceptance/haikuBridge.mjs'], { cwd: root, env: { ...process.env, BRIDGE_PORT: '0', BRIDGE_CALLS: join(dir, 'calls.jsonl'), PLANNER_MODEL_TIMEOUT_MS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('köprü açılmadı')), 5000);
    child.stdout.on('data', (chunk) => { const match = /bridge listening (\d+)/u.exec(String(chunk)); if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
    child.once('error', reject);
  });
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', messages: [{ role: 'system', content: 'x'.repeat(2_000_000) }] }) });
  assert.equal(response.status, 503);
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/models`)).status, 200);
  assert.equal(JSON.parse(readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim()).ok, false);
});

test('rol beklentileri sonuç, kanıt sınırı ve görünür metnin tamamında sağlanır', async () => {
  const { semanticFailures } = (await import('../scripts/ui-acceptance/expectations.cjs')).default;
  const expected = { outcome: 'unavailable', maxEvidence: 0, requires: ['yönetim kapsamınız bulunmuyor'], forbids: ['Gizli kişi'] };
  assert.deepEqual(semanticFailures(expected, { text: 'yönetim kapsamınız bulunmuyor' }, { outcome: 'unavailable', evidence: 0 }), []);
  for (const [rendered, trace, message] of [
    [{ text: 'yönetim kapsamınız bulunmuyor' }, { outcome: 'grounded', evidence: 0 }, 'beklenen sonuç alınmadı: unavailable'],
    [{ text: 'yönetim kapsamınız bulunmuyor' }, { outcome: 'unavailable', evidence: 1 }, 'beklenen kanıt sınırı aşıldı'],
    [{ text: 'yönetim kapsamınız bulunmuyor' }, { outcome: 'unavailable' }, 'beklenen kanıt sınırı aşıldı'],
    [{ text: 'başarılı' }, { outcome: 'unavailable', evidence: 0 }, 'zorunlu görünür metin yok: yönetim kapsamınız bulunmuyor'],
    [{ text: 'yönetim kapsamınız bulunmuyor; Gizli kişi' }, { outcome: 'unavailable', evidence: 0 }, 'yasak görünür metin var: Gizli kişi']
  ]) assert.ok(semanticFailures(expected, rendered, trace).includes(message));
});

test('yetki ihlali görünen başarılı tarayıcı turu kanıt yazıp başarısız çıkar', (t) => {
  const dir = directory(t); mkdirSync(join(dir, 'node_modules', 'playwright'), { recursive: true });
  copyFileSync(resolve('scripts/ui-acceptance/drive.cjs'), join(dir, 'drive.cjs'));
  copyFileSync(resolve('scripts/ui-acceptance/expectations.cjs'), join(dir, 'expectations.cjs'));
  writeFileSync(join(dir, 'node_modules', 'playwright', 'index.js'), `
const fs=require('fs'),path=require('path');
const locator={first(){return this},getByRole(){return this},isVisible:async()=>false,click:async()=>{},getAttribute:async()=> 'true',waitFor:async()=>{},count:async()=>0,fill:async()=>{},press:async()=>{},screenshot:async()=>{}};
const page={goto:async()=>{},getByRole:()=>locator,locator:()=>locator,waitForTimeout:async()=>{},waitForFunction:async()=>{},evaluate:async()=>{
 fs.appendFileSync(path.join(process.env.UI_ACCEPTANCE_DIR,'app-A.log'),JSON.stringify({operation:'ai.grounded.turn',context:{outcome:'grounded',evidence:1}})+'\\n');
 return {status:'ready',text:'Korunan ekip verisi',charts:[],tables:[]};
}};
exports.chromium={launch:async()=>({newContext:async()=>({newPage:async()=>page}),close:async()=>{}})};`);
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ profile: 'A', port: 8101, appLog: 'app-A.log', conversations: [{ name: 'yetkisiz ekip', detail: 'balanced', turns: ['ekibimi göster'], expectedTurns: [{ outcome: 'unavailable', maxEvidence: 0, forbids: ['Korunan ekip verisi'] }] }] }));
  const result = run(join(dir, 'drive.cjs'), [join(dir, 'scenario.json'), join(dir, 'out')], { UI_ACCEPTANCE_DIR: dir, UI_RUN_ID: 'güncel' });
  assert.equal(result.status, 1, result.stderr);
  const row = JSON.parse(readFileSync(join(dir, 'out', 'A.json'), 'utf8'))[0];
  assert.equal(row.rendered.status, 'ready');
  assert.equal(row.server.outcome, 'grounded');
  assert.ok(row.failures.includes('beklenen sonuç alınmadı: unavailable'));
  assert.ok(row.failures.includes('beklenen kanıt sınırı aşıldı'));
  assert.ok(row.failures.includes('yasak görünür metin var: Korunan ekip verisi'));
});

test('bütün rol profillerinin yetkiyi kanıtlayan açık senaryo beklentisi vardır', () => {
  for (const name of ['A','B','C','D','E','F','G']) {
    const scenario = JSON.parse(readFileSync(`scripts/ui-acceptance/scenarios/${name}.json`, 'utf8'));
    assert.ok(scenario.conversations.some((conversation) => conversation.expectedTurns?.some((expected) => expected.outcome && (expected.requires?.length || expected.forbids?.length))), `rol beklentisi eksik: ${name}`);
  }
});
