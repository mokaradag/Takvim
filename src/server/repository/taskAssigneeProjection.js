import { canonicalActualId } from '../../domain/identity/actualId.js';

// Satır kimlikleri kanonikleştirilir: SQL Server büyük harfli GUID döndürür,
// anlık görüntüdeki görev kimlikleri ise kanonik küçük harftir.
function rowId(value) {
  return value == null ? '' : (canonicalActualId(value) ?? String(value));
}

/**
 * Görev başına SIRALI sorumlu kayıtları.
 *
 * Üç dizi (kimlikler, görünen adlar, fotoğraf kimlikleri) tek bir kayıt
 * listesinden türetilir. Diziler ayrı ayrı doldurulduğunda yinelenen bir satır
 * `continue` ile tamamen atlanıyor ve o satırın (ilkinde boş olan) görünen adı
 * ile fotoğraf kimliği de birlikte düşüyordu.
 *
 * `assigneeIds` bilinçli olarak `assigneeDisplayNames` dizisinden KISA olabilir:
 * göreve atanmış bir kullanıcı, kimliği kendisine kapalı olan eş sorumlunun
 * ADINI görür ama Sicil'ini görmez (bkz. loadVisibleTaskAssignees, maskelenen
 * `Sicil` sütunu). Bu yüzden iki dizi konum konum EŞLENEMEZ; tüketiciler
 * kimliği ada göre çözer (bkz. workloadProjection).
 */
function collectAssigneeRecords(rows) {
  const recordsByTask = new Map();
  const indexByKey = new Map();

  for (const row of rows || []) {
    const taskId = rowId(row?.TaskId);
    if (!taskId) continue;
    const sicil = row?.Sicil == null ? '' : String(row.Sicil);
    const displayName = row?.DisplayName == null ? '' : String(row.DisplayName).trim();
    const avatarEmployeeNo = row?.AvatarEmployeeNo == null ? sicil : String(row.AvatarEmployeeNo);
    if (!sicil && !displayName) continue;

    if (!recordsByTask.has(taskId)) recordsByTask.set(taskId, []);
    const records = recordsByTask.get(taskId);
    // Aynı sorumlunun ikinci satırı yeni kayıt AÇMAZ, var olanı tamamlar.
    // Anahtar önce maskelenmemiş Sicil, yoksa fotoğraf kimliği, o da yoksa addır.
    const key = `${taskId}:${sicil || avatarEmployeeNo || `ad:${displayName}`}`;
    const existingIndex = indexByKey.get(key);
    if (existingIndex == null) {
      indexByKey.set(key, records.length);
      records.push({ sicil, displayName, avatarEmployeeNo });
      continue;
    }
    const existing = records[existingIndex];
    if (!existing.sicil && sicil) existing.sicil = sicil;
    if (!existing.displayName && displayName) existing.displayName = displayName;
    if (!existing.avatarEmployeeNo && avatarEmployeeNo) existing.avatarEmployeeNo = avatarEmployeeNo;
  }

  return recordsByTask;
}

export function applyTaskAssigneeProjection(snapshot = {}, rows = []) {
  const recordsByTask = collectAssigneeRecords(rows);

  return {
    ...snapshot,
    tasks: (snapshot.tasks || []).map((task) => {
      const records = recordsByTask.get(rowId(task.id)) || [];
      return {
        ...task,
        assigneeIds: records.filter((record) => record.sicil).map((record) => record.sicil),
        assigneeDisplayNames: records.filter((record) => record.displayName).map((record) => record.displayName),
        // Fotoğraf için gereken Sicil yalnızca bu yetkili görev satırında taşınır;
        // genel `people` dizinine hiçbir eş sorumlu eklenmez.
        assigneeAvatarIdentities: records
          .filter((record) => record.displayName && record.avatarEmployeeNo)
          .map((record) => ({ name: record.displayName, employeeNo: record.avatarEmployeeNo }))
      };
    })
  };
}
