import 'server-only';
import { canonicalActualId } from '../../../domain/identity/actualId.js';
import { TOOL_LIMITS } from './toolLimits.js';
import { invalidArguments } from './toolErrors.js';

/**
 * Araç bağımsız değişkenlerinin KATI doğrulaması.
 *
 * Kayıt defterindeki her araç, OpenAI uyumlu işlev çağrısıyla aynı JSON Schema
 * alt kümesini bildirir: nesne (tanınmayan alan YASAK), dize (sabit liste, uzunluk
 * sınırı, `uuid` / `date` biçimi), tam sayı (alt/üst sınır), mantıksal değer ve
 * sınırlı dizi. Tür dönüştürülmez: `"5"` tam sayı değildir, `"yes"` mantıksal
 * değer değildir. İsteğe bağlı bir alanın `null` değeri alanın verilmemesiyle
 * aynı anlamdadır (modeller kullanılmayan alanı `null` gönderir); zorunlu alan
 * `null` olamaz. Hata iletisi yalnızca alan yolunu ve kararlı nedeni taşır;
 * gönderilen değeri yansıtmaz.
 */

const SUPPORTED_KEYS = Object.freeze({
  object: new Set(['type', 'description', 'properties', 'required', 'additionalProperties']),
  string: new Set(['type', 'description', 'enum', 'minLength', 'maxLength', 'pattern', 'format']),
  integer: new Set(['type', 'description', 'minimum', 'maximum']),
  boolean: new Set(['type', 'description']),
  array: new Set(['type', 'description', 'items', 'minItems', 'maxItems', 'uniqueItems'])
});
const FORMATS = new Set(['uuid', 'date']);
const MAX_ARRAY_ITEMS = 20;
const MAX_STRING_LENGTH = 400;
const MAX_DEPTH = 3;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Takvimde gerçekten bulunan `YYYY-MM-DD` günü (1900–2100). */
export function isIsoDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  if (year < 1900 || year > 2100) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/**
 * Şema tanımının kendisini doğrular (kayıt defteri kurulurken). Her girdi
 * sınırlı olmalıdır: dize için sabit liste, biçim ya da en büyük uzunluk; tam
 * sayı için alt ve üst sınır; dizi için en fazla öğe sayısı.
 */
export function validateSchemaDefinition(schema, path = '$', depth = 0) {
  const problems = [];
  const add = (problem) => problems.push(`${path}: ${problem}`);
  if (!isPlainObject(schema) || !Object.hasOwn(SUPPORTED_KEYS, schema.type)) {
    add('desteklenmeyen şema türü');
    return problems;
  }
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYS[schema.type].has(key)) add(`desteklenmeyen anahtar ${key}`);
  }
  if (depth > MAX_DEPTH) add('şema çok derin');
  switch (schema.type) {
    case 'object': {
      if (schema.additionalProperties !== false) add('additionalProperties false olmalıdır');
      if (!isPlainObject(schema.properties)) add('properties nesne olmalıdır');
      const properties = isPlainObject(schema.properties) ? schema.properties : {};
      for (const name of Object.keys(properties)) {
        if (!/^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(name)) add(`geçersiz alan adı ${name}`);
        problems.push(...validateSchemaDefinition(properties[name], `${path}.${name}`, depth + 1));
      }
      const required = schema.required ?? [];
      if (!Array.isArray(required) || required.some((name) => !Object.hasOwn(properties, name))) add('required tanımsız alan içeriyor');
      break;
    }
    case 'string': {
      if (schema.enum != null) {
        if (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.some((value) => typeof value !== 'string')
          || new Set(schema.enum).size !== schema.enum.length) add('enum benzersiz dizelerden oluşmalıdır');
      } else if (schema.format != null) {
        if (!FORMATS.has(schema.format)) add('desteklenmeyen biçim');
      } else if (!Number.isSafeInteger(schema.maxLength) || schema.maxLength < 1 || schema.maxLength > MAX_STRING_LENGTH) {
        add('serbest dize en büyük uzunluk bildirmelidir');
      }
      if (schema.minLength != null && (!Number.isSafeInteger(schema.minLength) || schema.minLength < 0)) add('minLength geçersiz');
      if (schema.pattern != null) {
        try {
          new RegExp(schema.pattern, 'u');
        } catch {
          add('pattern geçersiz');
        }
      }
      break;
    }
    case 'integer':
      if (!Number.isSafeInteger(schema.minimum) || !Number.isSafeInteger(schema.maximum) || schema.minimum > schema.maximum) {
        add('tam sayı alt ve üst sınır bildirmelidir');
      }
      break;
    case 'array':
      if (!Number.isSafeInteger(schema.maxItems) || schema.maxItems < 1 || schema.maxItems > MAX_ARRAY_ITEMS) add('dizi en fazla öğe sayısı bildirmelidir');
      problems.push(...validateSchemaDefinition(schema.items, `${path}[]`, depth + 1));
      break;
    default:
      break;
  }
  return problems;
}

