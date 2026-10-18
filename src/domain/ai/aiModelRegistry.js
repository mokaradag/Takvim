/**
 * Yapay zekâ model ve yetenek kaydı — saf kurallar.
 *
 * İş kodu somut modeli değil PROFİLİ ister (`chat.fast` gibi). Profil → model
 * eşlemesi ve modelin yetenekleri yapılandırma verisidir: kurum içi model
 * dizisi değiştiğinde yalnızca kayıt belgesi değişir, iş kodu değişmez.
 */

export const AI_CAPABILITIES = Object.freeze({
  CHAT: 'chat',
  TOOLS: 'tools',
  REASONING: 'reasoning',
  VISION: 'vision',
  EMBEDDING: 'embedding',
  RERANK: 'rerank',
  SPEECH_TO_TEXT: 'speech.stt',
  TEXT_TO_SPEECH: 'speech.tts',
  IMAGE_GENERATION: 'image.generation'
});

export const AI_PROFILES = Object.freeze({
  CHAT_FAST: 'chat.fast',
  CHAT_GENERAL: 'chat.general',
  CHAT_REASONING: 'chat.reasoning',
  CHAT_TOOLS: 'chat.tools',
  CHAT_TOOLS_REASONING: 'chat.tools.reasoning',
  VISION: 'vision',
  EMBEDDING: 'embedding',
  RERANK: 'rerank',
  SPEECH_TO_TEXT: 'speech.stt',
  TEXT_TO_SPEECH_FAST: 'speech.tts.fast',
  TEXT_TO_SPEECH_QUALITY: 'speech.tts.quality',
  IMAGE_GENERATION: 'image.generation'
});

/** Kayıttaki modellerin bağlanabileceği sağlayıcılar. */
export const AI_PROVIDERS = Object.freeze({ ON_PREMISES: 'onprem' });

const PROFILE_DEFINITIONS = Object.freeze({
  [AI_PROFILES.CHAT_FAST]: { label: 'Hızlı sohbet', requires: [AI_CAPABILITIES.CHAT] },
  [AI_PROFILES.CHAT_GENERAL]: { label: 'Genel sohbet', requires: [AI_CAPABILITIES.CHAT] },
  [AI_PROFILES.CHAT_REASONING]: { label: 'Akıl yürütme', requires: [AI_CAPABILITIES.CHAT, AI_CAPABILITIES.REASONING] },
  [AI_PROFILES.CHAT_TOOLS]: { label: 'Araç kullanımı', requires: [AI_CAPABILITIES.CHAT, AI_CAPABILITIES.TOOLS] },
  [AI_PROFILES.CHAT_TOOLS_REASONING]: {
    label: 'Araç kullanımı (akıl yürütme)',
    requires: [AI_CAPABILITIES.CHAT, AI_CAPABILITIES.TOOLS, AI_CAPABILITIES.REASONING]
  },
  [AI_PROFILES.VISION]: { label: 'Görsel anlama', requires: [AI_CAPABILITIES.CHAT, AI_CAPABILITIES.VISION] },
  [AI_PROFILES.EMBEDDING]: { label: 'Anlamsal gösterim', requires: [AI_CAPABILITIES.EMBEDDING] },
  [AI_PROFILES.RERANK]: { label: 'Yeniden sıralama', requires: [AI_CAPABILITIES.RERANK] },
  [AI_PROFILES.SPEECH_TO_TEXT]: { label: 'Konuşmadan metne', requires: [AI_CAPABILITIES.SPEECH_TO_TEXT] },
  [AI_PROFILES.TEXT_TO_SPEECH_FAST]: { label: 'Metinden konuşmaya (hızlı)', requires: [AI_CAPABILITIES.TEXT_TO_SPEECH] },
  [AI_PROFILES.TEXT_TO_SPEECH_QUALITY]: { label: 'Metinden konuşmaya (yüksek kalite)', requires: [AI_CAPABILITIES.TEXT_TO_SPEECH] },
  [AI_PROFILES.IMAGE_GENERATION]: { label: 'Görsel üretimi', requires: [AI_CAPABILITIES.IMAGE_GENERATION] }
});

const KNOWN_CAPABILITIES = new Set(Object.values(AI_CAPABILITIES));
const KNOWN_PROVIDERS = new Set(Object.values(AI_PROVIDERS));

