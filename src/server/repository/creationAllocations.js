import 'server-only';
import { randomUUID } from 'node:crypto';
import { canonicalActualId } from '../../domain/identity/actualId.js';
import { creationEntries, remapCommitIds } from '../../domain/identity/creationIds.js';
import { sql } from '../db/pool.js';
import { ServerPersistenceError } from '../errors.js';
import { MAX_COMMIT_TOTAL_ENTRIES } from './commitChangeValidation.js';

const MAX_PENDING_ALLOCATIONS = MAX_COMMIT_TOTAL_ENTRIES * 2;
// Süresi dolmuş veya kaldırılmış satır bırakma denemesi için bağlı tüketmeme makbuzudur.
const RELEASE_RECEIPT_DAYS = 7;

function invalidAllocation() {
  return new ServerPersistenceError('CONFLICT', 'Oluşturma kimliği onaylanamadı. Verileri yeniden yükleyin.', {
    details: { code: 'CREATION_ALLOCATION_INVALID' }
  });
}

async function allocationQuery(request, query) {
  try {
    return await request.query(query);
  } catch (error) {
    if (Number(error.number) !== 208) throw error;
    throw new ServerPersistenceError('DATABASE_UNAVAILABLE',
      'Oluşturma kimliği şeması bulunamadı. 0019 veritabanı geçişi uygulanmalıdır.', { cause: error });
  }
}

/** Yeni sunucu kimliği ayrılır; çağıranın kimliği yalnızca başvuru etiketidir. */
export async function allocateCreationIds(transaction, actor, changes, authorize) {
  const requested = creationEntries(changes).filter(({ entry }) => !entry.creationProof);
  if (!requested.length) return { allocations: [] };
  const mappings = new Map(requested.map(({ entry, entityType }) => [`${entityType}:${entry.id}`, randomUUID()]));
  const proposed = remapCommitIds(changes, mappings);
  // Aynı oluşturma kapsam politikası kayıtta yeniden çalışır. Tahsis değişim yetkisi
  // veya çağıranın seçtiği kimliğin varlık kanıtı değildir.
  await authorize(proposed);
  const allocations = requested.map(({ entry, entityType }) => ({
    clientId: entry.id, entityType, id: mappings.get(`${entityType}:${entry.id}`),
    projectId: entityType === 'PROJECT' ? mappings.get(`PROJECT:${entry.id}`)
      : (mappings.get(`PROJECT:${entry.projectId}`) || entry.projectId),
    proof: randomUUID()
  }));
  const request = transaction.request();
  request.input('sicil', sql.Int, actor.sicil);
  request.input('allocations', sql.NVarChar(sql.MAX), JSON.stringify(allocations));
  request.input('pendingLimit', sql.Int, MAX_PENDING_ALLOCATIONS);
  request.input('receiptDays', sql.Int, RELEASE_RECEIPT_DAYS);
  const result = await allocationQuery(request, `
    -- creation-allocation: reserve; sahip aralığı eşzamanlı tahsisleri serileştirir.
    DECLARE @pending int;
    SELECT @pending = COUNT(*) FROM dbo.MR_CreationAllocations WITH (UPDLOCK, HOLDLOCK)
    WHERE Sicil = @sicil AND ExpiresAt > SYSUTCDATETIME();
    DELETE TOP (4000) FROM dbo.MR_CreationAllocations
    WHERE Sicil = @sicil AND ExpiresAt <= DATEADD(day, -@receiptDays, SYSUTCDATETIME());
    SELECT @pending = COUNT(*) FROM dbo.MR_CreationAllocations WHERE Sicil = @sicil AND ExpiresAt > SYSUTCDATETIME();
    DECLARE @retained int = (SELECT COUNT(*) FROM dbo.MR_CreationAllocations WHERE Sicil = @sicil);
    DECLARE @issued TABLE (EntityId uniqueidentifier, EntityType varchar(7), ProjectId uniqueidentifier, Proof uniqueidentifier);
    INSERT @issued SELECT id, entityType, projectId, proof FROM OPENJSON(@allocations)
      WITH (id uniqueidentifier, entityType varchar(7), projectId uniqueidentifier, proof uniqueidentifier);
    IF @pending + (SELECT COUNT(*) FROM @issued) > @pendingLimit
      OR @retained + (SELECT COUNT(*) FROM @issued) > @pendingLimit * 4
      SELECT 0 AS Reserved;
    ELSE BEGIN
      -- Bu genel çakışma denetimlerine yalnızca öngörülemez sunucu adayları ulaşır.
      IF EXISTS (SELECT 1 FROM @issued i WHERE
          EXISTS (SELECT 1 FROM dbo.MR_Projects WITH (UPDLOCK, HOLDLOCK) WHERE ProjectId = i.EntityId)
          OR EXISTS (SELECT 1 FROM dbo.MR_WBS WITH (UPDLOCK, HOLDLOCK) WHERE WbsId = i.EntityId)
          OR EXISTS (SELECT 1 FROM dbo.MR_Tasks WITH (UPDLOCK, HOLDLOCK) WHERE TaskId = i.EntityId)
          OR EXISTS (SELECT 1 FROM dbo.MR_CreationAllocations WITH (UPDLOCK, HOLDLOCK) WHERE EntityId = i.EntityId))
        THROW 51019, 'Creation allocation collision', 1;
      INSERT dbo.MR_CreationAllocations (Proof, Sicil, EntityType, EntityId, ProjectId, ExpiresAt)
      SELECT Proof, @sicil, EntityType, EntityId, ProjectId, DATEADD(hour, 24, SYSUTCDATETIME()) FROM @issued;
      SELECT 1 AS Reserved;
    END;
  `);
  if (!result.recordset?.[0]?.Reserved) throw new ServerPersistenceError('CONFLICT',
    'Bekleyen oluşturma sınırına ulaşıldı. Bekleyen kayıtları tamamlayın.', { details: { code: 'CREATION_ALLOCATION_LIMIT' } });
  return { allocations };
}

