import 'server-only';
import { getSqlPool, sql } from '../db/pool.js';
import { ServerPersistenceError } from '../errors.js';
import { getTrustedCurrentSicil } from '../identity/currentUserProvider.js';

/**
 * Kurum dışı personel arama.
 *
 * Kurumsal nüfus 3.000+ kişidir ve büyür. Bu yüzden dizin anlık görüntüye
 * KONULMAZ; yalnızca kullanıcı "Diğer birimlerden personel göster" anahtarını
 * açtığında, en az iki karakterle, SUNUCUDA ve SINIRLI sayıda satır aranır.
 *
 * Uç bir kimlik dizini DEĞİLDİR:
 *   · çağıran kimliği doğrulanır (oturumdan türetilir, istemciden alınmaz),
 *   · en az {@link MIN_DIRECTORY_QUERY_LENGTH} karakter istenir,
 *   · sonuç {@link DIRECTORY_SEARCH_LIMIT} satırla sınırlıdır,
 *   · yalnızca bu akışın gerektirdiği alanlar döner (Sicil, ad, kurumsal künye,
 *     unvan); kullanıcı adı, e-posta ve yönetici zinciri DÖNMEZ,
 *   · aynı oturumdan gelen aşırı sorgu hızı sınırlanır (dizin yoklaması).
 *
 * Kimlik her zaman Sicil'dir. Ad-soyad hiçbir zaman kimlik ya da yetki ölçütü
 * değildir; aynı adlı iki çalışan ayrı Sicil ile ayrı satır olarak döner.
 */

export const MIN_DIRECTORY_QUERY_LENGTH = 2;
export const DIRECTORY_SEARCH_LIMIT = 25;

const RATE_LIMIT_KEY = Symbol.for('mergen-rota.directory-search-rate');
const RATE_WINDOW_MS = 10000;
const RATE_MAX_REQUESTS = 30;

function rateBuckets() {
  globalThis[RATE_LIMIT_KEY] ||= new Map();
  return globalThis[RATE_LIMIT_KEY];
}

/**
 * Oturum başına pencere sayacı.
 *
 * Bellekte tutulur ve sınırlıdır: yalnızca penceresi açık Siciller saklanır,
 * her çağrıda süresi geçmiş kayıtlar düşer. Telemetri satırı üretmez.
 */
function assertSearchRate(sicil, now = Date.now()) {
  const buckets = rateBuckets();
  for (const [key, bucket] of buckets) {
    if (now - bucket.startedAt >= RATE_WINDOW_MS) buckets.delete(key);
  }
  const current = buckets.get(sicil);
  if (!current) {
    buckets.set(sicil, { startedAt: now, count: 1 });
    return;
  }
  current.count += 1;
  if (current.count > RATE_MAX_REQUESTS) {
    throw new ServerPersistenceError(
      'CONFLICT',
      'Çok sık personel araması yapıldı. Kısa bir süre sonra yeniden deneyin.',
      { status: 429 }
    );
  }
}

export function resetDirectorySearchRateForTests() {
  globalThis[RATE_LIMIT_KEY] = new Map();
}

function normalizeQuery(value) {
  return String(value ?? '').trim().slice(0, 80);
}

function directoryPerson(row) {
  return {
    sicil: Number(row.Sicil),
    // Kimlik Sicil'dir; ad yalnızca gösterilir.
    name: row.DisplayName ? String(row.DisplayName).trim() : String(row.Sicil),
    jobTitle: row.JobTitle ? String(row.JobTitle).trim() : '',
    organization: {
      directorate: row.Directorate || null,
      department: row.Department || null,
      unit: row.Unit || null
    }
  };
}

/**
 * Sicil ya da ad parçasıyla arar.
 *
 * Tamamen rakamdan oluşan sorgu ÖNCE Sicil eşleşmesi olarak değerlendirilir;
 * kalan satırlar ad eşleşmesidir. Arama Türkçe harf duyarsız harmanlamayla
 * yapılır ve `MR_V_PeopleDirectory` dizininden okunur.
 */
export async function searchCorporateDirectory(input = {}, executor = null) {
  const query = normalizeQuery(input.query ?? input.q);
  if (query.length < MIN_DIRECTORY_QUERY_LENGTH) {
    throw new ServerPersistenceError(
      'MUTATION_FAILED',
      `Personel araması için en az ${MIN_DIRECTORY_QUERY_LENGTH} karakter yazılmalıdır.`,
      { status: 400 }
    );
  }

  // Bu uç yalnızca güvenilir Sicil'e ihtiyaç duyar; tam proje/görev yetki
  // bağlamını yüklemek her tuş aramasında gereksiz ve pahalıdır.
  const sicil = await getTrustedCurrentSicil();
  assertSearchRate(sicil);
  const pool = executor || await getSqlPool();

  // Tam yetki bağlamının koruduğu kimlik değişmezini ucuz bir varlık sorgusuyla
  // sürdürürüz: yapılandırılmış Sicil kurumsal rehberde bulunmalıdır.
  const identity = pool.request();
  identity.input('sicil', sql.Int, sicil);
  const identityResult = await identity.query(`
    SELECT TOP (1) 1 AS ExistsInDirectory
    FROM dbo.MR_V_PeopleDirectory
    WHERE Sicil = @sicil;
  `);
  if (!identityResult.recordset?.length) {
    throw new ServerPersistenceError('UNAUTHORIZED', 'Yapılandırılmış Sicil kurumsal personel kaynağında bulunamadı.');
  }

  const numeric = /^\d{1,9}$/.test(query) ? Number(query) : null;
  const request = pool.request();
  request.input('query', sql.NVarChar(80), query);
  request.input('sicilQuery', sql.Int, numeric);
  request.input('limit', sql.Int, DIRECTORY_SEARCH_LIMIT);
  const result = await request.query(`
    SELECT TOP (@limit) pd.Sicil, pd.DisplayName, pd.JobTitle,
      pd.Directorate, pd.Department, pd.Unit,
      CASE WHEN @sicilQuery IS NOT NULL AND pd.Sicil = @sicilQuery THEN 0 ELSE 1 END AS MatchRank
    FROM dbo.MR_V_PeopleDirectory pd
    WHERE (@sicilQuery IS NOT NULL AND pd.Sicil = @sicilQuery)
       OR CHARINDEX(@query, COALESCE(pd.DisplayName, N'') COLLATE Turkish_100_CI_AI) > 0
    ORDER BY MatchRank, pd.DisplayName, pd.Sicil;
  `);

  return {
    query,
    limit: DIRECTORY_SEARCH_LIMIT,
    items: (result.recordset || []).map(directoryPerson)
  };
}
