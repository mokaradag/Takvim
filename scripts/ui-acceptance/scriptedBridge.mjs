/**
 * Betikli görsel kabul ucu (yalnızca 127.0.0.1, model çağrısı YOK): OpenAI uyumlu yerel uç. Planlayıcı turunda kıyas kümesindeki
 * vakanın ALTIN planını (soru metniyle birebir eşleşme; eşleşmezse açıklama kararı), düzen turunda sınamaların kapsayan düzenini
 * döndürür. Gerçek uygulama, yetki, SQL ikizi, kanıt doğrulaması ve çizici sınanır; model kalitesi sınanmaz (çağrı kaydı
 * `scripted: true` taşır ve sürücü UI_SCRIPTED=1 ile model kabul denetimini uygulamaz). Model kotası harcamadan masaüstü/mobil,
 * açık/koyu görünüm kanıtı içindir; Haiku kabulünün yerine geçmez.
 *
 *   BRIDGE_PORT=18741 BRIDGE_CALLS=calls.jsonl UI_PROFILE=B UI_BENCHMARK=test/fixtures/bilgin-executive-benchmark.json node scripts/ui-acceptance/scriptedBridge.mjs
 */
import { appendFileSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { compositionView, coveringBlocks, isCompositionCall } from '../../test/helpers/compositionScenario.mjs';

const PORT = Number(process.env.BRIDGE_PORT || 18741);
const CALLS = process.env.BRIDGE_CALLS || null;
const benchmark = JSON.parse(readFileSync(process.env.UI_BENCHMARK || new URL('../../test/fixtures/bilgin-executive-benchmark.json', import.meta.url), 'utf8'));
// Göreli termin belirteçleri ("T+N") çalıştırma gününe (Türkiye günü) göre çözülür; sentetik veri de aynı güne göre kurulur.
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const shift = (offset) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
const resolved = (plan) => JSON.parse(JSON.stringify(plan).replace(/"T\+(-?\d+)"/g, (_, offset) => `"${shift(Number(offset))}"`));
// Aynı soru metni farklı profillerde farklı altın planla geçebilir (ör. g08/g09): UI_PROFILE verilirse yalnızca o profilin vakaları
// eşlenir. Aynı metne iki farklı plan kalırsa biri sessizce seçilmez: metin çakışma olarak işaretlenir ve yanıt açıklama kararıdır.
const PROFILE = process.env.UI_PROFILE || null;
const plans = new Map();
const collisions = new Set();
for (const item of [...(benchmark.scenarios || []), ...(benchmark.original || [])]) {
  if (PROFILE && item.profile && item.profile !== PROFILE) continue;
  for (const turn of item.turns || [{ text: item.text, plan: item.plan }]) {
    if (!turn.plan) continue;
    const key = String(turn.text).trim();
    const plan = resolved(turn.plan);
    if (plans.has(key) && JSON.stringify(plans.get(key)) !== JSON.stringify(plan)) collisions.add(key);
    plans.set(key, plan);
  }
}
for (const key of collisions) process.stderr.write(`çakışan altın plan (UI_PROFILE ile ayırın): ${key}\n`);

function reply(input) {
  const messages = (input.messages || []).map((message) => ({ role: message.role, content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '') }));
  if (isCompositionCall({ messages })) return { purpose: 'compose', message: { role: 'assistant', content: JSON.stringify(coveringBlocks(compositionView({ messages }))) } };
  const question = [...messages].reverse().find((message) => message.role === 'user')?.content?.trim() || '';
  const plan = (!collisions.has(question) && plans.get(question)) || { intent: 'clarify', language: 'tr', clarify: { reason: 'ambiguous' } };
  return { purpose: 'plan', message: { role: 'assistant', content: null, tool_calls: [{ id: `plan_${Date.now()}`, type: 'function', function: { name: 'rota_plan', arguments: JSON.stringify(plan) } }] } };
}

http.createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    if (request.url.startsWith('/v1/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'scripted' }] }));
      return;
    }
    let input = {};
    try { input = JSON.parse(body || '{}'); } catch { response.writeHead(400).end(); return; }
    // Geçerli JSON ama beklenmeyen biçim (dizi, mesajsız ya da mesajları dizi olmayan istek) istemci hatasıdır; uç çökmez.
    if (!input || typeof input !== 'object' || Array.isArray(input) || !Array.isArray(input.messages)
      || input.messages.some((message) => !message || typeof message !== 'object')) { response.writeHead(400).end(); return; }
    const { purpose, message } = reply(input);
    const finish = message.tool_calls ? 'tool_calls' : 'stop';
    if (CALLS) appendFileSync(CALLS, `${JSON.stringify({ at: new Date().toISOString(), purpose, ok: true, scripted: true, toolCalls: message.tool_calls ? ['rota_plan'] : [] })}\n`);
    if (input.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = message.tool_calls ? { role: 'assistant', tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) } : { role: 'assistant', content: message.content };
      response.write(`data: ${JSON.stringify({ id: 'scripted', object: 'chat.completion.chunk', model: input.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: 'scripted', object: 'chat.completion.chunk', model: input.model, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
      response.end('data: [DONE]\n\n');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'scripted', object: 'chat.completion', model: input.model, choices: [{ index: 0, message, finish_reason: finish }] }));
  });
}).listen(PORT, '127.0.0.1', () => process.stdout.write(`betikli uç hazır: ${PORT}\n`));
