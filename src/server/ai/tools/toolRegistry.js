import 'server-only';
import { ASSISTANT_TOOL_TOPICS } from '../../../domain/ai/assistantContract.js';
import { EVIDENCE_KINDS } from '../../../domain/ai/evidenceContract.js';
import { INTEGRITY_TOOLS } from './rota/integrityTools.js';
import { PEOPLE_TOOLS } from './rota/peopleTools.js';
import { PLAN_TOOLS } from './rota/planTools.js';
import { PROJECT_TOOLS } from './rota/projectTools.js';
import { TASK_TOOLS } from './rota/taskTools.js';
import { WORKFLOW_TOOLS } from './rota/workflowTools.js';
import { validateSchemaDefinition } from './toolArguments.js';
import { TOOL_LIMITS } from './toolLimits.js';
import { EVIDENCE_TEXT_FIELDS } from '../../../domain/ai/claimableEvidence.js';

/**
 * Rota AI'nin SUNUCUYA AİT araç kayıt defteri.
 *
 * Model yalnızca buradaki salt okunur araçlardan birini SEÇEBİLİR; hangi
 * veriye erişebileceğini seçemez. Genel SQL, sorgu metni, sütun/sıralama adı
 * ya da kimlik alan araç YOKTUR ve kayıt defteri böyle bir tanımı kurulumda
 * reddeder: kimlik (Sicil) her zaman güvenilir oturumdan gelir.
 *
 * Kayıt defteri modül yüklenirken doğrulanır; hatalı tanım uygulamayı değil
 * yalnızca Rota AI araç yolunu açılmaz kılar (hata ilk kullanımda fırlar).
 */

const NAME = /^rota_[a-z]+(?:_[a-z]+){0,4}$/;
/** Modelin kimlik, yetki ya da SQL parçası veremeyeceği alan adları. */
const FORBIDDEN_PROPERTY = /^(?:sicil|currentUserSicil|actorSicil|userSicil|authenticatedUser|user|userId|username|role|isAdmin|accessLevel|sql|query|where|orderBy|column|columns|table|select|filterSql)$/i;
const MAX_DESCRIPTION_CHARS = 700;

function propertyNames(schema, names = []) {
  if (schema?.type === 'object') {
    for (const [name, property] of Object.entries(schema.properties || {})) {
      names.push(name);
      propertyNames(property, names);
    }
  } else if (schema?.type === 'array') {
    propertyNames(schema.items, names);
  }
  return names;
}

export function validateToolDefinitions(definitions) {
  const problems = [];
  const names = new Set();
  for (const definition of definitions) {
    const name = String(definition?.name || '');
    const add = (problem) => problems.push(`${name || '?'}: ${problem}`);
    if (!NAME.test(name)) add('geçersiz ad');
    if (names.has(name)) add('yinelenen ad');
    names.add(name);
    if (!Number.isSafeInteger(definition.version) || definition.version < 1) add('sürüm eksik');
    if (!ASSISTANT_TOOL_TOPICS.includes(definition.topic)) add('ilerleme konusu tanımsız');
    if (!Object.hasOwn(EVIDENCE_KINDS, definition.evidenceKind)) add('kanıt türü tanımsız');
    if (typeof definition.description !== 'string' || definition.description.length < 20 || definition.description.length > MAX_DESCRIPTION_CHARS) add('açıklama uzunluğu');
    if (typeof definition.authorization !== 'string' || !definition.authorization) add('yetki anlambilimi belgelenmemiş');
    if (typeof definition.handler !== 'function') add('işleyici eksik');
    if (definition.parameters?.type !== 'object') add('bağımsız değişkenler nesne olmalıdır');
    problems.push(...validateSchemaDefinition(definition.parameters).map((problem) => `${name}: ${problem}`));
    for (const property of propertyNames(definition.parameters)) {
      if (FORBIDDEN_PROPERTY.test(property)) add(`yasak alan ${property}`);
    }
    if (definition.timeoutMs != null && (!Number.isSafeInteger(definition.timeoutMs) || definition.timeoutMs < 500 || definition.timeoutMs > TOOL_LIMITS.callTimeoutMs)) add('süre sınırı');
  }
  return problems;
}

function buildRegistry(definitions) {
  const problems = validateToolDefinitions(definitions);
  const tools = new Map();
  if (!problems.length) {
    for (const definition of definitions) {
      tools.set(definition.name, Object.freeze({
        name: definition.name,
        version: definition.version,
        topic: definition.topic,
        evidenceKind: definition.evidenceKind,
        description: definition.description,
        authorization: definition.authorization,
        parameters: { ...definition.parameters, properties: {
          ...definition.parameters.properties,
          textFields: { type: 'array', maxItems: EVIDENCE_TEXT_FIELDS.length, uniqueItems: true,
            items: { type: 'string', enum: [...EVIDENCE_TEXT_FIELDS] },
            description: 'Yalnızca kullanıcının açıkça istediği serbest metin alanları; veri okunmadan önce seçilir.' }
        } },
        timeoutMs: definition.timeoutMs ?? TOOL_LIMITS.callTimeoutMs,
        readOnly: true,
        handler: definition.handler
      }));
    }
  }
  return Object.freeze({ tools, problems: Object.freeze(problems) });
}

const REGISTRY = buildRegistry([
  ...TASK_TOOLS,
  ...PROJECT_TOOLS,
  ...PEOPLE_TOOLS,
  ...WORKFLOW_TOOLS,
  ...PLAN_TOOLS,
  ...INTEGRITY_TOOLS
]);

/** Kayıt defteri geçerli mi? Değilse araç yolu kullanılmaz (sorun listesi günlüğe yazılabilir). */
export function toolRegistryProblems() {
  return REGISTRY.problems;
}

export function getRotaTool(name) {
  return REGISTRY.tools.get(String(name)) || null;
}

export function rotaToolNames() {
  return [...REGISTRY.tools.keys()];
}

/** Modele sunulan işlev tanımları (OpenAI uyumlu `tools`). */
export function toolCatalogForModel() {
  return [...REGISTRY.tools.values()].map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }));
}

/** Belge ve yönetim görünümü için araç künyesi (işleyici ve şema içermez). */
export function toolCatalogSummary() {
  return [...REGISTRY.tools.values()].map((tool) => ({
    name: tool.name,
    version: tool.version,
    topic: tool.topic,
    evidenceKind: tool.evidenceKind,
    timeoutMs: tool.timeoutMs,
    readOnly: tool.readOnly
  }));
}
