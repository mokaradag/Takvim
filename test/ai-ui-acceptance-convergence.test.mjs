/** Arayüz kabulünün kendi başarısızlıkları sürecin çıkış koduna yansır; gerçek modele ihtiyaç duymaz. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { createServer } from 'node:http';
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
  const child = spawn(process.execPath, ['scripts/ui-acceptance/modelBridge.mjs'], { cwd: root, env: { ...process.env, BRIDGE_PORT: '0', BRIDGE_CALLS: join(dir, 'calls.jsonl') }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  writeFileSync(join(bin, 'curl'), `#!${process.execPath}
const fs=require('fs'),url=process.argv.find((arg)=>arg.startsWith('http://'))||'';
const kind=url.endsWith('/v1/models')?'köprü':'uygulama';
let rows=[];try{rows=fs.readFileSync(process.env.KABUL_SINAMA_LOG,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse)}catch{}
process.exit(rows.some((row)=>row.kind===kind&&row.runId===process.env.UI_RUN_ID)?0:1);
`, { mode: 0o755 });
  writeFileSync(join(bin, 'node'), `#!${process.execPath}
const fs=require('fs'),path=require('path'),cp=require('child_process'),args=process.argv.slice(2);
const record=(kind)=>fs.appendFileSync(process.env.KABUL_SINAMA_LOG,JSON.stringify({kind,runId:process.env.UI_RUN_ID,budget:process.env.BRIDGE_MAX_CALLS,tokens:process.env.BRIDGE_MAX_UNCACHED})+'\\n');
if(args[0]==='--input-type=module'&&args[2]?.includes('import net from'))process.exit(0);
if(args[0]==='-e'&&args[1].includes("require.resolve('playwright')"))process.exit(0);
if(args[0]?.endsWith('modelBridge.mjs')){record('köprü');setInterval(()=>{},1000);}
else if(args[0]==='node_modules/next/dist/bin/next'){setTimeout(()=>record('uygulama'),200);setInterval(()=>{},1000);}
else if(args[0]?.endsWith('drive.cjs')){
 record('sürücü');
 const profile=path.basename(args[1],'.json');
 fs.writeFileSync(path.join(args[2],profile+'.json'),JSON.stringify([{runId:process.env.UI_RUN_ID,profile,conversation:'başarısız sınama',detail:'balanced',turn:1,question:'durum',ms:1,rendered:{status:'driver-error',charts:[],tables:[]},server:null,calls:[],failures:['sınama hatası']}]));
 process.exit(1);
}else{const result=cp.spawnSync(${JSON.stringify(process.execPath)},args,{stdio:'inherit'});process.exit(result.status??1);}
`, { mode: 0o755 });
  const invoke = (profiles, env = {}) => spawnSync('bash', ['scripts/ui-acceptance/run.sh', ...profiles], { cwd: root, env: { ...process.env, UI_ACCEPTANCE_DIR: dir, PATH: `${bin}:${process.env.PATH}`, KABUL_SINAMA_LOG: log, BRIDGE_MAX_CALLS: '', BRIDGE_MAX_UNCACHED: '', ...env }, encoding: 'utf8', timeout: 10000 });
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
  assert.equal(Number(fixture.starts().find((item) => item.kind === 'köprü').tokens), turns * 4 * 64000);
  const explicit = fixture.invoke(['A'], { BRIDGE_MAX_CALLS: '7', BRIDGE_MAX_UNCACHED: '123456' });
  assert.equal(explicit.status, 1, explicit.stderr);
  assert.equal(fixture.starts().filter((item) => item.kind === 'köprü').at(-1).budget, '7');
  assert.equal(fixture.starts().filter((item) => item.kind === 'köprü').at(-1).tokens, '123456');
});

test('köprü büyük girdiyi okumadan kapanan bağdaştırıcıyı başarısız kaydeder ve yaşamaya devam eder', async (t) => {
  const dir = directory(t);
  const child = spawn(process.execPath, ['scripts/ui-acceptance/modelBridge.mjs'], { cwd: root, env: { ...process.env, BRIDGE_PORT: '0', BRIDGE_CALLS: join(dir, 'calls.jsonl'), PLANNER_MODEL_TIMEOUT_MS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
 return {status:'complete',text:'Korunan ekip verisi',charts:[],tables:[]};
}};
exports.chromium={launch:async()=>({newContext:async()=>({newPage:async()=>page}),close:async()=>{}})};`);
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ profile: 'A', port: 8101, appLog: 'app-A.log', conversations: [{ name: 'yetkisiz ekip', detail: 'balanced', turns: ['ekibimi göster'], expectedTurns: [{ outcome: 'unavailable', maxEvidence: 0, forbids: ['Korunan ekip verisi'] }] }] }));
  const result = run(join(dir, 'drive.cjs'), [join(dir, 'scenario.json'), join(dir, 'out')], { UI_ACCEPTANCE_DIR: dir, UI_RUN_ID: 'güncel' });
  assert.equal(result.status, 1, result.stderr);
  const row = JSON.parse(readFileSync(join(dir, 'out', 'A.json'), 'utf8'))[0];
  assert.equal(row.rendered.status, 'complete');
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

for (const status of ['failed', 'unanswered', 'stopped', 'interrupted', 'waiting', 'streaming', 'complete']) test(`arayüz kabulü ürünün tamamlanma durumunu ve sunucu sonucunu birlikte denetler: ${({ failed: 'başarısız', unanswered: 'yanıtsız', stopped: 'durdurulmuş', interrupted: 'kesilmiş', waiting: 'bekleyen', streaming: 'akan', complete: 'tamamlanmış' })[status]}`, (t) => {
  const dir = directory(t); mkdirSync(join(dir, 'node_modules', 'playwright'), { recursive: true });
  for (const file of ['drive.cjs', 'expectations.cjs']) copyFileSync(resolve(`scripts/ui-acceptance/${file}`), join(dir, file));
  writeFileSync(join(dir, 'node_modules', 'playwright', 'index.js'), `
const fs=require('fs'),path=require('path');
const locator={first(){return this},getByRole(){return this},isVisible:async()=>false,click:async()=>{},getAttribute:async()=> 'true',waitFor:async()=>{},count:async()=>0,fill:async()=>{},press:async()=>{},screenshot:async()=>{}};
const page={goto:async()=>{},getByRole:()=>locator,locator:()=>locator,waitForTimeout:async()=>{},waitForFunction:async()=>{},evaluate:async()=>{
 fs.appendFileSync(path.join(process.env.UI_ACCEPTANCE_DIR,'app-A.log'),JSON.stringify({operation:'ai.grounded.turn',context:{outcome:process.env.SINAMA_SONUC,evidence:1}})+'\\n');
 if(process.env.SINAMA_MODEL_KAYDI!=='yok')fs.appendFileSync(path.join(process.env.UI_ACCEPTANCE_DIR,'calls.jsonl'),JSON.stringify({purpose:'plan',ok:true,toolCalls:['rota_plan'],models:['claude-haiku-4-5-20251001'],thinking:'off',thinkingTokens:0})+'\\n');
 return {status:${JSON.stringify(status)},text:'Doğrulanmış yanıt',charts:[],tables:[]};
}};
exports.chromium={launch:async()=>({newContext:async()=>({newPage:async()=>page}),close:async()=>{}})};`);
  const scenario = { profile: 'A', port: 8101, appLog: 'app-A.log', conversations: [{ name: 'yanıt tamamlanması', detail: 'balanced', turns: ['durum'] }] };
  const file = join(dir, 'scenario.json'); writeFileSync(file, JSON.stringify(scenario));
  const invoke = (outcome, env = {}) => run(join(dir, 'drive.cjs'), [file, join(dir, 'out')], { UI_ACCEPTANCE_DIR: dir, UI_RUN_ID: 'güncel', SINAMA_SONUC: outcome, ...env });
  const success = invoke('grounded');
  assert.equal(success.status, status === 'complete' ? 0 : 1, success.stderr);
  const row = JSON.parse(readFileSync(join(dir, 'out', 'A.json'), 'utf8'))[0];
  assert.equal(row.rendered.status, status);
  assert.equal(row.failures.length === 0, status === 'complete');
  for (const outcome of ['failed', 'error']) assert.equal(invoke(outcome).status, 1);
  if (status === 'complete') {
    assert.equal(invoke('clarification').status, 1, 'açık beklenti yokken eksik gönderge başarılı analiz değildir');
    assert.equal(invoke('unavailable').status, 1, 'açık beklenti yokken kullanılamayan sonuç başarılı analiz değildir');
    assert.equal(invoke('grounded', { SINAMA_MODEL_KAYDI: 'yok' }).status, 1, 'model kaydı olmayan tamamlanmış yanıt başarısızdır');
    scenario.conversations[0].expectedTurns = [{ table: true }]; writeFileSync(file, JSON.stringify(scenario));
    assert.equal(invoke('grounded').status, 1, 'açık tablo isteği tablosuz yanıtla geçmez');
  }
});

test('rapor anlatı geri dönüşünü sunucu ve model düzeninden ayrı adlandırır', (t) => {
  const dir = directory(t); mkdirSync(join(dir, 'out'));
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ runId: 'güncel' }));
  const rows = [{ mode: 'narrative', reason: 'SHEET_LIMIT' }, { mode: 'composed', server: true, reason: 'DISABLED' }, { mode: 'composed' }].map((presentation) => ({ runId: 'güncel', profile: 'A', conversation: 'sunum yolu', detail: 'balanced', turn: 1, question: 'durum', ms: 1, rendered: { status: 'complete', charts: [], tables: [] }, server: { outcome: 'grounded', presentation }, failures: [], calls: [{purpose:'plan',ok:true,toolCalls:['rota_plan'],models:['claude-haiku-4-5-20251001'],thinking:'off',thinkingTokens:0}, ...(presentation.mode === 'composed' && !presentation.server ? [{purpose:'compose',ok:true,models:['claude-haiku-4-5-20251001'],thinking:'off',thinkingTokens:0}] : [])] }));
  writeFileSync(join(dir, 'out', 'A.json'), JSON.stringify(rows));
  const result = run('scripts/ui-acceptance/report.cjs', [join(dir, 'out')], { UI_RUN_ID: '' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /anlatı \(SHEET_LIMIT\)/u);
  assert.match(result.stdout, /sunucu \(DISABLED/u);
  assert.equal(result.stdout.match(/model düzyazısı/gu).length, 1);
});

test('tablo beklentisi dolu ve görünür gerçek satır ister', async () => {
  const { semanticFailures } = (await import('../scripts/ui-acceptance/expectations.cjs')).default;
  for (const tables of [[], [{ rows: 0, visible: true }], [{ rows: 2, visible: false }]]) assert.ok(semanticFailures({ table: true }, { tables }, {}).length > 0);
  assert.deepEqual(semanticFailures({ table: true }, { tables: [{ rows: 2, visible: true }] }, { outcome: 'grounded' }), []);
});

test('yetki kapsamını devralan her ekip ve proje takibi açık sızıntı beklentisi taşır', async () => {
  for (const [profile, name] of [['B', 'Z2-ekip-is-yuku'], ['E', 'Proje-odakli']]) {
    const conversation = JSON.parse(readFileSync(`scripts/ui-acceptance/scenarios/${profile}.json`, 'utf8')).conversations.find((item) => item.name === name);
    assert.ok(conversation.turns.length > 1);
    assert.equal(conversation.expectedTurns.length, conversation.turns.length);
    for (const expectation of conversation.expectedTurns) {
      assert.equal(expectation.outcome, 'grounded');
      assert.deepEqual(expectation.forbids, conversation.expectedTurns[0].forbids);
      assert.ok(expectation.forbids.length > 0);
    }
  }
  const empty = JSON.parse(readFileSync('scripts/ui-acceptance/scenarios/G.json', 'utf8')).conversations[0].expectedTurns[0];
  const { semanticFailures } = (await import('../scripts/ui-acceptance/expectations.cjs')).default;
  assert.ok(semanticFailures(empty, { text: '2026 yılında 10 görev' }, { outcome: 'grounded' }).length > 0);
});

test('model kanıtı plan düzen ve açık sunucu yeniden yürütmesini birbirinden ayırır', async () => {
  const { modelFailures } = (await import('../scripts/ui-acceptance/expectations.cjs')).default;
  const plan = { purpose: 'plan', toolCalls: ['rota_plan'], ok: true, models: ['claude-haiku-4-5-20251001'], thinking: 'off', thinkingTokens: 0 };
  const compose = { ...plan, purpose: 'compose', toolCalls: [] };
  const grounded = { outcome: 'grounded', evidence: 1 };
  assert.ok(modelFailures(null, grounded, []).includes('planlayıcı model çağrısı kanıtı yok'));
  assert.ok(modelFailures(null, grounded, [{ ...plan, toolCalls: [] }]).length > 0, 'rastgele araç çağrısı türlü planın kanıtı değildir');
  assert.deepEqual(modelFailures(null, grounded, [plan]), []);
  const modelLayout = { ...grounded, presentation: { mode: 'composed' } };
  assert.ok(modelFailures(null, modelLayout, [plan]).includes('model düzeni çağrı kanıtı yok'));
  assert.deepEqual(modelFailures(null, modelLayout, [plan, compose]), []);
  assert.deepEqual(modelFailures({ serverReplay: true }, grounded, []), []);
  assert.ok(modelFailures({ serverReplay: true }, { ...grounded, evidence: 0 }, []).length > 0);
  assert.ok(modelFailures({ serverReplay: true }, grounded, [plan]).length > 0, 'sunucu yeniden yürütmesi yeni planlayıcı turuna dönüşmez');
  assert.ok(modelFailures({ serverReplay: true }, modelLayout, []).length > 0);
  assert.deepEqual(modelFailures({ serverReplay: true }, modelLayout, [compose]), []);
});

test('rapor sıfır model çağrılı olağan koşuyu başarısız sayar ve ayrıntısını korur', (t) => {
  const dir = directory(t); mkdirSync(join(dir, 'out'));
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ runId: 'güncel' }));
  const row = { runId: 'güncel', profile: 'A', conversation: 'eksik model kanıtı', detail: 'balanced', turn: 1, question: 'durum', ms: 1, rendered: { status: 'complete', charts: [], tables: [] }, server: { outcome: 'grounded', evidence: 1 }, failures: [], calls: [] };
  const file = join(dir, 'out', 'A.json'); writeFileSync(file, JSON.stringify([row]));
  const result = run('scripts/ui-acceptance/report.cjs', [join(dir, 'out')], { UI_RUN_ID: '' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /Toplam tur: 1; model çağrısı: 0/u);
  assert.equal(JSON.parse(readFileSync(file, 'utf8'))[0].conversation, 'eksik model kanıtı');
  row.serverReplay = true; writeFileSync(file, JSON.stringify([row]));
  assert.equal(run('scripts/ui-acceptance/report.cjs', [join(dir, 'out')], { UI_RUN_ID: '' }).status, 0);
});

/** Tarayıcı sınırını taklit eden sürücü dizini: her tur başarılı bir yanıt ve bu tura ait sunucu kaydı üretir. */
function fakeDriverDir(t) {
  const dir = directory(t); mkdirSync(join(dir, 'node_modules', 'playwright'), { recursive: true });
  copyFileSync(resolve('scripts/ui-acceptance/drive.cjs'), join(dir, 'drive.cjs'));
  copyFileSync(resolve('scripts/ui-acceptance/expectations.cjs'), join(dir, 'expectations.cjs'));
  writeFileSync(join(dir, 'node_modules', 'playwright', 'index.js'), `
const fs=require('fs'),path=require('path');
const locator={first(){return this},getByRole(){return this},getByTitle(){return this},isVisible:async()=>false,click:async()=>{},getAttribute:async()=> 'true',waitFor:async()=>{},count:async()=>0,fill:async()=>{},press:async()=>{},screenshot:async()=>{}};
const page={goto:async()=>{},getByRole:()=>locator,getByTitle:()=>locator,locator:()=>locator,waitForTimeout:async()=>{},waitForFunction:async()=>{},setViewportSize:async()=>{},evaluate:async()=>{
 fs.appendFileSync(path.join(process.env.UI_ACCEPTANCE_DIR,'app-B.log'),JSON.stringify({operation:'ai.grounded.turn',context:{outcome:'grounded',evidence:1}})+'\\n');
 return {status:'complete',text:'Yanıt',charts:[],tables:[]};
}};
exports.chromium={launch:async()=>({newContext:async()=>({newPage:async()=>page}),close:async()=>{}})};`);
  mkdirSync(join(dir, 'out'));
  return dir;
}

