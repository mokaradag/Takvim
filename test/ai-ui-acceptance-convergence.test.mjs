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
    child.stdout.on('data', (chunk) => { const match = /betikli uç hazır: (\d+)/u.exec(String(chunk)); if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
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
  // Sürücü: kapsam satırıyla yazılır, plansız konuşma koşulmaz ve satır üretmez.
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
  assert.equal(driven.status, 0, driven.stdout);
  assert.match(driven.stdout, /betikli kapsam: B 1\/2 konuşma/u);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'out', 'B.json'), 'utf8')).map((row) => [row.conversation, row.scripted]), [['planlı', true]]);
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
