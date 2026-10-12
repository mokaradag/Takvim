import 'server-only';
import { randomBytes } from 'node:crypto';
import { parseEvidenceResponse } from '../../../domain/ai/evidenceVerification.js';
import { parseToolArguments } from './toolArguments.js';
import { invalidArguments, TOOL_ERROR_CODES, ToolError } from './toolErrors.js';
import { TOOL_LIMITS } from './toolLimits.js';
import { requestSchema } from './requestDeclaration.js';
import { readKey } from './requestPopulation.js';

/**
 * Bir model yanıtının YÜRÜTME KÜMESİ: plan çağrıları ve aynı yanıttaki
 * doğrudan çağrılar birlikte, hiçbir SQL çalışmadan önce doğrulanır.
 *
 * Kayıtlı ve izinli araç, boyut sınırı, bağımsız değişken şeması, kapsam
 * denetimi, yinelemelerin ayıklanması, çağrı sınırları ve çakışmasız kimlik
 * tek geçişte uygulanır. Kümedeki tek bir çağrı geçersizse HİÇBİR çağrı
 * yürütülmez: geçersiz plan kısmi veri okutamaz. Kimlikleri sunucu verir;
 * sağlayıcının ya da planın kimlikleri çakışsa da döküm tutarlı kalır.
 */

/** Turun çağrı kimliği üreteci: döküm boyunca benzersiz ve sağlayıcı kimlik biçimine uygun. */
export function createCallIds() {
  const prefix = randomBytes(6).toString('hex');
  let next = 0;
  return () => `call_${prefix}_${(next += 1)}`;
}

/**
 * Bildirim ve ilk araç planı tek yerel çağrının bağımsız değişkenleridir. Araç
 * şemaları planda yinelenmez: araçlar aynı turda ayrıca sunulur ve plan
 * çağrıları ya `calls` içinde ya da aynı yanıtta doğrudan taşıyabilir.
 */
export function typedPlanningTool(catalog) {
  return { name: 'rota_plan', description: 'Veri okumadan türlü Rota isteğini bildir. calls isteğe bağlıdır: verilmezse sunucu okumaları istekten kurar. Araçları calls içinde ya da aynı yanıtta doğrudan da çağırabilirsin; asistan metni gerekmez.',
    parameters: { type: 'object', additionalProperties: false, required: ['intent', 'language'], properties: {
      intent: { type: 'string', enum: ['rota', 'general'] }, language: { type: 'string', enum: ['tr', 'en'] },
      request: { ...requestSchema(), required: [...requestSchema().required, 'population', 'layout'] },
      calls: { type: 'array', maxItems: TOOL_LIMITS.maxCallsPerRound * 2, items: {
        type: 'object', additionalProperties: false, required: ['name', 'arguments'], properties: {
          name: { type: 'string', enum: catalog.map((tool) => tool.name) },
          arguments: { type: 'object', description: 'Aynı adlı aracın parametre şemasına uyan bağımsız değişkenler.' }
        }
      } }
    } } };
}

/**
 * Bazı modeller iç içe nesneyi JSON metni olarak yazar (`"request": "{…}"`). Nesne ya da
 * dizi beklenen alandaki geçerli JSON metni çözülür; anlam yorumlanmaz, şema denetimi aynen uygulanır.
 */
const NESTED_PLAN_FIELDS = Object.freeze({ plan: ['request', 'calls'], request: ['metrics', 'population', 'entities', 'filters', 'fields', 'bindings', 'rank'] });