test('veri tohumu uyuşmayan konuşma atlanır ama önceki satırı silinmez; atlanan konuşma eksik kapsamdır ve rapor başarı saymaz', (t) => {
  const dir = fakeDriverDir(t);
  writeFileSync(join(dir, 'out', 'B.json'), JSON.stringify([{ runId: 'eski', conversation: 'G1', calls: [] }]));
  const scenario = { profile: 'B', port: 8102, appLog: 'app-B.log', conversations: [{ name: 'G1', detail: 'balanced', turns: ['yönetici sorusu'], seed: 'executive' }] };
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario));
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ runId: 'güncel' }));
  const result = run(join(dir, 'drive.cjs'), [join(dir, 'scenario.json'), join(dir, 'out')], { UI_ACCEPTANCE_DIR: dir, UI_ONLY: 'G1', UI_RUN_ID: 'güncel', UI_SEED: '' });
  assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(readFileSync(join(dir, 'out', 'B.json'), 'utf8'));
  assert.deepEqual(rows.map((row) => [row.runId, row.conversation, Boolean(row.skipped)]), [['eski', 'G1', false], ['güncel', 'G1', true]], 'önceki geçerli satır korunur');
  const report = run('scripts/ui-acceptance/report.cjs', [join(dir, 'out')], { UI_RUN_ID: 'güncel' });
  assert.equal(report.status, 1, report.stdout);
  assert.match(report.stdout, /Kapsam eksik \(sınanmadı\): B\/G1/u);
});