const MAX_MODELS = 200;
const MAX_ISSUES = 25;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const SAFE_NAME_PATTERN = /^[a-z0-9._-]{1,40}$/;
const SAFE_FIELD_PATTERN = /^[A-Za-z0-9._-]{1,40}$/;
/**
 * Tanınan alanlar. Kayıt KAPALI kalacak biçimde doğrulanır: `maxConcurreny`
 * gibi bir yazım hatası sessizce yok sayılsaydı eşzamanlılık ya da süre sınırı
 * fark edilmeden kalkardı.
 */
const DOCUMENT_FIELDS = new Set(['version', 'models', 'profiles']);
const MODEL_FIELDS = new Set(['id', 'provider', 'capabilities', 'contextTokens', 'maxConcurrency', 'enabled', 'preprocessing', 'reportedModels']);
const PROFILE_FIELDS = new Set(['model', 'enabled', 'maxOutputTokens', 'timeoutMs']);
const PREPROCESSING_FIELDS = new Set(['id', 'queryPrefix', 'documentPrefix', 'truncateTokens']);
const PREPROCESSING_ID_PATTERN = /^[a-z0-9][a-z0-9.:-]{0,63}$/;
const MAX_PREFIX_CHARS = 200;
const MAX_REPORTED_MODELS = 8;

/** Gömme girdisinin amacı: kullanıcı sorgusu ya da sunucuya ait katalog belgesi. */
export const AI_EMBEDDING_PURPOSES = Object.freeze({ QUERY: 'query', DOCUMENT: 'document' });

/** Ön işlemesiz model: önek yok, kesme yok, belirteç `none`. */
export const AI_NO_PREPROCESSING = Object.freeze({ id: 'none', queryPrefix: '', documentPrefix: '', truncateTokens: null });
/** Tek istekte istenebilecek en büyük çıktı belirteci (profil sınırı ve çağrı sınırı için ortak). */
export const AI_MAX_OUTPUT_TOKENS = 131072;

const NUMBER_BOUNDS = Object.freeze({
  contextTokens: [1, 10000000],
  maxConcurrency: [1, 1000],
  maxOutputTokens: [1, AI_MAX_OUTPUT_TOKENS],
  timeoutMs: [1000, 600000]
});

export const AI_PROFILE_RESOLUTION_FAILURES = Object.freeze({
  UNKNOWN_PROFILE: 'UNKNOWN_PROFILE',
  PROFILE_NOT_CONFIGURED: 'PROFILE_NOT_CONFIGURED',
  PROFILE_DISABLED: 'PROFILE_DISABLED',
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE'
});

export function isKnownAiProfile(profileId) {
  return Object.hasOwn(PROFILE_DEFINITIONS, String(profileId ?? ''));
}

export function aiProfileLabel(profileId) {
  return isKnownAiProfile(profileId) ? PROFILE_DEFINITIONS[profileId].label : String(profileId ?? '');
}

