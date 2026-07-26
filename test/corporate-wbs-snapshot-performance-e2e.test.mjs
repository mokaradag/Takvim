/**
 * Kurumsal WBS anlık görüntü başarımı · uçtan uca.
 *
 * Sınanan davranış, gerçek zincirle çalışır:
 *   uygulama durumu → `createApiRepository` → `/api/mergen-rota/snapshot` rota
 *   gövdesi → izdüşümlü/sertleştirilmiş/temel SQL deposu → bellek içi SQL
 *   Server ikizi.
 *
 * Sorun: 38 bin satırlık CN43N kurulumunda her anlık görüntü isteği kurumsal
 * iş dağılım ağacının tamamını MR_WBS ile yeniden birleştiriyordu; tek bir
 * açılış 33 saniye sürüyordu. Buradaki savlar üretilen SQL deyimlerini sayarak
 * gereksiz işin GERÇEKTEN yapılmadığını gösterir; kaynak değiştiğinde ya da
 * depo bozulduğunda eşitlemenin yine çalıştığını da doğrular.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import sql from 'mssql';

import { createActualStack, corporateSeed } from './helpers/actualStack.mjs';
import { resetCorporateWbsSyncScheduleForTests } from '../src/server/repository/corporateWbsSyncSchedule.js';

const MERGE_STATEMENT = 'OPENJSON(@payload)';
const SOURCE_STATEMENT = 'WBS element';

function countStatements(stack, fragment) {
  return stack.db.statements.filter((entry) => entry.sql.includes(fragment)).length;
}

function resetStatements(stack) {
  stack.db.statements.length = 0;
  stack.db.transactions.length = 0;
}

/** Büyük bir kurumsal ağacı taklit eden CN43N satırları üretir. */
function cn43nRows(projectCode = 'P4417041', packageCount = 12, itemsPerPackage = 8) {
  const rows = [];
  for (let pkg = 1; pkg <= packageCount; pkg += 1) {
    const packageKey = `${projectCode}.${String(pkg).padStart(2, '0')}`;
    rows.push({
      'Proje tanımı': projectCode,
      'WBS element': packageKey,
      Name: `İş paketi ${pkg}`,
      Level: 1,
      Status: 'REL',
      'PYP kodu': String(pkg),
      'Proj.type': 'GD'
    });
    for (let item = 1; item <= itemsPerPackage; item += 1) {
      rows.push({
        'Proje tanımı': projectCode,
        'WBS element': `${packageKey}.${String(item).padStart(2, '0')}`,
        Name: `Aktivite ${pkg}.${item}`,
        Level: 2,
        Status: 'CRTD',
        'PYP kodu': `${pkg}.${item}`,
        'Proj.type': 'GD'
      });
    }
  }
  return rows;
}

const TOTAL_NODES = 12 * 9; // paket + alt kalemler
const TOTAL_WITH_ROOT = TOTAL_NODES + 1;

test('ilk yükleme kurumsal ağacı kurar, ikinci yükleme hiç birleştirme yapmaz', async () => {
  const stack = await createActualStack(corporateSeed({ corporateWbsRows: cn43nRows() }));
  try {
    const project = stack.project('P4417041');
    assert.equal(stack.projectWbs(project.id).length, TOTAL_WITH_ROOT, 'ilk yüklemede ağacın tamamı kurulmalıdır');
    assert.ok(countStatements(stack, MERGE_STATEMENT) >= 1, 'ilk yükleme birleştirme yapmalıdır');

    resetStatements(stack);
    await stack.reload();

    assert.equal(
      countStatements(stack, MERGE_STATEMENT),
      0,
      'kaynak değişmediğinde ikinci yükleme MR_WBS birleştirmesi çalıştırmamalıdır'
    );
    assert.equal(stack.projectWbs(project.id).length, TOTAL_WITH_ROOT, 'atlanan eşitleme ağacı bozmamalıdır');
  } finally {
    await stack.dispose();
  }
});

test('kaynak içeriği değiştiğinde birleştirme yeniden çalışır', async () => {
  const stack = await createActualStack(corporateSeed({ corporateWbsRows: cn43nRows() }));
  try {
    const project = stack.project('P4417041');
    resetStatements(stack);
    await stack.reload();
    assert.equal(countStatements(stack, MERGE_STATEMENT), 0);

    // Tek bir elemanın adı değişse bile parmak izi değişir.
    const rows = cn43nRows();
    rows.find((row) => row['WBS element'] === 'P4417041.03.05').Name = 'Aktivite 3.5 (revize)';
    stack.db.corporateWbsRows = rows;

    resetStatements(stack);
    await stack.reload();
    assert.equal(countStatements(stack, MERGE_STATEMENT), 1, 'değişen proje yeniden birleştirilmelidir');

    const renamed = stack.projectWbs(project.id).find((node) => node.code === 'P4417041.03.05');
    assert.equal(renamed.name, 'Aktivite 3.5 (revize)');
  } finally {
    await stack.dispose();
  }
});