test('yalnızca seçilen konuşma yeniden koşulduğunda aynı koşunun seçilmeyen atlanmış konuşmaları rapordan düşmez', (t) => {
  const dir = fakeDriverDir(t);
  // G1 bu koşuda geçerli planlayıcı çağrısı kanıtıyla geçer: raporun başarısızlığı yalnızca atlanmış G2'den gelebilir.
  const playwright = join(dir, 'node_modules', 'playwright', 'index.js');
  writeFileSync(playwright, readFileSync(playwright, 'utf8').replace("return {status:'complete'",
    "fs.appendFileSync(path.join(process.env.UI_ACCEPTANCE_DIR,'calls.jsonl'),JSON.stringify({purpose:'plan',ok:true,toolCalls:['rota_plan'],models:['claude-haiku-4-5-20251001'],thinking:'off',thinkingTokens:0})+'\\n');\n return {status:'complete'"));
  // Aynı koşuda G1 ve G2 atlanmıştı (veri tohumu yoktu); şimdi yalnızca G1 yeniden koşuluyor. Atlanmış satır sürücünün yazdığı tam biçimdedir.
  const skippedRow = (conversation) => ({ runId: 'güncel', skipped: 'UI_SEED=executive gerekir', failures: ['kapsam eksik: UI_SEED=executive gerekir'], profile: 'B', conversation,
    detail: 'balanced', turn: 0, question: 'soru', ms: 0, rendered: { status: 'skipped', tables: [], charts: [] }, server: null, calls: [] });
  writeFileSync(join(dir, 'out', 'B.json'), JSON.stringify([skippedRow('G1'), skippedRow('G2')]));
  const scenario = { profile: 'B', port: 8102, appLog: 'app-B.log', conversations: [{ name: 'G1', detail: 'balanced', turns: ['birinci soru'] },
    { name: 'G2', detail: 'balanced', turns: ['ikinci soru'], seed: 'executive' }] };
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario));
  const driven = run(join(dir, 'drive.cjs'), [join(dir, 'scenario.json'), join(dir, 'out')], { UI_ACCEPTANCE_DIR: dir, UI_ONLY: 'G1', UI_RUN_ID: 'güncel', UI_SEED: '' });
  assert.equal(driven.status, 0, driven.stderr);
  const rows = JSON.parse(readFileSync(join(dir, 'out', 'B.json'), 'utf8'));
  assert.ok(rows.some((row) => row.conversation === 'G1' && !row.skipped && !row.failures.length), 'seçilen konuşma koşuldu ve geçti');
  assert.ok(rows.some((row) => row.conversation === 'G2' && row.skipped), 'seçilmeyen atlanmış konuşma korunur');
  assert.equal(rows.filter((row) => row.conversation === 'G1' && row.skipped).length, 0, 'yeniden koşulan konuşmanın atlanmış satırı yenilenir');
  const report = run('scripts/ui-acceptance/report.cjs', [join(dir, 'out')], { UI_RUN_ID: 'güncel' });
  assert.equal(report.status, 1, 'sınanmamış konuşma varken rapor başarı saymaz');
  assert.equal(report.stderr, '', 'rapor çökmeden kapsam denetimine ulaşır');
  assert.match(report.stdout, /Kapsam eksik \(sınanmadı\): B\/G2 /u);
  // Atlanmış satır kaldırılırsa aynı koşu başarılıdır: başarısızlığın nedeni yalnızca eksik kapsamdır.
  writeFileSync(join(dir, 'out', 'B.json'), JSON.stringify(rows.filter((row) => !row.skipped)));
  assert.equal(run('scripts/ui-acceptance/report.cjs', [join(dir, 'out')], { UI_RUN_ID: 'güncel' }).status, 0);
});