export function aiProfileRequirements(profileId) {
  return isKnownAiProfile(profileId) ? [...PROFILE_DEFINITIONS[profileId].requires] : [];
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function optionalInteger(value, [min, max]) {
  if (value == null) return { ok: true, value: null };
  return Number.isSafeInteger(value) && value >= min && value <= max
    ? { ok: true, value }
    : { ok: false };
}

function optionalBoolean(value, fallback) {
  if (value == null) return { ok: true, value: fallback };
  return typeof value === 'boolean' ? { ok: true, value } : { ok: false };
}

function safeName(value) {
  return SAFE_NAME_PATTERN.test(String(value)) ? `"${value}"` : '(geçersiz ad)';
}

function rejectUnknownFields(entry, allowed, path, add) {
  for (const field of Object.keys(entry)) {
    if (!allowed.has(field)) {
      add(path, `tanınmayan alan ${SAFE_FIELD_PATTERN.test(field) ? `"${field}"` : '(geçersiz ad)'}`);
    }
  }
}

/**
 * Gömme modelinin belgelenmiş ön işlemesi (ör. E5 `query: ` / `passage: `
 * önekleri). Yalnızca gömme modelinde tanımlanır; belirteç önekleri adlandırır
 * ve gömme uzayının kimliğine girer: önek varsa `none` olamaz, önek yoksa
 * `none` olmalıdır (nitelendirme raporuyla aynı kural). Önekler kırpılmaz.
 *
 * Alanın YOKLUĞU ön işlemesizliktir; yazılmış her değer (`null` dâhil)
 * doğrulanır: geçersiz değer gömme uzayını sessizce değiştiremez.
 * `truncateTokens`, modelin belirteç penceresini aşan girdinin (önek dâhil)
 * uçta ilk N belirtece kesileceğini söyler; yoksa aşan girdiyi uç reddeder.
 */
function validatePreprocessing(entry, capabilities, contextTokens, path, add) {
  if (!Object.hasOwn(entry, 'preprocessing') || entry.preprocessing === undefined) return AI_NO_PREPROCESSING;
  const value = entry.preprocessing;
  if (!capabilities?.includes(AI_CAPABILITIES.EMBEDDING)) {
    add(path, 'ön işleme yalnızca gömme modelinde tanımlanabilir');
    return AI_NO_PREPROCESSING;
  }
  if (!isPlainObject(value)) {
    add(path, 'ön işleme bir nesne olmalıdır');
    return AI_NO_PREPROCESSING;
  }
  rejectUnknownFields(value, PREPROCESSING_FIELDS, path, add);
  const { id, queryPrefix = '', documentPrefix = '' } = value;
  let valid = true;
  const truncateTokens = optionalInteger(value.truncateTokens, NUMBER_BOUNDS.contextTokens);
  if (!truncateTokens.ok || value.truncateTokens === null) {
    add(`${path}.truncateTokens`, 'pozitif tam sayı olmalıdır');
    valid = false;
  } else if (truncateTokens.value != null && contextTokens != null && truncateTokens.value > contextTokens) {
    add(`${path}.truncateTokens`, 'modelin bağlam penceresinden (contextTokens) büyük olamaz');
    valid = false;
  }
  if (typeof id !== 'string' || !PREPROCESSING_ID_PATTERN.test(id)) {
    add(`${path}.id`, 'küçük harf, rakam, nokta, iki nokta ve tireden oluşan bir belirteç olmalıdır');
    valid = false;
  }
  for (const [field, prefix] of [['queryPrefix', queryPrefix], ['documentPrefix', documentPrefix]]) {
    if (typeof prefix !== 'string' || prefix.length > MAX_PREFIX_CHARS) {
      add(`${path}.${field}`, `en fazla ${MAX_PREFIX_CHARS} karakterlik metin olmalıdır`);
      valid = false;
    }
  }
  if (valid && Boolean(queryPrefix || documentPrefix) === (id === AI_NO_PREPROCESSING.id)) {
    add(`${path}.id`, 'önek kullanılıyorsa belirteç onu adlandırmalı; önek yoksa "none" olmalıdır');
  }
  return valid ? Object.freeze({ id, queryPrefix, documentPrefix, truncateTokens: truncateTokens.value }) : AI_NO_PREPROCESSING;
}

/**
 * Uçun yanıtta bildirebileceği öteki adlar (ör. vLLM yanıtı her zaman ilk
 * `--served-model-name` ile döner). Yalnızca model kimliği doğrulanan gömme ve
 * yeniden sıralama modelinde tanımlanır; joker yoktur, her ad bire bir eşleşir.
 * Adlar arası çakışma (başka modelin kimliği ya da adı) kayıtta reddedilir.
 */
function validateReportedModels(entry, id, capabilities, path, add) {
  if (!Object.hasOwn(entry, 'reportedModels') || entry.reportedModels === undefined) return Object.freeze([]);
  const value = entry.reportedModels;
  if (!capabilities?.some((capability) => capability === AI_CAPABILITIES.EMBEDDING || capability === AI_CAPABILITIES.RERANK)) {
    add(path, 'yalnızca gömme ya da yeniden sıralama modelinde tanımlanabilir');
    return Object.freeze([]);
  }
  const valid = Array.isArray(value) && value.length >= 1 && value.length <= MAX_REPORTED_MODELS
    && value.every((name) => typeof name === 'string' && MODEL_ID_PATTERN.test(name) && name !== id)
    && new Set(value).size === value.length;
  if (!valid) {
    add(path, `modelin kendi kimliğinden farklı, yinelenmeyen 1-${MAX_REPORTED_MODELS} model adı olmalıdır`);
    return Object.freeze([]);
  }
  return Object.freeze([...value]);
}

/** Bildirilen ad başka bir modeli de adlandırırsa yanıtın hangi modele ait olduğu bilinemez. */
function rejectAmbiguousReportedModels(models, paths, add) {
  const owner = new Map([...models.keys()].map((id) => [id, id]));
  for (const model of models.values()) {
    for (const name of model.reportedModels) {
      if (owner.has(name) && owner.get(name) !== model.id) {
        add(`${paths.get(model.id)}.reportedModels`, 'başka bir modelin kimliğini ya da adını taşıyamaz');
      } else {
        owner.set(name, model.id);
      }
    }
  }
}

function validateModels(entries, add) {
  const models = new Map();
  const paths = new Map();
  if (!Array.isArray(entries) || entries.length === 0) {
    add('models', 'en az bir model tanımlanmalıdır');
    return models;
  }
  if (entries.length > MAX_MODELS) {
    add('models', `en fazla ${MAX_MODELS} model tanımlanabilir`);
    return models;
  }
  entries.forEach((entry, index) => {
    const path = `models[${index}]`;
    if (!isPlainObject(entry)) {
      add(path, 'model tanımı bir nesne olmalıdır');
      return;
    }
    rejectUnknownFields(entry, MODEL_FIELDS, path, add);
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!MODEL_ID_PATTERN.test(id)) {
      add(`${path}.id`, 'geçerli bir model kimliği olmalıdır');
      return;
    }
    if (models.has(id)) {
      add(`${path}.id`, 'model kimliği yinelenmiş');
      return;
    }
    const provider = entry.provider ?? AI_PROVIDERS.ON_PREMISES;
    if (!KNOWN_PROVIDERS.has(provider)) add(`${path}.provider`, 'tanınmayan sağlayıcı');
    const capabilities = Array.isArray(entry.capabilities) ? entry.capabilities : null;
    if (!capabilities || capabilities.length === 0) {
      add(`${path}.capabilities`, 'en az bir yetenek bildirilmelidir');
    } else if (capabilities.some((capability) => !KNOWN_CAPABILITIES.has(capability))) {
      add(`${path}.capabilities`, 'tanınmayan yetenek içeriyor');
    }
    const contextTokens = optionalInteger(entry.contextTokens, NUMBER_BOUNDS.contextTokens);
    if (!contextTokens.ok) add(`${path}.contextTokens`, 'boş ya da pozitif tam sayı olmalıdır');
    const maxConcurrency = optionalInteger(entry.maxConcurrency, NUMBER_BOUNDS.maxConcurrency);
    if (!maxConcurrency.ok) add(`${path}.maxConcurrency`, 'boş ya da 1-1000 arası tam sayı olmalıdır');
    const enabled = optionalBoolean(entry.enabled, true);
    if (!enabled.ok) add(`${path}.enabled`, 'true ya da false olmalıdır');
    const preprocessing = validatePreprocessing(entry, capabilities, contextTokens.value ?? null, `${path}.preprocessing`, add);
    const reportedModels = validateReportedModels(entry, id, capabilities, `${path}.reportedModels`, add);
    paths.set(id, path);
    models.set(id, Object.freeze({
      id,
      provider,
      capabilities: Object.freeze([...new Set(capabilities || [])]),
      contextTokens: contextTokens.value ?? null,
      maxConcurrency: maxConcurrency.value ?? null,
      enabled: enabled.value !== false,
      preprocessing,
      reportedModels
    }));
  });
  rejectAmbiguousReportedModels(models, paths, add);
  return models;
}