function decodedJson(value) {
  if (typeof value !== 'string' || !/^\s*[[{]/.test(value)) return value;
  try { return JSON.parse(value); } catch { return value; }
}

function decodeNestedJson(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return plan;
  const decoded = { ...plan };
  for (const key of NESTED_PLAN_FIELDS.plan) if (Object.hasOwn(decoded, key)) decoded[key] = decodedJson(decoded[key]);
  if (decoded.request && typeof decoded.request === 'object' && !Array.isArray(decoded.request)) {
    decoded.request = { ...decoded.request };
    for (const key of NESTED_PLAN_FIELDS.request) if (Object.hasOwn(decoded.request, key)) decoded.request[key] = decodedJson(decoded.request[key]);
  }
  if (Array.isArray(decoded.calls)) {
    decoded.calls = decoded.calls.map((item) => (item && typeof item === 'object' && !Array.isArray(item) ? { ...item, arguments: decodedJson(item.arguments) } : item));
  }
  return decoded;
}

/** Eski pencere yalnızca mevcut süzgeçlere çevrilir; ayrı anlam taşımaz. */
function normalizePlan(plan) {
  if (!plan || typeof plan !== 'object' || !Object.hasOwn(plan, 'window')) return plan;
  const { window, ...rest } = plan;
  if (!window || typeof window !== 'object' || Array.isArray(window) || !Object.keys(window).length
    || Object.entries(window).some(([key, value]) => !['period', 'dateFrom', 'dateTo'].includes(key) || typeof value !== 'string')
    || !rest.request || typeof rest.request !== 'object' || Array.isArray(rest.request)) throw invalidArguments(['$.plan:window']);
  const filters = rest.request.filters || {};
  if (Object.entries(window).some(([key, value]) => Object.hasOwn(filters, key) && filters[key] !== value)) throw invalidArguments(['$.filters:conflict']);
  return { ...rest, request: { ...rest.request, filters: { ...filters, ...window } } };
}

/**
 * Plan çağrısını açar: yalnızca biçim denetlenir; içindeki ve yanındaki araç
 * çağrıları `prepareExecutionSet` ile birlikte doğrulanır.
 * `{ plan: { intent, language, request }, calls }`.
 */
export function unpackTypedPlan(result) {
  const plans = result.toolCalls.filter((call) => call.name === 'rota_plan');
  if (plans.length !== 1 || plans[0].oversize) throw invalidArguments(['$.plan:single']);
  const [call] = plans;
  if (Buffer.byteLength(call.arguments || '', 'utf8') > TOOL_LIMITS.maxArgumentBytes) throw invalidArguments(['$.plan:tooLarge']);
  let plan;
  try { plan = JSON.parse(call.arguments); } catch { throw invalidArguments(['$.plan:json']); }
  plan = normalizePlan(decodeNestedJson(plan));
  const calls = plan?.calls ?? [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || Object.keys(plan).some((key) => !['intent', 'language', 'request', 'calls'].includes(key))
    || !['rota', 'general'].includes(plan.intent) || !['tr', 'en'].includes(plan.language) || !Array.isArray(calls)) throw invalidArguments(['$.plan:shape']);
  if (calls.length > TOOL_LIMITS.maxCallsPerRound * 2) throw invalidArguments(['$.calls:maxItems']);
  const planned = calls.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some((key) => !['name', 'arguments'].includes(key))
      || typeof item.name !== 'string' || !item.arguments || typeof item.arguments !== 'object' || Array.isArray(item.arguments)) throw invalidArguments([`$.calls[${index}]:shape`]);
    return { name: item.name, arguments: JSON.stringify(item.arguments), oversize: false };
  });
  const direct = result.toolCalls.filter((item) => item !== call);
  if (plan.intent === 'rota' && !plan.request) throw invalidArguments(['$.request:required']);
  if (plan.intent === 'general' && (planned.length || plan.request || direct.length)) throw invalidArguments(['$.plan:general']);
  return { plan: { intent: plan.intent, language: plan.language, ...(plan.request ? { request: plan.request } : {}) }, calls: [...planned, ...direct] };
}

/**
 * Yerel çağrı yerine asistan metni olarak dönen plan: tek JSON nesnesi
 * (`{"name":"rota_plan","arguments":{…}}`, planın kendisi ya da `calls` taşıyan
 * yönlendirme bildirimi; isteğe bağlı tek `<tool_call>` zarfı). Metin
 * yorumlanmaz; plan yerel çağrıyla aynı doğrulamadan geçer.
 */
