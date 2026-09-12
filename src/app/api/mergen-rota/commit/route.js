import { createOrderedSqlAppRepository } from '../../../../server/repository/orderedSqlAppRepository.js';
import {
  canonicalizeCommitChanges,
  findCommitChangeIssue
} from '../../../../server/repository/commitChangeValidation.js';
import { findNestedCommitCollectionIssue } from '../../../../server/repository/commitNestedCollectionValidation.js';
import { findCommitProjectWbsIssue } from '../../../../server/repository/commitProjectWbsValidation.js';
import { canonicalizeCommitScalars } from '../../../../server/repository/commitScalarCanonicalization.js';
import { findCommitScalarIssue } from '../../../../server/repository/commitScalarValidation.js';
import { safeErrorResponse, ServerPersistenceError } from '../../../../server/errors.js';
import { withRouteObservability } from '../../../../server/observability/observeOperation.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * İstek gövdesinin en büyük boyutu (bayt).
 *
 * Next.js 14 Route Handler'larında eski `bodyParser.sizeLimit` ayarı geçerli
 * değildir ve `next.config.mjs` bir sınır tanımlamaz: gövde, işlem açılmadan
 * önce tamamen belleğe okunuyordu. Kardinalite sınırı (bkz.
 * MAX_COMMIT_TOTAL_ENTRIES) girdi SAYISINI bağlar; bu sınır girdi BOYUTUNU
 * bağlar — birkaç bin girdilik meşru bir küme bu sınırın çok altındadır.
 */
const MAX_COMMIT_BODY_BYTES = 8 * 1024 * 1024;

function bodyTooLargeError() {
  return new ServerPersistenceError(
    'MUTATION_FAILED',
    'Değişiklik kümesi çok büyük. Değişiklikleri daha küçük parçalar hâlinde kaydedin.',
    { status: 413, details: { code: 'CHANGE_SET_BODY_TOO_LARGE', limit: MAX_COMMIT_BODY_BYTES } }
  );
}

function assertBodyWithinLimit(request) {
  const declared = Number(request?.headers?.get?.('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_COMMIT_BODY_BYTES) throw bodyTooLargeError();
}

/**
 * Gövdeyi AKARAK okur ve sınırı okuma sırasında uygular.
 *
 * `request.text()` gövdenin TAMAMINI belleğe alır ve ancak ondan sonra ölçmeye
 * izin verirdi: `content-length` başlığı olmayan parçalı bir istek, 413 dönmeden
 * önce çalışanın belleğini tüketebiliyordu. Ayrıca `String.length` UTF-16 kod
 * birimi sayar, bayt değil; çok baytlı bir gövde 8 MiB denetimini geçerken
 * gerçekte üç katına kadar yer kaplayabiliyordu.
 *
 * Bu yüzden her parçanın `byteLength` değeri toplanır, sınır aşılır aşılmaz akış
 * iptal edilir ve YALNIZCA kabul edilen baytlar çözülür.
 */
async function readBodyWithinLimit(request) {
  const stream = request?.body;
  if (!stream || typeof stream.getReader !== 'function') {
    // Akış yoksa (test ikizleri, eski çalışma zamanları) tek seferde okunur;
    // bayt sayımı yine `TextEncoder` ile yapılır.
    const raw = await request.text().catch(() => null);
    if (raw == null) return null;
    if (new TextEncoder().encode(raw).byteLength > MAX_COMMIT_BODY_BYTES) throw bodyTooLargeError();
    return raw;
  }

  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_COMMIT_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw bodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  if (!chunks.length) return null;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function handleCommit(request) {
  try {
    assertBodyWithinLimit(request);
    const raw = await readBodyWithinLimit(request);
    let body = null;
    try {
      body = raw == null ? null : JSON.parse(raw);
    } catch {
      body = null;
    }
    if (!body || typeof body !== 'object' || !body.changes || typeof body.changes !== 'object') {
      throw new ServerPersistenceError('MUTATION_FAILED', 'Geçerli bir değişiklik kümesi gönderilmelidir.', { status: 400 });
    }
    const changes = canonicalizeCommitScalars(canonicalizeCommitChanges(body.changes));
    const issue = findCommitChangeIssue(changes)
      || findNestedCommitCollectionIssue(changes)
      || findCommitProjectWbsIssue(changes)
      || findCommitScalarIssue(changes);
    if (issue) {
      throw new ServerPersistenceError('MUTATION_FAILED', issue.message, {
        status: 400,
        details: { code: issue.code, path: issue.path, ...(issue.details || {}) }
      });
    }
    return Response.json(await createOrderedSqlAppRepository().commitChanges(changes), {
      headers: { 'cache-control': 'no-store' }
    });
  } catch (error) {
    return safeErrorResponse(error);
  }
}

// Ölçüm sarmalayıcısı imzayı ve yanıtı DEĞİŞTİRMEZ; yalnızca süreyi, sonucu ve
// ilişkilendirme kimliğini kaydeder (bkz. server/observability).
export const POST = withRouteObservability('api.commit', handleCommit);