function validateProfiles(entries, models, add) {
  const profiles = new Map();
  if (!isPlainObject(entries)) {
    add('profiles', 'profil eşlemesi bir nesne olmalıdır');
    return profiles;
  }
  for (const [profileId, entry] of Object.entries(entries)) {
    if (!isKnownAiProfile(profileId)) {
      add('profiles', `tanınmayan profil ${safeName(profileId)}`);
      continue;
    }
    const path = `profiles.${profileId}`;
    if (!isPlainObject(entry)) {
      add(path, 'profil tanımı bir nesne olmalıdır');
      continue;
    }
    rejectUnknownFields(entry, PROFILE_FIELDS, path, add);
    const enabled = optionalBoolean(entry.enabled, true);
    if (!enabled.ok) add(`${path}.enabled`, 'true ya da false olmalıdır');
    const maxOutputTokens = optionalInteger(entry.maxOutputTokens, NUMBER_BOUNDS.maxOutputTokens);
    if (!maxOutputTokens.ok) add(`${path}.maxOutputTokens`, 'boş ya da pozitif tam sayı olmalıdır');
    const timeoutMs = optionalInteger(entry.timeoutMs, NUMBER_BOUNDS.timeoutMs);
    if (!timeoutMs.ok) add(`${path}.timeoutMs`, 'boş ya da 1000-600000 arası tam sayı olmalıdır');
    const modelId = typeof entry.model === 'string' ? entry.model.trim() : '';
    const model = models.get(modelId);
    if (!model) {
      add(`${path}.model`, 'kayıtta bulunan bir modele bağlanmalıdır');
      continue;
    }
    const profileEnabled = enabled.value !== false;
    if (profileEnabled && !model.enabled) add(`${path}.model`, 'etkin profil kapalı bir modele bağlanamaz');
    const missing = aiProfileRequirements(profileId).filter((capability) => !model.capabilities.includes(capability));
    if (profileEnabled && missing.length) add(`${path}.model`, `model gerekli yeteneği taşımıyor (${missing.join(', ')})`);
    // Çıktı sınırı modelin bağlam penceresine sığmayan etkin profil, her
    // isteği sağlayıcıya reddettirirdi; çelişki kayıtta yakalanır.
    if (profileEnabled && maxOutputTokens.value != null && model.contextTokens != null
      && maxOutputTokens.value > model.contextTokens) {
      add(`${path}.maxOutputTokens`, 'modelin bağlam penceresinden (contextTokens) büyük olamaz');
    }
    profiles.set(profileId, Object.freeze({
      id: profileId,
      model: modelId,
      maxOutputTokens: maxOutputTokens.value ?? null,
      timeoutMs: timeoutMs.value ?? null,
      enabled: profileEnabled
    }));
  }
  return profiles;
}