function validateValue(schema, value, path, errors) {
  switch (schema.type) {
    case 'object': {
      if (!isPlainObject(value)) {
        errors.push(`${path}:type`);
        return undefined;
      }
      const result = {};
      const required = new Set(schema.required || []);
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties, key)) errors.push(`${path}.${key.slice(0, 40)}:unknown`);
      }
      for (const [name, property] of Object.entries(schema.properties)) {
        const present = Object.hasOwn(value, name) && value[name] !== undefined && value[name] !== null;
        if (!present) {
          if (required.has(name)) errors.push(`${path}.${name}:required`);
          continue;
        }
        const checked = validateValue(property, value[name], `${path}.${name}`, errors);
        if (checked !== undefined) result[name] = checked;
      }
      return result;
    }
    case 'string': {
      if (typeof value !== 'string') {
        errors.push(`${path}:type`);
        return undefined;
      }
      if (schema.enum) {
        if (!schema.enum.includes(value)) errors.push(`${path}:enum`);
        return value;
      }
      if (schema.format === 'uuid') {
        const id = canonicalActualId(value);
        if (!id || id !== value.trim().toLowerCase()) errors.push(`${path}:uuid`);
        return id ?? undefined;
      }
      if (schema.format === 'date') {
        if (!isIsoDay(value)) errors.push(`${path}:date`);
        return value;
      }
      const text = value.trim();
      if (CONTROL.test(text)) errors.push(`${path}:control`);
      if (schema.minLength != null && text.length < schema.minLength) errors.push(`${path}:minLength`);
      if (text.length > schema.maxLength) errors.push(`${path}:maxLength`);
      if (schema.pattern && !new RegExp(schema.pattern, 'u').test(text)) errors.push(`${path}:pattern`);
      return text;
    }
    case 'integer':
      if (!Number.isSafeInteger(value)) {
        errors.push(`${path}:type`);
        return undefined;
      }
      if (value < schema.minimum || value > schema.maximum) errors.push(`${path}:range`);
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path}:type`);
      return value;
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`${path}:type`);
        return undefined;
      }
      if (value.length > schema.maxItems) errors.push(`${path}:maxItems`);
      if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path}:minItems`);
      const items = value.slice(0, schema.maxItems).map((item, index) => validateValue(schema.items, item, `${path}[${index}]`, errors));
      if (schema.uniqueItems && new Set(items.map((item) => JSON.stringify(item))).size !== items.length) errors.push(`${path}:unique`);
      return items;
    }
    default:
      errors.push(`${path}:type`);
      return undefined;
  }
}

/**
 * Modelin gönderdiği bağımsız değişken metnini çözer ve şemaya göre doğrular.
 * Boş metin boş nesnedir. Başarıda kanonik değer (kimlikler küçük harf, serbest
 * metin baş/son boşluktan arındırılmış) döner; aksi hâlde `INVALID_ARGUMENTS`.
 */
export function parseToolArguments(schema, text) {
  const raw = text == null ? '' : String(text);
  if (Buffer.byteLength(raw, 'utf8') > TOOL_LIMITS.maxArgumentBytes) throw invalidArguments(['$:tooLarge']);
  let value;
  if (!raw.trim()) {
    value = {};
  } else {
    try {
      value = JSON.parse(raw);
    } catch {
      throw invalidArguments(['$:json']);
    }
  }
  const errors = [];
  const result = validateValue(schema, value, '$', errors);
  if (errors.length) throw invalidArguments([...new Set(errors)]);
  return result;
}
