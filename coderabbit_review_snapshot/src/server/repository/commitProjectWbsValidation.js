import { TAG_COLOR_KEYS, TAG_ICON_KEYS } from '../../domain/tags/index.js';

const PROJECT_COLORS = new Set(['blue', 'emerald', 'purple', 'amber', 'rose', 'cyan']);
const TAG_COLORS = new Set(TAG_COLOR_KEYS);
const TAG_ICONS = new Set(TAG_ICON_KEYS);
const SQL_INT_MIN = -2147483648;
const SQL_INT_MAX = 2147483647;
const SQL_SICIL_MAX = 2147483647;

function issue(code, path, message, details = null) {
  return { code, path, message, details };
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

function validSicil(value) {
  const normalized = text(value);
  if (!/^\d+$/.test(normalized)) return false;
  const sicil = Number(normalized);
  return Number.isSafeInteger(sicil) && sicil > 0 && sicil <= SQL_SICIL_MAX;
}

function sqlIntValue(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : null;
  }
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!/^[+-]?\d+$/.test(normalized)) return null;
    const parsed = Number(normalized);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function validateText(value, path, label, maxLength, { required = false } = {}) {
  if (value == null || value === '') {
    return required ? issue('COMMIT_TEXT_REQUIRED', path, `${label} gereklidir.`) : null;
  }
  if (typeof value !== 'string') {
    return issue('COMMIT_TEXT_INVALID', path, `${label} metin olmalıdır.`);
  }
  const normalized = value.trim();
  if (required && !normalized) {
    return issue('COMMIT_TEXT_REQUIRED', path, `${label} gereklidir.`);
  }
  if (value.length > maxLength) {
    return issue('COMMIT_TEXT_TOO_LONG', path, `${label} en fazla ${maxLength} karakter olabilir.`, { maxLength });
  }
  return null;
}

function validateProjects(changes) {
  for (let index = 0; index < (changes.projectUpserts || []).length; index += 1) {
    const project = changes.projectUpserts[index] || {};
    const basePath = `projectUpserts[${index}]`;
    const nameIssue = validateText(project.name, `${basePath}.name`, 'Proje adı', 1000, { required: true });
    if (nameIssue) return nameIssue;
    const codeIssue = validateText(project.code, `${basePath}.code`, 'Proje kodu', 255);
    if (codeIssue) return codeIssue;

    if (project.leadId != null && project.leadId !== '' && !validSicil(project.leadId)) {
      return issue(
        'PROJECT_LEAD_INVALID',
        `${basePath}.leadId`,
        'Proje sorumlusu Sicil değeri pozitif ve geçerli bir SQL Server int olmalıdır.'
      );
    }

    if (project.color != null && text(project.color) && !PROJECT_COLORS.has(text(project.color))) {
      return issue('PROJECT_COLOR_INVALID', `${basePath}.color`, 'Geçerli bir proje rengi seçilmelidir.');
    }

    const seenTags = new Set();
    for (let tagIndex = 0; tagIndex < (project.tags || []).length; tagIndex += 1) {
      const tag = project.tags[tagIndex];
      const path = `${basePath}.tags[${tagIndex}]`;
      const name = typeof tag === 'string' ? tag : tag?.name;
      const tagIssue = validateText(name, path, 'Proje etiketi', 255, { required: true });
      if (tagIssue) return tagIssue;
      // Renk ve simge kapalı kümelerdir: bilinmeyen bir anahtar arayüzde boş
      // kutu bırakır ve kalıcı kayıtta anlamsız bir değer olarak kalırdı.
      if (typeof tag === 'object' && tag !== null) {
        if (text(tag.color) && !TAG_COLORS.has(text(tag.color))) {
          return issue('PROJECT_TAG_COLOR_INVALID', `${path}.color`, 'Geçerli bir etiket rengi seçilmelidir.');
        }
        if (text(tag.icon) && !TAG_ICONS.has(text(tag.icon))) {
          return issue('PROJECT_TAG_ICON_INVALID', `${path}.icon`, 'Geçerli bir etiket simgesi seçilmelidir.');
        }
      }
      const key = name.trim().normalize('NFKC').toLocaleLowerCase('tr-TR');
      if (seenTags.has(key)) {
        return issue('PROJECT_TAG_DUPLICATE', path, 'Aynı proje etiketi birden fazla kez kullanılamaz.');
      }
      seenTags.add(key);
    }
  }
  return null;
}

function validateWbs(changes) {
  for (let index = 0; index < (changes.wbsUpserts || []).length; index += 1) {
    const node = changes.wbsUpserts[index] || {};
    const basePath = `wbsUpserts[${index}]`;
    const codeIssue = validateText(node.code, `${basePath}.code`, 'WBS kodu', 100, { required: true });
    if (codeIssue) return codeIssue;
    const nameIssue = validateText(node.name, `${basePath}.name`, 'WBS adı', 1000, { required: true });
    if (nameIssue) return nameIssue;

    if (node.sortOrder != null && node.sortOrder !== '') {
      const sortOrder = sqlIntValue(node.sortOrder);
      if (sortOrder == null || sortOrder < SQL_INT_MIN || sortOrder > SQL_INT_MAX) {
        return issue('WBS_SORT_ORDER_INVALID', `${basePath}.sortOrder`, 'WBS sırası geçerli bir SQL Server int olmalıdır.');
      }
    }
  }
  return null;
}

export function findCommitProjectWbsIssue(changes = {}) {
  return validateProjects(changes) || validateWbs(changes);
}
