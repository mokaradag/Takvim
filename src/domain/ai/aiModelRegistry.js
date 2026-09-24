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
const NUMBER_BOUNDS = Object.freeze({
  contextTokens: [1, 10000000],
  maxConcurrency: [1, 1000],
  maxOutputTokens: [1, 131072],
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

function validateModels(entries, add) {
  const models = new Map();
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
    models.set(id, Object.freeze({
      id,
      provider,
      capabilities: Object.freeze([...new Set(capabilities || [])]),
      contextTokens: contextTokens.value ?? null,
      maxConcurrency: maxConcurrency.value ?? null,
      enabled: enabled.value !== false
    }));
  });
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
      timeoutMs: profile.timeoutMs
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
