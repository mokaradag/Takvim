import 'server-only';
import { AI_ERROR_CODES } from '../../../domain/ai/aiErrorCatalog.js';
import { AiError } from '../aiErrors.js';

/**
 * OpenAI uyumlu sağlayıcı bağdaştırıcısı (kurum içi yapay zekâ ağ geçidi).
 *
 * Sonuç ya düzgün bir yanıt ya da kararlı bir AiError'dır. Hata yanıtının
 * GÖVDESİ okunmaz (anahtarı ya da istek içeriğini yankılayabilir); karar
 * yalnızca HTTP durumuna dayanır. Bağlantılar Node'un yerleşik `fetch`
 * havuzunda yeniden kullanılır.
 */

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RETRY_AFTER_SECONDS = 300;
const MAX_MODEL_IDS = 2000;
const MAX_MODEL_ID_LENGTH = 200;
/**
 * Bağlantı hiç kurulamadı: istek sağlayıcıya ulaşmadı, yinelemek iş çoğaltmaz.
 * Ad çözümü, yönlendirme/arabirim ve bağlantı kurma hataları bu sınıftadır.
 * Bağlantı kurulduktan SONRA oluşabilen belirsiz hatalar (`ECONNRESET`,
 * `ETIMEDOUT`, `EPIPE`) bilinçli olarak dışarıda kalır.
 */
const CONNECT_FAILURE_CODES = new Set([
  'ECONNREFUSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'EHOSTDOWN',
  'EADDRNOTAVAIL'
]);
const NETWORK_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,40}$/;

function invalidResponse(reason) {
  return new AiError(AI_ERROR_CODES.AI_PROVIDER_RESPONSE_INVALID, { details: { reason } });
}

function parseRetryAfter(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const seconds = /^\d+$/.test(text) ? Number(text) : Math.ceil((Date.parse(text) - Date.now()) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(MAX_RETRY_AFTER_SECONDS, seconds) * 1000;
}

/** HTTP durumunu kararlı hata koduna indirger. */
export function classifyProviderStatus(status, retryAfterHeader = null) {
  const details = { providerStatus: status };
  if (status === 401) return new AiError(AI_ERROR_CODES.AI_KEY_INVALID, { details });
  if (status === 403) return new AiError(AI_ERROR_CODES.AI_UNAUTHORIZED, { details });
  if (status === 429) {
    return new AiError(AI_ERROR_CODES.AI_RATE_LIMITED, { details, retryAfterMs: parseRetryAfter(retryAfterHeader) });
  }
  if (status === 408 || status === 504) return new AiError(AI_ERROR_CODES.AI_TIMEOUT, { details });
  if (status === 400 || status === 413 || status === 422) return new AiError(AI_ERROR_CODES.AI_REQUEST_INVALID, { details });
  // Bulunamayan uç/model ya da yönlendirme dağıtım yapılandırmasının hatasıdır.
  if (status === 404 || (status >= 300 && status < 400)) return new AiError(AI_ERROR_CODES.AI_CONFIGURATION_ERROR, { details });
  if (status >= 500) return new AiError(AI_ERROR_CODES.AI_PROVIDER_UNAVAILABLE, { details });
  return new AiError(AI_ERROR_CODES.AI_PROVIDER_RESPONSE_INVALID, { details });
}

function networkCode(error) {
  const code = String(error?.cause?.code || error?.code || '');
  return NETWORK_CODE_PATTERN.test(code) ? code : null;
}

/** Ağ katmanı hatası: yalnızca kararlı sistem kodu taşınır, ileti ve adres taşınmaz. */
export function classifyNetworkFailure(error) {
  const code = networkCode(error);
  return new AiError(AI_ERROR_CODES.AI_PROVIDER_UNAVAILABLE, {
    details: { reason: 'NETWORK', ...(code ? { networkCode: code } : {}) }
  });
}

/** Yalnızca isteğin sağlayıcıya HİÇ ulaşmadığı bağlantı hataları yinelenebilir. */
export function isConnectFailure(error) {
  return error instanceof AiError
    && error.code === AI_ERROR_CODES.AI_PROVIDER_UNAVAILABLE
    && CONNECT_FAILURE_CODES.has(error.details?.networkCode);
}

async function discardBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Gövde zaten kapanmış olabilir.
  }
}