/**
 * Kayıt belgesini doğrular ve kanonik biçime çevirir.
 *
 * Sorunlar ÖNCE toplanır, sonra birlikte döner: yönetici eksik yapılandırmayı
 * tek tek keşfetmek zorunda kalmaz. İletiler belge yolunu anlatır, değerleri
 * yansıtmaz.
 *
 * @returns {{ok: true, registry: object} | {ok: false, issues: string[]}}
 */
export function validateModelRegistry(document) {
  const issues = [];
  const add = (path, problem) => {
    if (issues.length < MAX_ISSUES) issues.push(`${path}: ${problem}`);
  };
  if (!isPlainObject(document)) return { ok: false, issues: ['$: kayıt belgesi bir nesne olmalıdır'] };
  rejectUnknownFields(document, DOCUMENT_FIELDS, '$', add);
  if (document.version !== 1) add('version', 'desteklenen tek sürüm 1');
  const models = validateModels(document.models, add);
  const profiles = validateProfiles(document.profiles, models, add);
  if (issues.length) return { ok: false, issues };
  return { ok: true, registry: Object.freeze({ version: 1, models, profiles }) };
}

/**
 * Profili somut modele çözer.
 *
 * Başarısızlık bir istisna değil, sonuç nesnesidir: sunucu bunu kararlı bir
 * yapılandırma hatasına çevirir, arayüz ise yeteneği gizleyebilir.
 */
export function resolveModelProfile(registry, profileId) {
  if (!isKnownAiProfile(profileId)) {
    return { ok: false, reason: AI_PROFILE_RESOLUTION_FAILURES.UNKNOWN_PROFILE };
  }
  const profile = registry?.profiles?.get(profileId);
  if (!profile) return { ok: false, reason: AI_PROFILE_RESOLUTION_FAILURES.PROFILE_NOT_CONFIGURED };
  if (!profile.enabled) return { ok: false, reason: AI_PROFILE_RESOLUTION_FAILURES.PROFILE_DISABLED };
  const model = registry.models.get(profile.model);
  if (!model?.enabled) return { ok: false, reason: AI_PROFILE_RESOLUTION_FAILURES.MODEL_UNAVAILABLE };
  return {
    ok: true,
    route: Object.freeze({
      profile: profileId,
      model: model.id,
      provider: model.provider,
      capabilities: model.capabilities,
      contextTokens: model.contextTokens,
      maxConcurrency: model.maxConcurrency,
      maxOutputTokens: profile.maxOutputTokens,
      timeoutMs: profile.timeoutMs,
      preprocessing: model.preprocessing,
      reportedModels: model.reportedModels
    })
  };
}

/** Yönetim ekranı için profil → model özeti; gizli bilgi taşımaz. */
export function describeModelRegistry(registry) {
  if (!registry?.profiles) return [];
  return Object.keys(PROFILE_DEFINITIONS).map((profileId) => {
    const resolved = resolveModelProfile(registry, profileId);
    return {
      profile: profileId,
      label: aiProfileLabel(profileId),
      model: resolved.ok ? resolved.route.model : registry.profiles.get(profileId)?.model ?? null,
      available: resolved.ok,
      reason: resolved.ok ? null : resolved.reason
    };
  });
}