test('betikli kipte seçilen profilin hiç betikli konuşması yoksa eksik kapsam yazılır ve rapor başarı saymaz', (t) => {
  const dir = fakeDriverDir(t);
  const scenario = { profile: 'B', port: 8102, appLog: 'app-B.log', conversations: [{ name: 'plansız', detail: 'balanced', turns: ['altın planı olmayan soru'] }] };
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario));
  // Betikli plan listesi boş dönen yerel uç.
  const server = createServer((request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ questions: [] })); });
  return new Promise((resolveTest, rejectTest) => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    const proc = spawn(process.execPath, [join(dir, 'drive.cjs'), join(dir, 'scenario.json'), join(dir, 'out')], { env: { ...process.env, UI_ACCEPTANCE_DIR: dir, UI_RUN_ID: 'güncel', UI_SCRIPTED: '1', BRIDGE_PORT: String(port) } });
    proc.on('close', () => {
      server.close();
      try {
        const rows = JSON.parse(readFileSync(join(dir, 'out', 'B.json'), 'utf8'));
        assert.deepEqual(rows.map((row) => [row.profile, row.skipped]), [['B', 'betikli plan yok']]);
        const report = run('scripts/ui-acceptance/report.cjs', [join(dir, 'out')], { UI_RUN_ID: 'güncel' });
        assert.equal(report.status, 1);
        assert.match(report.stdout, /Kapsam eksik \(sınanmadı\): B\/plansız/u);
        resolveTest();
      } catch (error) { rejectTest(error); }
    });
  }));
});

test('betikli kipte sunucu yeniden yürütme turu yeni planlayıcı çağrısıyla geçemez', async () => {
  const { replayFailures } = (await import('../scripts/ui-acceptance/expectations.cjs')).default;
  const grounded = { outcome: 'grounded', evidence: 1 };
  const scriptedPlan = { purpose: 'plan', ok: true, scripted: true, toolCalls: ['rota_plan'] };
  assert.ok(replayFailures({ serverReplay: true }, grounded, [scriptedPlan]).length > 0, 'betikli planlayıcı çağrısı yeniden yürütmenin yerine geçmez');
  assert.ok(replayFailures({ serverReplay: true }, { ...grounded, evidence: 0 }, []).length > 0);
  assert.deepEqual(replayFailures({ serverReplay: true }, grounded, []), []);
  assert.deepEqual(replayFailures(null, grounded, [scriptedPlan]), [], 'olağan betikli turda yeniden yürütme denetimi yoktur');
});

test('betikli kipte model düzeniyle çizilen tur düzen çağrısı kanıtı olmadan geçemez', async () => {
  const { scriptedFailures, modelFailures } = (await import('../scripts/ui-acceptance/expectations.cjs')).default;
  const composed = { outcome: 'grounded', evidence: 1, presentation: { mode: 'composed', server: false } };
  const plan = { purpose: 'plan', ok: true, scripted: true, toolCalls: ['rota_plan'] };
  const compose = { purpose: 'compose', ok: true, scripted: true, toolCalls: [] };
  assert.deepEqual(scriptedFailures(null, composed, [plan]), ['model düzeni çağrı kanıtı yok'], 'düzen çağrısı kaydı olmayan betikli tur reddedilmeli');
  assert.deepEqual(scriptedFailures(null, composed, [plan, { ...compose, ok: false }]), ['model düzeni çağrı kanıtı yok'], 'başarısız düzen çağrısı kanıt sayılmamalı');
  assert.deepEqual(scriptedFailures(null, composed, [plan, compose]), [], 'düzen çağrısı kaydı olan betikli tur geçmeli');
  assert.deepEqual(scriptedFailures(null, { ...composed, presentation: { mode: 'composed', server: true } }, [plan]), [], 'sunucu düzeni düzen çağrısı gerektirmez');
  assert.ok(modelFailures(null, composed, [{ ...plan, models: ['claude-haiku-4-5-20251001'], thinking: 'off', thinkingTokens: 0 }]).includes('model düzeni çağrı kanıtı yok'), 'canlı kipte de aynı denetim uygulanmalı');
});

test('UI_SCRIPTED=1 tek başına model kabulünü kapatmaz: betikli uç kaydı yoksa model çağrısı denetimi uygulanır', (t) => {
  const dir = fakeDriverDir(t);
  const scenario = { profile: 'B', port: 8102, appLog: 'app-B.log', conversations: [{ name: 'durum', detail: 'balanced', turns: ['durumum'] }] };
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario));
  const result = run(join(dir, 'drive.cjs'), [join(dir, 'scenario.json'), join(dir, 'out')], { UI_ACCEPTANCE_DIR: dir, UI_RUN_ID: 'güncel', UI_SCRIPTED: '1', BRIDGE_PORT: '1' });
  assert.equal(result.status, 1, result.stderr);
  const [row] = JSON.parse(readFileSync(join(dir, 'out', 'B.json'), 'utf8'));
  assert.equal(row.scripted, undefined);
  assert.ok(row.failures.includes('planlayıcı model çağrısı kanıtı yok'), row.failures.join('; '));
  // Betikli uç kaydı varsa (scripted: true) model kabulü uygulanmaz.
  const scriptedDir = fakeDriverDir(t);
  const bridgeLog = join(scriptedDir, 'node_modules', 'playwright', 'index.js');
  writeFileSync(bridgeLog, readFileSync(bridgeLog, 'utf8').replace("return {status:'complete'",
    "fs.appendFileSync(path.join(process.env.UI_ACCEPTANCE_DIR,'calls.jsonl'),JSON.stringify({purpose:'plan',ok:true,scripted:true,toolCalls:['rota_plan']})+'\\n');\n return {status:'complete'"));
  writeFileSync(join(scriptedDir, 'scenario.json'), JSON.stringify(scenario));
  const scripted = run(join(scriptedDir, 'drive.cjs'), [join(scriptedDir, 'scenario.json'), join(scriptedDir, 'out')], { UI_ACCEPTANCE_DIR: scriptedDir, UI_RUN_ID: 'güncel', UI_SCRIPTED: '1', BRIDGE_PORT: '1' });
  assert.equal(scripted.status, 0, scripted.stderr);
  assert.equal(JSON.parse(readFileSync(join(scriptedDir, 'out', 'B.json'), 'utf8'))[0].scripted, true);
});