/** Aynı kayıt işlemi içinde her aday nesne okumasından önce çalışmalıdır. */
export async function consumeCreationAllocations(transaction, actor, changes) {
  const entries = creationEntries(changes);
  if (!entries.length) return;
  const allocations = entries.map(({ entry, entityType }) => ({ id: entry.id, entityType,
    projectId: entityType === 'PROJECT' ? entry.id : entry.projectId,
    proof: canonicalActualId(entry.creationProof) }));
  if (allocations.some((entry) => !entry.proof)) throw invalidAllocation();
  const request = transaction.request();
  request.input('sicil', sql.Int, actor.sicil);
  request.input('allocations', sql.NVarChar(sql.MAX), JSON.stringify(allocations));
  const result = await allocationQuery(request, `
    -- creation-allocation: consume. Silme kalıcı tek kullanımlık tüketimdir;
    -- geri alma bunu yükler. Eksik yabancı süresi dolmuş ve yinelenen kanıt ayırt edilmez.
    DELETE a OUTPUT deleted.Proof
    FROM dbo.MR_CreationAllocations a WITH (UPDLOCK, HOLDLOCK)
    JOIN OPENJSON(@allocations) WITH (id uniqueidentifier, entityType varchar(7), projectId uniqueidentifier, proof uniqueidentifier) i
      ON a.Proof = i.proof AND a.EntityId = i.id AND a.EntityType = i.entityType AND a.ProjectId = i.projectId
    WHERE a.Sicil = @sicil AND a.ExpiresAt > SYSUTCDATETIME();
  `);
  if (result.recordset?.length !== allocations.length) throw invalidAllocation();
}

/** Süre dolsa da tüketilmemiş yetenek kaldırılarak uzlaştırılır. ExpiresAt kaldırmayı da gösterir; bağlı satır denemeyi eşgüçlü yapar. Eksik tüketilmiş veya yabancı yetenek ayırt edilmeden reddedilir. Varlık araması yetkilendirilmez; aynı işlem kilidi kayıtla sıralar ve kanıtı yalnızca biri tüketebilir. */
export async function releaseCreationIds(transaction, actor, changes) {
  const allocations = creationEntries(changes).map(({ entry, entityType }) => ({ id: entry.id, entityType,
    projectId: entityType === 'PROJECT' ? entry.id : entry.projectId, proof: canonicalActualId(entry.creationProof) }));
  if (!allocations.length || allocations.some((entry) => !entry.proof)) throw invalidAllocation();
  const request = transaction.request();
  request.input('sicil', sql.Int, actor.sicil);
  request.input('allocations', sql.NVarChar(sql.MAX), JSON.stringify(allocations));
  const result = await allocationQuery(request, `
    -- creation-allocation: release; bağlı tüketmeme makbuzu korunur.
    UPDATE a SET ExpiresAt = CASE WHEN a.ExpiresAt > DATEADD(second, -1, SYSUTCDATETIME())
      THEN DATEADD(second, -1, SYSUTCDATETIME()) ELSE a.ExpiresAt END
    OUTPUT inserted.Proof
    FROM dbo.MR_CreationAllocations a WITH (UPDLOCK, HOLDLOCK)
    JOIN OPENJSON(@allocations) WITH (id uniqueidentifier, entityType varchar(7), projectId uniqueidentifier, proof uniqueidentifier) i
      ON a.Proof = i.proof AND a.EntityId = i.id AND a.EntityType = i.entityType AND a.ProjectId = i.projectId
    WHERE a.Sicil = @sicil;
  `);
  const released = new Set((result.recordset || []).map((row) => canonicalActualId(row.Proof)));
  return { released: allocations.filter((entry) => released.has(entry.proof))
    .map(({ id, entityType }) => ({ id, entityType })) };
}