async function readBoundedJson(response, maxBytes, signal) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardBody(response);
    throw invalidResponse('RESPONSE_TOO_LARGE');
  }
  const reader = response.body?.getReader();
  if (!reader) throw invalidResponse('EMPTY_RESPONSE');
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw invalidResponse('RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof AiError) throw error;
    throw new AiError(AI_ERROR_CODES.AI_PROVIDER_UNAVAILABLE, { details: { reason: 'RESPONSE_INTERRUPTED' } });
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw invalidResponse('MALFORMED_JSON');
  }
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Yanıt biçimini doğrular; beklenmeyen biçim sessizce kabul edilmez.
 *
 * Seçeneğin iletisi `assistant` rolünde olmalıdır: isteği yankılayan yanlış
 * yapılandırılmış bir vekilin `user` iletisi model yanıtı sayılmaz.
 */
export function parseChatCompletion(payload) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const message = choice?.message;
  if (!message || typeof message !== 'object') throw invalidResponse('MISSING_CHOICE');
  if (message.role !== 'assistant') throw invalidResponse('INVALID_ROLE');
  if (message.content != null && typeof message.content !== 'string') throw invalidResponse('INVALID_CONTENT');
  return {
    text: message.content ?? '',
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason.slice(0, 40) : null,
    // Sağlayıcı modeli bildirmediyse `null` kalır; yapılandırılan model yerine konmaz.
    model: typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim().slice(0, 200) : null,
    usage: {
      promptTokens: tokenCount(payload.usage?.prompt_tokens),
      completionTokens: tokenCount(payload.usage?.completion_tokens),
      totalTokens: tokenCount(payload.usage?.total_tokens)
    }
  };
}

/**
 * OpenAI uyumlu `GET /models` biçimi: `{ data: [{ id }, ...] }`.
 *
 * Liste en az bir BOŞ OLMAYAN model kimliği taşımalıdır: boş liste ya da boş
 * kimlikler kullanılabilir bir uç göstermez. Dönen kimlikler sınırlıdır ve
 * yalnızca sunucuda (yapılandırılan modelin uçta bulunduğunu doğrulamak için)
 * kullanılır. Geçersiz biçimde `null` döner.
 */
function modelIdsOf(payload) {
  if (!Array.isArray(payload?.data)) return null;
  if (!payload.data.every((entry) => entry != null && typeof entry === 'object' && typeof entry.id === 'string')) return null;
  const ids = payload.data.map((entry) => entry.id.trim()).filter(Boolean);
  if (!ids.length) return null;
  return ids.slice(0, MAX_MODEL_IDS).map((id) => id.slice(0, MAX_MODEL_ID_LENGTH));
}

function requestHeaders(apiKey, { json = false } = {}) {
  return {
    accept: 'application/json',
    ...(json ? { 'content-type': 'application/json' } : {}),
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
  };
}

export function createOpenAiCompatibleProvider({ fetchImpl = null, maxResponseBytes = MAX_RESPONSE_BYTES } = {}) {
  async function send(url, init, signal) {
    try {
      // Yönlendirme izlenmez: anahtar başka bir adrese taşınmamalıdır.
      return await (fetchImpl || globalThis.fetch)(url, { ...init, signal, cache: 'no-store', redirect: 'manual' });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw classifyNetworkFailure(error);
    }
  }

  return {
    kind: 'openai-compatible',

    async chatCompletion({ baseUrl, apiKey, model, messages, maxOutputTokens = null, signal }) {
      const response = await send(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: requestHeaders(apiKey, { json: true }),
        body: JSON.stringify({ model, messages, stream: false, ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}) })
      }, signal);
      if (!response.ok) {
        await discardBody(response);
        throw classifyProviderStatus(response.status, response.headers.get('retry-after'));
      }
      return parseChatCompletion(await readBoundedJson(response, maxResponseBytes, signal));
    },

    /**
     * Üretim yapmayan hafif erişim/anahtar denetimi.
     *
     * Hata yanıtında yalnızca HTTP durumu ve `Retry-After` döner; gövde
     * okunmaz. 2xx yanıtı ancak gövde SINIRLI ve boş olmayan geçerli bir model
     * listesiyse kabul edilir: yanlış adrese yönelmiş bir ters vekilin 200
     * dönen HTML sayfası ya da boş liste bir anahtarı "geçerli" gösteremez.
     * Başarılı yanıt, sınırlı model kimliklerini (`models`) de taşır.
     */
    async listModels({ baseUrl, apiKey = null, signal }) {
      const response = await send(`${baseUrl}/models`, { method: 'GET', headers: requestHeaders(apiKey) }, signal);
      if (!response.ok) {
        await discardBody(response);
        return { status: response.status, retryAfter: response.headers.get('retry-after') };
      }
      const models = modelIdsOf(await readBoundedJson(response, maxResponseBytes, signal));
      if (!models) throw invalidResponse('MODEL_LIST_INVALID');
      return { status: response.status, retryAfter: null, models };
    }
  };
}