test('betikli kabul yalnızca bütün turlarının altın planı olan konuşmaları koşar; plansız soru açıklama kararıyla geçmez', async (t) => {
  const dir = fakeDriverDir(t);
  const child = spawn(process.execPath, ['scripts/ui-acceptance/scriptedBridge.mjs'], { cwd: root, env: { ...process.env, BRIDGE_PORT: '0', BRIDGE_CALLS: join(dir, 'calls.jsonl'), UI_PROFILE: 'B' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('betikli uç açılmadı')), 5000);
    // Hazır satırı tam satır olarak ayrıştırılır: stdout parçalı gelse de kapı numarası satır sonuna kadar beklenir.
    let pending = '';
    child.stdout.on('data', (chunk) => {
      pending += String(chunk);
      for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        const match = /^betikli uç hazır: (\d+)\s*$/u.exec(line);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      }
    });
    child.once('error', reject);
  });
  const { questions } = await (await fetch(`http://127.0.0.1:${port}/v1/scripted-plans`)).json();
  const scenarios = JSON.parse(readFileSync('scripts/ui-acceptance/scenarios/B.json', 'utf8')).conversations;
  const seeded = scenarios.filter((item) => item.seed === 'executive');
  assert.ok(seeded.length >= 5);
  // Yönetici verisi isteyen her konuşmanın her turu betikli plana sahiptir; diğer konuşmaların planı yoktur (model kabulü ister).
  for (const item of seeded) assert.ok(item.turns.every((text) => questions.includes(text)), item.name);
  assert.ok(scenarios.some((item) => !item.turns.every((text) => questions.includes(text))));
  // Plansız soru: uç açıklama kararı döndürür ve çağrıyı `unscripted` olarak işaretler.
  const ask = (content) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content }] }) }).then((response) => response.json());
  assert.match((await ask('altın planı olmayan soru')).choices[0].message.tool_calls[0].function.arguments, /"clarify"/u);
  assert.doesNotMatch((await ask(seeded[0].turns[0])).choices[0].message.tool_calls[0].function.arguments, /"clarify"/u);
  const calls = readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(calls.map((call) => call.unscripted === true), [true, false]);
  // Geçerli HTTP gövdesindeki bozuk düzen iletisi (geçersiz JSON görünüm) istemci hatasıdır: uç çökmez, sonraki istek yanıtlanır.
  const malformed = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'OLGU SAYFASI (yalnızca veri):\n{bozuk' }] }) });
  assert.equal(malformed.status, 400);
  assert.doesNotMatch((await ask(seeded[0].turns[0])).choices[0].message.tool_calls[0].function.arguments, /"clarify"/u, 'uç ayakta kalır');
  // Sürücü plansız konuşmayı eksik kapsam satırıyla korur; kısmi koşu tam kabul sayılmaz.
  const scenario = { profile: 'B', port: 8102, appLog: 'app-B.log', conversations: [
    { name: 'planlı', detail: 'balanced', turns: [seeded[0].turns[0]] }, { name: 'plansız', detail: 'balanced', turns: ['altın planı olmayan soru'] }] };
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario));
  const playwright = join(dir, 'node_modules', 'playwright', 'index.js');
  const original = readFileSync(playwright, 'utf8');
  const withCall = (extra) => writeFileSync(playwright, original.replace("return {status:'complete'",
    `fs.appendFileSync(path.join(process.env.UI_ACCEPTANCE_DIR,'calls.jsonl'),JSON.stringify({purpose:'plan',ok:true,scripted:true,${extra}toolCalls:['rota_plan']})+'\\n');\n return {status:'complete'`));
  withCall('');
  const driven = await new Promise((resolve) => {
    const proc = spawn(process.execPath, [join(dir, 'drive.cjs'), join(dir, 'scenario.json'), join(dir, 'out')], { env: { ...process.env, UI_ACCEPTANCE_DIR: dir, UI_RUN_ID: 'güncel', UI_SCRIPTED: '1', BRIDGE_PORT: String(port) } });
    let stdout = ''; proc.stdout.on('data', (chunk) => { stdout += chunk; }); proc.on('close', (status) => resolve({ status, stdout }));
  });
  assert.equal(driven.status, 1, driven.stdout);
  assert.match(driven.stdout, /betikli kapsam: B 1\/2 konuşma/u);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'out', 'B.json'), 'utf8')).map((row) => [row.conversation, row.scripted]), [['plansız', undefined], ['planlı', true]]);
  // Kapsamdaki bir turda uç plan bulamadıysa (çağrı kaydı `unscripted`) tur başarısızdır.
  withCall('unscripted:true,');
  const failed = await new Promise((resolve) => {
    const proc = spawn(process.execPath, [join(dir, 'drive.cjs'), join(dir, 'scenario.json'), join(dir, 'out')], { env: { ...process.env, UI_ACCEPTANCE_DIR: dir, UI_RUN_ID: 'güncel', UI_SCRIPTED: '1', BRIDGE_PORT: String(port) } });
    proc.on('close', (status) => resolve({ status }));
  });
  assert.equal(failed.status, 1);
  assert.ok(JSON.parse(readFileSync(join(dir, 'out', 'B.json'), 'utf8')).at(-1).failures.includes('betikli plan yok'));
});

test('belirli tablo beklentisi istenen sütunlu, satırlı ve görünür tabloyu ister; başka tablo yetmez', async () => {
  const { semanticFailures } = (await import('../scripts/ui-acceptance/expectations.cjs')).default;
  const expected = { tableHead: ['Görev', 'Termin'] };
  assert.ok(semanticFailures(expected, { tables: [{ rows: 7, visible: true, head: ['Kişi', 'Açık görev'] }] }, { outcome: 'grounded' }).length > 0, 'özetin kişi tablosu yetmez');
  assert.deepEqual(semanticFailures(expected, { tables: [{ rows: 7, visible: true, head: ['Kişi'] }, { rows: 5, visible: true, head: ['Görev', 'Termin'] }] }, { outcome: 'grounded' }), []);
});

test('betikli sunucu yeniden yürütmesi düz metin plan çağrısını da reddeder; olağan tur plan gerektirir', async () => {
  const { replayFailures } = (await import('../scripts/ui-acceptance/expectations.cjs')).default;
  const trace = { outcome: 'grounded', evidence: 1 };
  for (const ok of [true, false]) assert.ok(replayFailures({ serverReplay: true }, trace, [{ purpose: 'plan', ok, toolCalls: [] }]).length);
  assert.ok(replayFailures(null, trace, [{ purpose: 'compose', ok: true, toolCalls: [] }]).length);
});

test('istenen tema uygulanmadığında sürücü yanlış temayı kabul kanıtı saymaz', (t) => {
  const dir = fakeDriverDir(t);
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ profile: 'B', port: 8102, appLog: 'app-B.log', conversations: [] }));
  const result = run(join(dir, 'drive.cjs'), [join(dir, 'scenario.json'), join(dir, 'out')], { UI_ACCEPTANCE_DIR: dir, UI_THEME: 'dark' });
  assert.equal(result.status, 1); assert.match(result.stderr, /istenen tema uygulanmadı/);
});

test('betikli köprü yazılamayan çağrı kaydından sonra ayakta kalır', async (t) => {
  const dir = directory(t);
  const child = spawn(process.execPath, ['scripts/ui-acceptance/scriptedBridge.mjs'], { cwd: root, env: { ...process.env, BRIDGE_PORT: '0', BRIDGE_CALLS: join(dir, 'olmayan', 'calls.jsonl'), UI_PROFILE: 'B' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('betikli uç açılmadı')), 5000); let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; const match = /betikli uç hazır: (\d+)\n/u.exec(output); if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
    child.once('error', reject);
  });
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'Türkçe soru' }] }) });
  assert.equal(response.status, 500);
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/models`)).status, 200);
});

test('not rızası anahtarı gizliyken sürücü veri önkoşulunu bildirir ve soru göndermez', (t) => {
  const dir = directory(t); mkdirSync(join(dir, 'node_modules', 'playwright'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'playwright', 'index.js'), `