test('kaynaktan eleman düşerse atlama devreye girmez ve düğüm kaldırılır', async () => {
  const stack = await createActualStack(corporateSeed({ corporateWbsRows: cn43nRows() }));
  try {
    const project = stack.project('P4417041');
    stack.db.corporateWbsRows = cn43nRows().filter((row) => row['WBS element'] !== 'P4417041.05.04');

    resetStatements(stack);
    await stack.reload();

    assert.equal(countStatements(stack, MERGE_STATEMENT), 1);
    const codes = stack.projectWbs(project.id).map((node) => node.code);
    assert.equal(codes.includes('P4417041.05.04'), false);
    assert.equal(codes.length, TOTAL_WITH_ROOT - 1);
  } finally {
    await stack.dispose();
  }
});

test('depodaki düğümler silinirse parmak izi eşleşse bile eşitleme kendini onarır', async () => {
  const stack = await createActualStack(corporateSeed({ corporateWbsRows: cn43nRows() }));
  try {
    const project = stack.project('P4417041');
    // Parmak izi defteri dokunulmadan MR_WBS satırları dışarıdan siliniyor.
    stack.db.wbs = stack.db.wbs.filter((node) => node.SourceKey == null);

    resetStatements(stack);
    await stack.reload();

    assert.equal(countStatements(stack, MERGE_STATEMENT), 1, 'depo boşaldığında birleştirme yeniden çalışmalıdır');
    assert.equal(stack.projectWbs(project.id).length, TOTAL_WITH_ROOT);
  } finally {
    await stack.dispose();
  }
});

test('tazelik penceresi açıkken kurumsal kaynak hiç sorgulanmaz', async () => {
  process.env.MERGEN_ROTA_WBS_SYNC_TTL_MS = '600000';
  const stack = await createActualStack(corporateSeed({ corporateWbsRows: cn43nRows() }));
  try {
    assert.ok(countStatements(stack, SOURCE_STATEMENT) >= 1, 'ilk yükleme kaynağı okumalıdır');

    resetStatements(stack);
    await stack.reload();
    await stack.reload();

    assert.equal(countStatements(stack, SOURCE_STATEMENT), 0, 'pencere içindeki yüklemeler CN43N kaynağına gitmemelidir');
    assert.equal(countStatements(stack, MERGE_STATEMENT), 0);
    assert.equal(stack.projectWbs(stack.project('P4417041').id).length, TOTAL_WITH_ROOT);
  } finally {
    await stack.dispose();
    delete process.env.MERGEN_ROTA_WBS_SYNC_TTL_MS;
  }
});

test('kurumsal katalog tazelemesi serileştirilebilir okuma işleminin dışında kalır', async () => {
  const stack = await createActualStack(corporateSeed({ corporateWbsRows: cn43nRows() }));
  try {
    resetStatements(stack);
    stack.db.corporateWbsRows = cn43nRows(); // içerik aynı, yine de ilk tur için kaynağı oku
    await stack.reload();

    const serializable = stack.db.transactions.filter((entry) => entry.isolationLevel === sql.ISOLATION_LEVEL.SERIALIZABLE);
    assert.ok(serializable.length >= 1, 'anlık görüntü okuması serileştirilebilir işlem kullanmalıdır');

    // Katalog tazelemesi READ COMMITTED bir işlemde ve okumadan ÖNCE biter.
    const readCommitted = stack.db.transactions.filter((entry) => entry.isolationLevel === sql.ISOLATION_LEVEL.READ_COMMITTED);
    assert.ok(readCommitted.length >= 1, 'kurumsal proje eşitlemesi kendi hafif işlemini kullanmalıdır');

    const mergeIndexes = stack.db.statements
      .map((entry, index) => (entry.sql.includes(MERGE_STATEMENT) ? index : -1))
      .filter((index) => index >= 0);
    for (const index of mergeIndexes) {
      assert.ok(
        index < serializable[0].statementIndex,
        'CN43N birleştirmesi serileştirilebilir işlem başlamadan önce bitmelidir'
      );
    }
  } finally {
    await stack.dispose();
  }
});