export function textPlanCall(text) {
  const value = parseEvidenceResponse(String(text ?? '').trim().replace(/^<tool_call>\s*([\s\S]*?)\s*<\/tool_call>$/, '$1'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let args = null;
  if (value.name === 'rota_plan' && Object.keys(value).every((key) => ['name', 'arguments'].includes(key))) {
    try { args = typeof value.arguments === 'string' ? JSON.parse(value.arguments) : value.arguments; } catch { args = null; }
  } else if (Object.hasOwn(value, 'intent') && (value.kind === undefined || value.kind === 'route')) {
    const { kind: _kind, ...plan } = value;
    args = value.kind === 'route' && plan.language === undefined ? { ...plan, language: 'tr' } : plan;
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  return { id: 'plan', name: 'rota_plan', arguments: JSON.stringify(args), oversize: false };
}

/**
 * Yürütme kümesini SQL'den önce bütünüyle doğrular ve kanonik biçime getirir.
 * Sonuç `{ ok, calls, problems }`: `calls` yinelemesi ayıklanmış, kimliği
 * sunucunun verdiği çağrılardır (`{ id, name, arguments, args }`); `problems`
 * çağrı sırasıyla güvenli araç hatalarıdır. Sınır, ayıklanmış küme üzerinde
 * uygulanır; ham girdi ayrıca kötüye kullanıma karşı sınırlıdır.
 */
export function prepareExecutionSet(rawCalls, { catalog, permitted = null, validateCall = null, limits = TOOL_LIMITS, attempted = 0, callId, today }) {
  const problems = [];
  const prepared = [];
  if (rawCalls.length > limits.maxCallsPerRound * 2) {
    rawCalls.forEach((_, index) => problems.push({ index, error: new ToolError(TOOL_ERROR_CODES.LIMIT_EXCEEDED, { details: ['$.calls:maxItems'] }) }));
    return { ok: false, calls: [], problems };
  }
  const seen = new Map();
  rawCalls.forEach((call, index) => {
    const tool = catalog.find((item) => item.name === call?.name);
    if (!tool || (permitted && !permitted.has(tool.name))) {
      problems.push({ index, error: new ToolError(TOOL_ERROR_CODES.UNKNOWN_TOOL, { details: [`$.calls[${index}]:unknown`] }) });
      return;
    }
    if (call.oversize || Buffer.byteLength(String(call.arguments ?? ''), 'utf8') > limits.maxArgumentBytes) {
      problems.push({ index, error: invalidArguments([`$.calls[${index}]:tooLarge`]) });
      return;
    }
    let args;
    try {
      args = parseToolArguments(tool.parameters, String(call.arguments ?? '{}'));
      validateCall?.(tool.name, args);
    } catch (error) {
      const details = (error?.details || []).map((detail) => `$.calls[${index}].${tool.name}${String(detail).slice(1)}`);
      problems.push({ index, error: new ToolError(error?.code || TOOL_ERROR_CODES.INVALID_ARGUMENTS, { details: details.length ? details : [`$.calls[${index}]:${error?.code === TOOL_ERROR_CODES.UNSUPPORTED_SCOPE ? 'scope' : 'invalid'}`] }) });
      return;
    }
    // Aynı çağrı plan içinde ve doğrudan yinelenirse bir kez çalışır.
    const key = readKey(tool.name, args, today);
    if (seen.has(key)) return;
    seen.set(key, index);
    prepared.push({ index, name: tool.name, args, arguments: JSON.stringify(args) });
  });
  if (!problems.length && prepared.length > limits.maxCallsPerRound) {
    problems.push({ index: -1, error: new ToolError(TOOL_ERROR_CODES.LIMIT_EXCEEDED, { details: ['$.calls:maxItems'] }) });
  }
  if (!problems.length && attempted + prepared.length > limits.maxTotalCalls) {
    problems.push({ index: -1, error: new ToolError(TOOL_ERROR_CODES.LIMIT_EXCEEDED, { details: ['$.calls:budget'] }) });
  }
  if (problems.length) return { ok: false, calls: [], problems };
  return { ok: true, calls: prepared.map((call) => ({ id: callId(), name: call.name, arguments: call.arguments, args: call.args })), problems };
}

/** Reddedilen kümenin her çağrısının güvenli hatası: kendi sorunu ya da geçersiz kardeşi nedeniyle yürütülmedi. */
export function rejectionFor(problems, index) {
  const own = problems.find((problem) => problem.index === index);
  if (own) return own.error;
  const shared = problems.find((problem) => problem.index < 0);
  return shared ? shared.error : new ToolError(TOOL_ERROR_CODES.INVALID_ARGUMENTS, { details: ['$.round:rejected'] });
}