const fs=require('fs');
const locator={first(){return this},getByRole(){return this},isVisible:async()=>false,click:async()=>{},getAttribute:async()=> 'true',waitFor:async()=>{},count:async()=>0,fill:async()=>{fs.writeFileSync(process.env.UI_ACCEPTANCE_DIR+'/gonderim','soru');throw Error('soru gönderildi')},screenshot:async()=>{}};
const page={goto:async()=>{},getByRole:()=>locator,locator:()=>locator,waitForTimeout:async()=>{}};
exports.chromium={launch:async()=>({newContext:async()=>({newPage:async()=>page}),close:async()=>{}})};`);
  for (const file of ['drive.cjs', 'expectations.cjs']) copyFileSync(resolve(`scripts/ui-acceptance/${file}`), join(dir, file));
  const scenario = { profile: 'B', port: 8102, appLog: 'app.log', conversations: [{ name: 'rıza', detail: 'balanced', turns: ['Notları oku'], includeText: [0] }] };
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario));
  // Üst kabuğun görünüm değişkeni (ör. UI_VIEWPORT=mobile) sınamayı etkilemez.
  const result = run(join(dir, 'drive.cjs'), [join(dir, 'scenario.json'), join(dir, 'out')], { UI_ACCEPTANCE_DIR: dir, UI_THEME: '', UI_VIEWPORT: '', UI_SCRIPTED: '', UI_ONLY: '', UI_SEED_GROUPS: '', UI_SEED: '' });
  assert.equal(result.status, 1, result.stderr);
  const row = JSON.parse(readFileSync(join(dir, 'out', 'B.json')))[0];
  assert.equal(row.rendered.status, 'driver-error');
  assert.match(row.rendered.error, /Rota verisi kapalı/);
  assert.ok(!readdirSync(dir).includes('gonderim'));
});

// Köprü sınamaya verilen SABİT günle çalışır (gece yarısı yarışı yok); gün devri ayrı sınamada 409 olarak denetlenir.
async function scriptedBridge(t, benchmark, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rota-kopru-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'benchmark.json'), JSON.stringify(benchmark));
  const child = spawn(process.execPath, ['scripts/ui-acceptance/scriptedBridge.mjs'], { cwd: root, env: { ...process.env, BRIDGE_PORT: '0', BRIDGE_CALLS: '', BRIDGE_ENFORCE_DAY: '', UI_PROFILE: 'B', UI_BENCHMARK: join(dir, 'benchmark.json'), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  return new Promise((done, fail) => {
    let settled = false;
    const settle = (fn, val) => { if (!settled) { settled = true; clearTimeout(timer); fn(val); } };
    const timer = setTimeout(() => settle(fail, new Error('betikli uç açılmadı')), 5000); let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; const match = /betikli uç hazır: (\d+)\n/u.exec(output); if (match) settle(done, Number(match[1])); });
    child.once('error', (err) => settle(fail, err));
  });
}

const bridgeBenchmark = { targeted: [{ id: 'k1', profile: 'B', text: 'T projesinde dün ve bugün neler tamamlandı?',
  plan: { intent: 'rota', language: 'tr', analysis: { scope: 'project', names: ['T'], focus: ['completed'], dateFrom: 'T-1', dateTo: 'T' } } }] };

test('betikli uç göreli günü yalnızca tarih alanlarında çözer; "T" adlı proje adı değişmez', async (t) => {
  const port = await scriptedBridge(t, bridgeBenchmark, { BRIDGE_TODAY: '2026-09-30' });
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: bridgeBenchmark.targeted[0].text }] }) });
  const plan = JSON.parse((await response.json()).choices[0].message.tool_calls[0].function.arguments);
  assert.deepEqual(plan.analysis.names, ['T']);
  assert.equal(plan.analysis.dateTo, '2026-09-30');
  // Başlangıç da çözülür: bir önceki İstanbul günü (çözülmeden geçen "T-1" kabul edilmez).
  assert.equal(plan.analysis.dateFrom, '2026-09-29');
});

test('betikli uç gün devrinde boş 409 döndürür (eski güne göre çözülmüş plan verilmez)', async (t) => {
  const port = await scriptedBridge(t, bridgeBenchmark, { BRIDGE_TODAY: '2000-01-01', BRIDGE_ENFORCE_DAY: '1' });
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: bridgeBenchmark.targeted[0].text }] }) });
  assert.equal(response.status, 409);
  assert.equal(await response.text(), '');
  // Koşu tohumu ve betikli ucu tek günle başlatır: uç gün değişimini denetler, tohumlar dışa aktarılan aynı günü okur.
  const runner = readFileSync(join(root, 'scripts/ui-acceptance/run.sh'), 'utf8');
  assert.match(runner, /\bexport UI_RUN_DAY\b/);
  assert.match(runner, /UI_RUN_DAY=\$\(TZ=Europe\/Istanbul date \+%F\)/);
  assert.match(runner, /BRIDGE_TODAY=\$UI_RUN_DAY BRIDGE_ENFORCE_DAY=1 /);
  assert.match(readFileSync(join(root, 'scripts/ui-acceptance/uiSeed.mjs'), 'utf8'), /process\.env\.UI_RUN_DAY/);
});

test('görsel kabulün dönem denetimi sunucunun aralık yazımını bekler ve daha kısa dönemi geçirmez', async () => {
  const { periodLabel, semanticFailures } = await import('../scripts/ui-acceptance/expectations.cjs');
  const now = new Date(Date.UTC(2026, 8, 30, 9));
  assert.equal(periodLabel(90, now), '3 Temmuz – 30 Eylül 2026');
  const trace = { outcome: 'grounded' };
  assert.deepEqual(semanticFailures({ periodDays: 90 }, { text: `Tamamlanmış görevler ${periodLabel(90, now)} döneminde` }, trace, now), []);
  assert.ok(semanticFailures({ periodDays: 90 }, { text: `Tamamlanmış görevler ${periodLabel(30, now)} döneminde` }, trace, now).length);
  // Aynı soneki taşıyan daha kısa dönem (80 gün) de geçmez.
  assert.ok(semanticFailures({ periodDays: 90 }, { text: `Tamamlanmış görevler 1${periodLabel(90, now)} döneminde` }, trace, now).length);
  // this_week ve this_month_vs_last_month yalnızca genel dönem kelimesiyle geçemez; çözümlenmiş takvim tarihleri zorunludur.
  assert.deepEqual(semanticFailures({ periodKind: 'this_week' }, { text: 'Bu hafta (28 Eylül – 4 Ekim 2026) projelerinizde 3 hareket kaydedildi.' }, trace, now), []);
  assert.ok(semanticFailures({ periodKind: 'this_week' }, { text: 'Bu hafta (24–30 Eylül 2026) projelerinizde 3 hareket kaydedildi.' }, trace, now).includes('istenen hafta dönemi görünmüyor: this_week'));
  assert.ok(semanticFailures({ periodKind: 'this_month_vs_last_month' }, { text: 'Geçen ay 4 görev, bu ay 6 görev tamamlandı.' }, trace, now).includes('istenen ay karşılaştırma dönemleri görünmüyor'));
  // Grafik türü ve içeriği AYNI görünür grafikte doğrulanır: ayrı bir çubuk grafik 12 noktalı çizgi grafik beklentisini karşılayamaz.
  const splitCharts = [{ type: 'line', visible: true, title: 'Kısa çizgi', items: ['a', 'b', 'c', 'd'] },
    { type: 'bar', visible: true, title: 'Tamamlanan görev', items: Array.from({ length: 12 }, (_, i) => `H${i + 1}`) }];
  assert.ok(semanticFailures({ chartMinItems: 12 }, { text: 'ok', charts: splitCharts }, trace, now, 'line').length);
  assert.deepEqual(semanticFailures({ chartMinItems: 12 }, { text: 'ok', charts: [{ ...splitCharts[1], type: 'line' }] }, trace, now, 'line'), []);
});

test('arayüz kabulü iki dönemin ölçüsünü, yanıt dilini ve geçmiş durum sınırını birlikte denetler', async () => {
  const { semanticFailures } = await import('../scripts/ui-acceptance/expectations.cjs');
  const now = new Date(Date.UTC(2026, 8, 30, 9));
  const scenarios = JSON.parse(readFileSync(join(root, 'scripts/ui-acceptance/scenarios/B.json'))).conversations;
  const score = (name, text, charts = []) => semanticFailures(scenarios.find((item) => item.name === name).expectedTurns[0], { text, charts }, { outcome: 'grounded' }, now, scenarios.find((item) => item.name === name).expectedCharts?.[0]);
  const turkish = 'Geçen ay (Ağustos 2026) görebildiğiniz işlerde 5 görev tamamlanmıştı; bu ay (Eylül 2026) şu ana kadar 8 görev tamamlandı.';
  assert.deepEqual(score('H2-donem-kiyasi', turkish), []);
  assert.deepEqual(score('H2-donem-kiyasi', 'Tamamlanan iş sayıları karşılaştırılamıyor: Ağustos 2026 için görev sayısı bilinmiyor; sıfır sayılmadı; öteki dönemde (Eylül 2026) 8 görev var.'), []);
  assert.ok(score('H2-donem-kiyasi', 'İki dönemde de (Dün ve bugün) 4 görev tamamlandı.').length);
  assert.ok(score('H2-donem-kiyasi', 'Geçen ay için karşılaştırma yapılmadı; bu ay 8 görev tamamlandı.').length);
  assert.deepEqual(score('H7-ingilizce', 'Last month (August 2026), across the tasks you can see, completed tasks totalled 5; this month (September 2026) so far, 8.'), []);
  assert.ok(score('H7-ingilizce', 'Last month 5 görev tamamlandı; this month 8 görev tamamlandı.').length);
  const limited = 'Geçen haftanın durumu yeniden kurulamıyor ve karşılaştırma yapılmadı; aşağıdaki sayılar bugünü gösterir. Şu anda 3 gecikmiş görev var.';
  assert.deepEqual(score('H2-gecmis-durum-siniri', limited), []);
  assert.deepEqual(score('H2-gecmis-durum-siniri', limited + ' Gecikmeleriniz azaldı denemez.'), []);
  assert.ok(score('H2-gecmis-durum-siniri', limited + ' Ancak gecikmeleriniz azaldı.').length);
  assert.ok(score('H2-gecmis-durum-siniri', limited + ' Geçen haftaya göre daha az gecikmiş işiniz var.').length);
  assert.ok(score('H2-gecmis-durum-siniri', limited + ' Geçen hafta 3 gecikmiş görev vardı.').length);
  assert.ok(score('H2-gecmis-durum-siniri', limited + ' Geçen haftaki gecikmiş görev sayısı: 8.').length);
  const week = 'Geçen hafta (21–27 Eylül 2026) için ';
  assert.ok(score('H1-gecen-hafta', week + 'gerçekleşen bitiş tarihine göre bir sonuç sunamıyorum.').length);
  assert.deepEqual(score('H1-gecen-hafta', week + '4 görev tamamlandı (gerçekleşen bitiş tarihine göre).'), []);
  const activity = 'Bu hafta (28 Eylül – 4 Ekim 2026) siz 3 hareket kaydettiniz; ekibiniz 8 hareket kaydetti. Sayılar toplanmaz.';
  assert.deepEqual(score('H6-ic-ice-kapsam', activity), []);
  assert.ok(score('H6-ic-ice-kapsam', activity + ' Birleşik hareket sayısı: 11.').length);
  assert.deepEqual(score('H2-donem-kiyasi', turkish + ' Ayrıca 5 Eylül 2026 tarihli iş açık.'), []);
  assert.ok(score('H2-gecmis-durum-siniri', 'Geçen haftanın durumu yeniden kurulamıyor.').length);
  // H3-egilim-cizgisi hareket çizgi grafiğini tamamlanma eğilimi olarak kabul etmez.
  const trendText = 'Tamamlanmış görevler 3 Temmuz – 30 Eylül 2026 döneminde haftalık tamamlanma hızı en yüksek 14–20 Eylül 2026 haftasındaydı.';
  const items12 = Array.from({ length: 12 }, (_, i) => `H${i + 1}`);
  assert.ok(score('H3-egilim-cizgisi', trendText, [{ type: 'line', visible: true, title: 'Haftalara göre hareket', items: items12 }]).length);
  assert.deepEqual(score('H3-egilim-cizgisi', trendText, [{ type: 'line', visible: true, title: 'Haftalara göre tamamlanan görev', items: items12 }]), []);
});

test('kabul tohumları tek Türkiye gününü paylaşır ve geçersiz takvim gününü reddeder', async (t) => {
  const { temporalBenchmarkSeed } = await import('./helpers/temporalBenchmarkSeed.mjs');
  const { uiRunDay } = await import('../scripts/ui-acceptance/uiSeed.mjs');
  const previous = process.env.UI_RUN_DAY;
  t.after(() => { if (previous == null) delete process.env.UI_RUN_DAY; else process.env.UI_RUN_DAY = previous; });
  for (const value of ['2026-13-01', '2026-02-29']) {
    process.env.UI_RUN_DAY = value;
    assert.throws(uiRunDay, /UI_RUN_DAY/);
  }
  process.env.UI_RUN_DAY = '2026-11-18';
  assert.deepEqual(temporalBenchmarkSeed(), temporalBenchmarkSeed('2026-11-18'));
  const base = temporalBenchmarkSeed('2026-11-18');
  const next = temporalBenchmarkSeed('2026-11-19');
  for (let index = 0; index < base.tasks.length; index += 1) {
    if (base.tasks[index].TargetFinish) assert.equal(Date.parse(next.tasks[index].TargetFinish) - Date.parse(base.tasks[index].TargetFinish), 86400000);
    else assert.equal(next.tasks[index].TargetFinish, base.tasks[index].TargetFinish);
  }
});

test('çoklu tohum koşusu sonuçları ezmez, UI_APP_LOG günlüğünü okur ve betikli köprü G/H kıyas kümelerini birlikte sunar', async (t) => {
  const dir = fakeDriverDir(t);
  const playwright = join(dir, 'node_modules', 'playwright', 'index.js');
  writeFileSync(playwright, readFileSync(playwright, 'utf8')
    .replace("path.join(process.env.UI_ACCEPTANCE_DIR,'app-B.log')", "(process.env.UI_APP_LOG||path.join(process.env.UI_ACCEPTANCE_DIR,'app-B.log'))")
    .replace("evidence:1", "evidence:process.env.UI_SEED==='base'?1:2")
    .replace("return {status:'complete'",
      "fs.appendFileSync(path.join(process.env.UI_ACCEPTANCE_DIR,'calls.jsonl'),JSON.stringify({purpose:'plan',ok:true,toolCalls:['rota_plan'],models:['claude-haiku-4-5-20251001'],thinking:'off',thinkingTokens:0})+'\\n');\n return {status:'complete'"));
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({
    profile: 'B', port: 8102, appLog: 'app-B.log',
    conversations: [
      { name: 'g-tohumsuz', detail: 'balanced', turns: ['Bölümümün durumu nedir?'] },
      { name: 'h-tohumlu', seed: 'temporal', detail: 'balanced', turns: ['Bu hafta neler değişti?'] }
    ]
  }));
  const firstPass = run(join(dir, 'drive.cjs'), [join(dir, 'scenario.json'), join(dir, 'out')], {
    UI_ACCEPTANCE_DIR: dir, UI_RUN_ID: 'coklu', UI_SCRIPTED: '', UI_SEED: 'base', UI_SEED_GROUPS: '1', UI_ONLY: '', UI_THEME: '', UI_APP_LOG: join(dir, 'app-B-base.log')
  });
  assert.equal(firstPass.status, 0, firstPass.stderr);
  const rows = () => JSON.parse(readFileSync(join(dir, 'out', 'B.json'), 'utf8'));
  const firstRow = rows().find(({ conversation }) => conversation === 'g-tohumsuz');
  assert.equal(firstRow?.server?.evidence, 1);
  const secondPass = run(join(dir, 'drive.cjs'), [join(dir, 'scenario.json'), join(dir, 'out')], {
    UI_ACCEPTANCE_DIR: dir, UI_RUN_ID: 'coklu', UI_SCRIPTED: '', UI_SEED: 'temporal', UI_SEED_GROUPS: '1', UI_ONLY: '', UI_THEME: '', UI_APP_LOG: join(dir, 'app-B-temporal.log')
  });
  assert.equal(secondPass.status, 0, secondPass.stderr);
  const combined = rows();
  assert.deepEqual(combined.map((row) => [row.conversation, row.failures.length]), [['g-tohumsuz', 0], ['h-tohumlu', 0]]);
  assert.deepEqual(combined[0], firstRow);
  assert.equal(combined[1].server?.evidence, 2);

  // Betikli köprü UI_BENCHMARK verilmediğinde hem G (executive) hem H (temporal) sorularının gerçek altın planlarını döndürür.
  const child = spawn(process.execPath, ['scripts/ui-acceptance/scriptedBridge.mjs'], {
    cwd: root,
    env: { ...process.env, BRIDGE_PORT: '0', BRIDGE_CALLS: '', BRIDGE_ENFORCE_DAY: '', UI_PROFILE: 'B', UI_BENCHMARK: '', BRIDGE_TODAY: '2026-09-30' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => child.kill());
  const port = await new Promise((done, fail) => {
    let settled = false;
    const settle = (fn, val) => { if (!settled) { settled = true; clearTimeout(timer); fn(val); } };
    const timer = setTimeout(() => settle(fail, new Error('betikli uç açılmadı')), 5000); let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; const match = /betikli uç hazır: (\d+)\n/u.exec(output); if (match) settle(done, Number(match[1])); });
    child.once('error', (err) => settle(fail, err));
  });
  for (const [question, expectedScope] of [
    ['Direktörlüğümde bugün yönetimin öncelikle ilgilenmesi gereken üç konu nedir? Neden?', 'team'],
    ['Bu hafta projelerimde hangi önemli gelişmeler oldu?', 'projects']
  ]) {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: question }] })
    });
    const body = await res.json();
    const call = body.choices?.[0]?.message?.tool_calls?.[0];
    assert.ok(call, `köprü soruyu bulamadı: ${question}`);
    const plan = JSON.parse(call.function.arguments);
    assert.equal(plan.intent, 'rota', `köprü açıklama yerine altın rota planını döndürmelidir: ${question}`);
    assert.equal(plan.analysis?.scope, expectedScope, `köprü beklenen kapsamı döndürmelidir: ${question}`);
  }
});

test('dönem ve geçmiş durum beklentileri kısmi ay aralığını, yer değiştirmiş ayları, kayan 7 günü ve geçmiş gecikme iddialarını reddeder', async () => {
  const { semanticFailures } = await import('../scripts/ui-acceptance/expectations.cjs');
  const nov20 = new Date('2026-11-20T09:00:00Z');
  const sep30 = new Date('2026-09-30T09:00:00Z');
  const okTrace = { outcome: 'grounded', evidence: 2 };
  // Kısmi ay aralıkları ("1–10 Ekim 2026 / 1–10 Kasım 2026") ve yalın ay adıyla karıştırılmış kısmi aralık reddedilir.
  assert.ok(semanticFailures({ periodKind: 'this_month_vs_last_month' }, { text: '1–10 Ekim 2026 ve 1–10 Kasım 2026 tamamlandı.' }, okTrace, nov20).length > 0);
  assert.ok(semanticFailures({ periodKind: 'this_month_vs_last_month' }, { text: 'Ekim 2026 özeti: 1–10 Ekim 2026 / 1–10 Kasım 2026.' }, okTrace, nov20).length > 0);
  assert.deepEqual(semanticFailures({ periodKind: 'this_month_vs_last_month' }, { text: 'Geçen ay (Ekim 2026) 4 görev tamamlanmıştı; bu ay (1–30 Kasım 2026) 6 görev tamamlandı.' }, okTrace, nov20), []);
  assert.ok(semanticFailures({ periodKind: 'this_month_vs_last_month' }, { text: '1 Ekim 2026; 2 Ekim 2026; 1 Kasım 2026; 2 Kasım 2026' }, okTrace, nov20).length > 0);
  assert.deepEqual(semanticFailures({ periodKind: 'this_month_vs_last_month' }, { text: '1–31 Ekim 2026 ile 1–30 Kasım 2026 karşılaştırıldı. Bir işin tarihi 5 Kasım 2026.' }, okTrace, nov20), []);
  // Yer değiştirmiş aylar ("Geçen ay (Eylül 2026) ... bu ay (Ağustos 2026)") reddedilir.
  assert.ok(semanticFailures({ periodKind: 'this_month_vs_last_month' }, { text: 'Geçen ay (Eylül 2026) 5 görev tamamlanmıştı; bu ay (Ağustos 2026) 8 görev tamamlandı.' }, okTrace, sep30).length > 0);
  // Geçen hafta (21–27 Eylül 2026) beklentisi kayan 7 günü (24–30 Eylül 2026) reddeder.
  assert.ok(semanticFailures({ periodKind: 'last_week' }, { text: 'Geçen hafta (24–30 Eylül 2026) 4 görev tamamlandı.' }, okTrace, sep30).length > 0);
  assert.deepEqual(semanticFailures({ periodKind: 'last_week' }, { text: 'Geçen hafta (21–27 Eylül 2026) 4 görev tamamlandı.' }, okTrace, sep30), []);
  // H2-gecmis-durum-siniri yeni yasak kalıpları: iyelikli geçmiş gecikme, ölçü sonrası sayı ve "düştü" iddiası reddedilir; açık belirsizlik geçer.
  const bScenario = JSON.parse(readFileSync(join(root, 'scripts/ui-acceptance/scenarios/B.json'), 'utf8'));
  const historyLimit = bScenario.conversations.find((c) => c.name === 'H2-gecmis-durum-siniri').expectedTurns[0];
  const validBase = 'Geçmişteki durum yeniden kurulamıyor; aşağıdaki sayılar bugünü gösterir. Bugün 2 gecikmiş görev var. Gecikmeleriniz azaldı denemez.';
  assert.deepEqual(semanticFailures(historyLimit, { text: validBase }, okTrace, sep30), []);
  assert.ok(semanticFailures(historyLimit, { text: `${validBase} Geçen hafta 3 göreviniz gecikmişti.` }, okTrace, sep30).length > 0);
  assert.ok(semanticFailures(historyLimit, { text: `${validBase} Önceki haftanın gecikmiş görev sayısı 8'di.` }, okTrace, sep30).length > 0);
  assert.ok(semanticFailures(historyLimit, { text: `${validBase} Geciken görev sayısı geçen haftaya göre düştü.` }, okTrace, sep30).length > 0);
});