test('kaynak erişilemediğinde tazelik penceresi ilerletilmez', async () => {
  // Pencere açık olsa bile başarısız bir tazeleme onu ilerletmemelidir; aksi
  // hâlde kurumsal kaynaktaki geçici bir kesinti, ağacın TTL boyunca hiç
  // denenmemesine yol açar.
  const stack = await createActualStack(corporateSeed({ corporateWbsRows: cn43nRows() }));
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    // Kurulum yüklemesi başarılıydı; pencere buradan itibaren ölçülür.
    process.env.MERGEN_ROTA_WBS_SYNC_TTL_MS = '600000';
    resetCorporateWbsSyncScheduleForTests();

    stack.db.corporateWbsRows = null; // kaynak düşer
    resetStatements(stack);
    await stack.reload();
    assert.ok(countStatements(stack, SOURCE_STATEMENT) >= 1, 'başarısız tur kaynağı denemelidir');

    // Kaynak geri gelir: pencere ilerletilmediği için bir sonraki istek dener.
    const rows = cn43nRows();
    rows.find((row) => row['WBS element'] === 'P4417041.02.03').Name = 'Aktivite 2.3 (revize)';
    stack.db.corporateWbsRows = rows;

    resetStatements(stack);
    await stack.reload();
    assert.ok(countStatements(stack, SOURCE_STATEMENT) >= 1, 'başarısızlık sonrası kaynak yeniden okunmalıdır');
    assert.equal(countStatements(stack, MERGE_STATEMENT), 1, 'kaynak döndüğünde birleştirme yapılmalıdır');

    const renamed = stack.projectWbs(stack.project('P4417041').id).find((node) => node.code === 'P4417041.02.03');
    assert.equal(renamed.name, 'Aktivite 2.3 (revize)');

    // Başarılı tur penceresi ilerletir: sonraki istek kaynağa hiç gitmez.
    resetStatements(stack);
    await stack.reload();
    assert.equal(countStatements(stack, SOURCE_STATEMENT), 0);
  } finally {
    console.warn = originalWarn;
    await stack.dispose();
    delete process.env.MERGEN_ROTA_WBS_SYNC_TTL_MS;
  }
});

test('kurumsal kaynak yapılandırılmadığında pencere yine de ilerler', async () => {
  // Kaynak hiç tanımlı değilse yapılacak iş yoktur; proje eşitlemesinin her
  // istekte yeniden çalışmaması için tazeleme başarılı sayılır.
  process.env.MERGEN_ROTA_WBS_SYNC_TTL_MS = '600000';
  const stack = await createActualStack(corporateSeed({ corporateWbsRows: cn43nRows() }), { corporateWbsSource: false });
  try {
    resetStatements(stack);
    await stack.reload();
    assert.equal(
      countStatements(stack, 'FROM dbo.MR_V_CorporateProjects'),
      0,
      'pencere içindeki yükleme kurumsal proje eşitlemesini yeniden çalıştırmamalıdır'
    );
  } finally {
    await stack.dispose();
    delete process.env.MERGEN_ROTA_WBS_SYNC_TTL_MS;
  }
});

test('uzun proje kodları eşitleme durumu anahtarında kırpılmaz', async () => {
  // MR_Projects.ProjectCode 255 karaktere kadar izin verir. Anahtar kırpılırsa
  // parmak izi tam kodla hiç bulunamaz ve birleştirme her istekte tekrarlanır.
  const longCode = `P${'4'.repeat(150)}`;
  const seed = corporateSeed({ corporateWbsRows: cn43nRows(longCode) });
  seed.corporateProjects = [{ ProjectCode: longCode, ProjectName: 'Uzun kodlu proje', ProjectTypeCode: 'GD', ProjectTypeName: 'Garanti dışı faaliyetler' }];
  seed.projects = [{ ...seed.projects[0], ProjectCode: longCode, ProjectName: 'Uzun kodlu proje' }];
  seed.wbs = [{ ...seed.wbs[0], Code: longCode.slice(0, 100), Name: 'Uzun kodlu proje' }];

  const stack = await createActualStack(seed);
  try {
    const project = stack.project(longCode);
    assert.ok(project, 'uzun kodlu proje yüklenmelidir');
    assert.equal(stack.projectWbs(project.id).length, TOTAL_WITH_ROOT);

    const stateKeys = stack.db.corporateWbsSyncState.map((entry) => entry.ProjectCode);
    assert.deepEqual(stateKeys, [longCode.toUpperCase()], 'anahtar tam proje kodu olmalıdır');

    resetStatements(stack);
    await stack.reload();
    assert.equal(countStatements(stack, MERGE_STATEMENT), 0, 'uzun kodlu projede de parmak izi birleştirmeyi bastırmalıdır');
  } finally {
    await stack.dispose();
  }
});

test('eşitleme başarısız olsa bile anlık görüntü yüklenir', async () => {
  const stack = await createActualStack(corporateSeed({ corporateWbsRows: cn43nRows() }));
  try {
    const project = stack.project('P4417041');
    // Kaynak veritabanı düşer: eşitleme uyarı verir, anlık görüntü sürer.
    stack.db.corporateWbsRows = null;
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args[0]);
    try {
      await stack.reload();
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(warnings.length >= 1, true, 'kaynak hatası günlüğe uyarı olarak yazılmalıdır');
    assert.equal(stack.projectWbs(project.id).length, TOTAL_WITH_ROOT, 'önceden eşitlenmiş ağaç korunmalıdır');
  } finally {
    await stack.dispose();
  }
});
