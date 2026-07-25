// MERGEN Rota · kurumsal WBS kaynağı (CN43N) ve arayüz düzeltmeleri için gerileme testleri.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ACTUAL_ID_PATTERN,
  canonicalActualId,
  extractActualId,
  isActualId,
  sameActualId
} from '../src/domain/identity/actualId.js';
import { isCorporateProject, supportsManualWbsEditing } from '../src/domain/projectTypes.js';
import {
  normalizeCorporateWbsRow,
  planCorporateWbsNodes
} from '../src/server/repository/corporateWbsProjection.js';
import { appStateReducer, createLoadingState } from '../src/state/appState.js';
import { validateProjectCreationInput } from '../src/state/projectCreation.js';
import { resolveWbsMutationAccess } from '../src/state/projectWritePolicy.js';
import { registerServerOnlyShim } from './helpers/serverOnlyShim.mjs';

registerServerOnlyShim();
// Sunucu modülleri `server-only` kancası kurulduktan sonra yüklenir.
const { buildCorporateWbsSourceQuery } = await import('../src/server/repository/corporateWbsQueries.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

/* ── Gerçek Sistem kimlikleri ────────────────────────────────── */

test('kurumsal kaynaktan gelen GUID biçimleri geçerli Gerçek Sistem kimliği sayılır', () => {
  // SAP kaynaklı GUID'ler RFC 4122 sürüm/varyant bitlerini taşımaz.
  const corporate = 'D5D70AEC-0A88-F111-9136-00505699BACD';
  assert.equal(isActualId(corporate), true);
  assert.equal(canonicalActualId(corporate), corporate.toLowerCase());
  assert.equal(ACTUAL_ID_PATTERN.test(corporate), true);
});

test('kimlik karşılaştırmaları büyük/küçük harf farkını yok sayar', () => {
  assert.equal(sameActualId('DED70AEC-0A88-F111-9136-005056998ACD', 'ded70aec-0a88-f111-9136-005056998acd'), true);
  assert.equal(sameActualId('DED70AEC-0A88-F111-9136-005056998ACD', 'ded70aec-0a88-f111-9136-005056998acc'), false);
});

test('önekli istemci kimliklerinden Gerçek Sistem kimliği ayıklanır', () => {
  assert.equal(extractActualId('wbs-D5D70AEC-0A88-F111-9136-00505699BACD'), 'd5d70aec-0a88-f111-9136-00505699bacd');
  assert.equal(extractActualId('geçersiz-kimlik'), null);
});

test('geçersiz kimlikler kanonikleştirilemez', () => {
  assert.equal(canonicalActualId('123'), null);
  assert.equal(canonicalActualId(''), null);
  assert.equal(canonicalActualId(null), null);
});

/* ── CN43N → WBS izdüşümü ────────────────────────────────────── */

function sourceRows() {
  return [
    { 'Proje tanımı': 'p4417041', 'WBS element': 'P4417041.02.01', Name: 'Montaj', Level: 2, Status: 'CRTD', 'PYP kodu': '2.1', 'Proj.type': 'gd' },
    { 'Proje tanımı': 'P4417041', 'WBS element': 'P4417041.01', Name: 'Sistem Tasarımı', Level: 1, Status: 'REL', 'PYP kodu': '1', 'Proj.type': 'GD' },
    { 'Proje tanımı': 'P4417041', 'WBS element': 'P4417041.02', Name: 'Üretim', Level: 1, Status: 'CRTD', 'PYP kodu': '2', 'Proj.type': 'GD' },
    { 'Proje tanımı': 'P4417041', 'WBS element': 'P4417041.01.01', Name: 'Gereksinim', Level: 2, Status: 'REL', 'PYP kodu': '1.1', 'Proj.type': 'GD' },
    { 'Proje tanımı': 'P4417041', 'WBS element': 'P4417041.01.01.01', Name: 'Analiz', Level: 3, Status: 'REL', 'PYP kodu': '1.1.1', 'Proj.type': 'GD' }
  ];
}

test('CN43N satırları kanonik alan adlarına indirilir', () => {
  const normalized = normalizeCorporateWbsRow(sourceRows()[0]);
  assert.deepEqual(normalized, {
    projectCode: 'P4417041',
    sourceKey: 'P4417041.02.01',
    name: 'Montaj',
    level: 2,
    outlineCode: '2.1',
    statusCode: 'CRTD',
    elementTypeCode: 'GD'
  });
  assert.equal(normalizeCorporateWbsRow({ 'Proje tanımı': 'X', 'WBS element': '  ' }), null);
});

test('PYP kodu hiyerarşiyi kurar ve üst düğümler alt düğümlerden önce sıralanır', () => {
  const planned = planCorporateWbsNodes(sourceRows());
  const nodes = planned.get('P4417041');
  assert.equal(nodes.length, 5);
  assert.deepEqual(nodes.map((node) => node.sourceKey), [
    'P4417041.01',
    'P4417041.02',
    'P4417041.01.01',
    'P4417041.02.01',
    'P4417041.01.01.01'
  ]);

  const byKey = new Map(nodes.map((node) => [node.sourceKey, node]));
  // Seviye 1 düğümleri proje kök düğümüne (parentSourceKey = null) bağlanır.
  assert.equal(byKey.get('P4417041.01').parentSourceKey, null);
  assert.equal(byKey.get('P4417041.01.01').parentSourceKey, 'P4417041.01');
  assert.equal(byKey.get('P4417041.01.01.01').parentSourceKey, 'P4417041.01.01');
  assert.equal(byKey.get('P4417041.02.01').parentSourceKey, 'P4417041.02');
  assert.equal(byKey.get('P4417041.02.01').sortOrder, 1);
});

test('projenin kendisi WBS elemanı olarak gelirse düğüm olarak eklenmez', () => {
  const planned = planCorporateWbsNodes([
    { 'Proje tanımı': 'P4417041', 'WBS element': 'P4417041', Name: 'Proje', Level: 1, 'PYP kodu': '1' },
    { 'Proje tanımı': 'P4417041', 'WBS element': 'P4417041.01', Name: 'Alt', Level: 2, 'PYP kodu': '1.1' }
  ]);
  const nodes = planned.get('P4417041');
  assert.deepEqual(nodes.map((node) => node.sourceKey), ['P4417041.01']);
  // Üstü kaldırıldığı için düğüm projenin kök düğümüne bağlanır.
  assert.equal(nodes[0].parentSourceKey, null);
});

test('eksik veya bozuk anahat kodları düğümü köke bağlar ve döngü oluşturmaz', () => {
  const planned = planCorporateWbsNodes([
    { 'Proje tanımı': 'PX', 'WBS element': 'PX.01', Name: 'Anahatsız', Level: 2, 'PYP kodu': '' },
    { 'Proje tanımı': 'PX', 'WBS element': 'PX.02', Name: 'Kayıp üst', Level: 3, 'PYP kodu': '9.9.9' }
  ]);
  const nodes = planned.get('PX');
  assert.equal(nodes.length, 2);
  assert.deepEqual(nodes.map((node) => node.parentSourceKey), [null, null]);
});

test('aynı WBS elemanı yinelendiğinde anahat kodu dolu satır yeğlenir', () => {
  const planned = planCorporateWbsNodes([
    { 'Proje tanımı': 'PX', 'WBS element': 'PX.01', Name: 'Kayıt', Level: 1, 'PYP kodu': '' },
    { 'Proje tanımı': 'PX', 'WBS element': 'PX.01', Name: 'Kayıt', Level: 1, 'PYP kodu': '3' }
  ]);
  const nodes = planned.get('PX');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].outlineCode, '3');
  assert.equal(nodes[0].sortOrder, 3);
});

test('CN43N kaynak sorgusu proje kodlarını parametreleştirir', () => {
  const query = buildCorporateWbsSourceQuery({ schema: 'dbo', table: 'CN43N' }, 3);
  assert.match(query, /FROM \[dbo\]\.\[CN43N\]/);
  assert.match(query, /IN \(@code0, @code1, @code2\)/);
  // Kolon adları kurumsal tablodaki adlarla birebir eşleşir.
  for (const column of ['Proje tanımı', 'WBS element', 'Name', 'Level', 'Status', 'PYP kodu', 'Proj.type']) {
    assert.ok(query.includes(`[${column}]`), column);
  }
});

test('kurumsal WBS veritabanı yapılandırması ayrı bağlantı olarak tanımlanır', () => {
  const env = read('.env.example');
  for (const key of [
    'MERGEN_ROTA_WBS_DB_SERVER',
    'MERGEN_ROTA_WBS_DB_DATABASE',
    'MERGEN_ROTA_WBS_DB_SCHEMA',
    'MERGEN_ROTA_WBS_DB_TABLE'
  ]) {
    assert.ok(env.includes(key), key);
  }
  const config = read('src/server/db/corporateWbsConfig.js');
  // Şema/tablo adları sorguya gömüldüğü için sade tanımlayıcı olmak zorundadır.
  assert.match(config, /IDENTIFIER_PATTERN/);
  assert.match(config, /export function isCorporateWbsSourceConfigured/);
});

test('kurumsal WBS eşitlemesi kaynak erişilemediğinde anlık görüntüyü engellemez', () => {
  const sync = read('src/server/repository/corporateWbsSync.js');
  assert.match(sync, /catch \(cause\) \{/);
  assert.match(sync, /SOURCE_UNAVAILABLE/);
  assert.match(sync, /NOT_CONFIGURED/);
});

test('kurumsal WBS eşitlemesi yalnızca CORPORATE kaynaklı satırlara dokunur', () => {
  const merge = read('src/server/repository/corporateWbsQueries.js');
  assert.match(merge, /AND target\.SourceType = 'CORPORATE'/);
  // Kök düğüm (SourceKey NULL) ve görev/alt düğüm bağı olanlar silinmez.
  assert.match(merge, /AND target\.SourceKey IS NOT NULL/);
  assert.match(merge, /NOT EXISTS \(SELECT 1 FROM dbo\.MR_Tasks task WHERE task\.WbsId = target\.WbsId\)/);
});

/* ── Kurumsal WBS salt okunurluğu ────────────────────────────── */

test('kurumsal proje ayrımı ve WBS düzenleme yeteneği alan adlarından türetilir', () => {
  assert.equal(isCorporateProject({ source: 'corporate' }), true);
  assert.equal(isCorporateProject({ sourceType: 'CORPORATE' }), true);
  assert.equal(isCorporateProject({ source: 'manual' }), false);
  assert.equal(supportsManualWbsEditing({ source: 'manual' }), true);
  assert.equal(supportsManualWbsEditing({ source: 'corporate' }), false);
  assert.equal(supportsManualWbsEditing(null), false);
});

test('kurumsal projede WBS eylemleri istemci ilkesiyle reddedilir', () => {
  const state = {
    session: { dataMode: 'actual' },
    projects: [
      { id: 'p-corp', source: 'corporate', accessLevel: 'FULL' },
      { id: 'p-manual', source: 'manual', accessLevel: 'FULL' }
    ],
    wbs: [
      { id: 'w-corp', projectId: 'p-corp', parentId: null },
      { id: 'w-manual', projectId: 'p-manual', parentId: null }
    ]
  };
  const corporate = resolveWbsMutationAccess(state, 'w-corp');
  assert.equal(corporate.ok, false);
  assert.equal(corporate.code, 'CORPORATE_WBS_READ_ONLY');
  assert.equal(resolveWbsMutationAccess(state, 'w-manual').ok, true);

  // Demo modunda kurumsal kaynak yoktur: örnek projelerin ağacı denenebilir kalır.
  const demoState = { ...state, session: { dataMode: 'demo' } };
  assert.equal(resolveWbsMutationAccess(demoState, 'w-corp').ok, true);
});

test('kurumsal projelerin WBS ekranı düzenleme eylemlerini kapatır ve kaynağı açıklar', () => {
  const view = read('src/features/wbs/WbsView.jsx');
  assert.match(view, /const isCorporate = isActualDataMode && isCorporateProject\(workspace\.selectedProject\)/);
  assert.match(view, /const canEdit = canWriteProject\(workspace\.selectedProject\) && !isCorporate;/);
  assert.match(view, /CN43N/);
  // Görev taşıma paneli kurumsal projelerde de açık kalır: görev-WBS bağı MERGEN Rota verisidir.
  assert.match(view, /const canMoveTasks = canWriteProject\(workspace\.selectedProject\);/);
  assert.match(view, /\{canMoveTasks && wbs\.length > 0 && \(/);
});

test('sunucu kurumsal WBS yazma girişimlerini bağımsız olarak reddeder', () => {
  const repository = read('src/server/repository/sqlAppRepository.js');
  // İleti tek kaynakta (domain katmanı) tanımlanır; istemci ve sunucu aynı metni kullanır.
  assert.match(repository, /import \{ CORPORATE_WBS_READ_ONLY_MESSAGE \} from '\.\.\/\.\.\/domain\/projectTypes\.js';/);
  assert.match(read('src/domain/projectTypes.js'), /export const CORPORATE_WBS_READ_ONLY_MESSAGE/);
  assert.match(repository, /async function assertWbsProjectIsWritableStructure/);
  assert.match(repository, /await assertWbsProjectIsWritableStructure\(executor, projectId\);/);
  assert.match(repository, /if \(isCorporateSource\(before\.SourceType\)\) \{\s*throw new ServerPersistenceError\('FORBIDDEN', CORPORATE_WBS_READ_ONLY_MESSAGE\);/s);
});

test('kurumsal proje güncellemesi kaynak sistemin sorumlu bilgisini korur', () => {
  const repository = read('src/server/repository/sqlAppRepository.js');
  assert.match(repository, /LeadSicil = CASE WHEN SourceType = 'MANUAL' THEN @leadSicil ELSE LeadSicil END/);
});

test('MR_WBS şeması CN43N kolonlarını ve kaynak türünü taşır', () => {
  const schema = read('database/MR_Create_Durable_Persistence.sql');
  for (const column of ['SourceType varchar(20)', 'SourceKey nvarchar(255)', 'OutlineCode nvarchar(255)', 'WbsLevel int', 'StatusCode nvarchar(100)', 'ElementTypeCode nvarchar(10)']) {
    assert.ok(schema.includes(column), column);
  }
  assert.match(schema, /CONSTRAINT CK_MR_WBS_SourceType CHECK \(SourceType IN \('CORPORATE','MANUAL'\)\)/);
  assert.match(schema, /CREATE UNIQUE INDEX UX_MR_WBS_Project_SourceKey ON dbo\.MR_WBS\(ProjectId, SourceKey\) WHERE SourceKey IS NOT NULL/);
});

/* ── Veri tarihi (ilerleme kesim tarihi) ─────────────────────── */

test('veri tarihi zorunlu değildir ama geçersiz tarih reddedilir', () => {
  const context = {
    projects: [],
    people: [{ id: '10276', name: 'Zeynep Aydın' }],
    calendars: [{ id: 'c1' }]
  };
  const base = { name: 'Proje', leadId: '10276', calendarId: 'c1', color: 'blue' };
  assert.deepEqual(validateProjectCreationInput({ ...base, dataDate: '' }, context), []);
  assert.deepEqual(validateProjectCreationInput({ ...base }, context), []);
  const invalid = validateProjectCreationInput({ ...base, dataDate: '2026-02-31' }, context);
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].code, 'PROJECT_DATA_DATE_INVALID');
});

test('veri tarihi alanı ilerleme kesim tarihi olarak açıklanır', () => {
  for (const relativePath of ['src/components/shell/ProjectCreateDialog.jsx', 'src/features/project/ProjectWorkspaceView.jsx']) {
    const source = read(relativePath);
    assert.match(source, /İlerleme kesim tarihi/);
    assert.match(source, /Veri tarihi <span className="muted">\(isteğe bağlı\)<\/span>/);
  }
  const validation = read('src/server/repository/commitChangeValidation.js');
  assert.doesNotMatch(validation, /'Proje veri tarihi gereklidir\.'/);
});

/* ── Basit Mod · yalnızca proje oluşturma ────────────────────── */

test('Basit Mod görev tanımlamadan proje oluşturma yolu sunar', () => {
  const panel = read('src/features/simple/SimpleModePanel.jsx');
  assert.match(panel, /const createProjectOnly = async \(input\) => \{/);
  assert.match(panel, /addProject\(input, \{ focusWorkspace: false \}\)/);
  assert.match(panel, /<ProjectCreateDialog/);
  assert.match(panel, /Yeni proje/);
  assert.match(panel, /className="simple-entry-actions"/);
  assert.match(read('src/app/styles/simple-mode.css'), /\.simple-entry-actions \{/);
  // Pencere form ağacının dışında durur: iç içe <form> geçersizdir.
  assert.ok(panel.indexOf('</form>') < panel.indexOf('<ProjectCreateDialog'));
});

/* ── Uygulama kabuğu yeniden yüklemede sökülmez ──────────────── */

test('ilk yükleme tamamlandıktan sonra tazeleme kabuğu söktürmez', () => {
  let state = createLoadingState();
  assert.equal(state.hasLoadedOnce, false);

  state = appStateReducer(state, { type: 'data/load-success', snapshot: { projects: [], tasks: [], wbs: [] } });
  assert.equal(state.hasLoadedOnce, true);

  state = appStateReducer(state, { type: 'data/load-start' });
  assert.equal(state.dataStatus, 'loading');
  assert.equal(state.hasLoadedOnce, true, 'tazeleme sırasında önceki veri korunur');

  state = appStateReducer(state, { type: 'data/load-error', error: { message: 'kesinti' } });
  assert.equal(state.hasLoadedOnce, true);
});

test('veri sınırı perdesi yalnızca ilk yüklemede gösterilir', () => {
  const boundary = read('src/components/shell/AppDataBoundary.jsx');
  assert.match(boundary, /if \(dataStatus === 'loading' && !hasLoadedOnce\)/);
  assert.match(boundary, /if \(dataStatus === 'error' && !hasLoadedOnce\)/);
  const status = read('src/components/shell/PersistenceStatus.jsx');
  // Başarısız tazeleme, kabuk açık kalırken bildirim alanında görünür.
  assert.match(status, /const refreshFailed = dataStatus === 'error' && hasLoadedOnce;/);
  assert.match(status, /Veriler yenilenemedi/);
});

/* ── Proje Yapısı · yalnızca liste kaydırılır ────────────────── */

test('proje seçici başlığı ve tür süzgeçleri donuk kalır, liste kaydırılır', () => {
  const view = read('src/features/project/ProjectWorkspaceView.jsx');
  assert.match(view, /<div className="card project-browser">/);
  assert.match(view, /<div className="project-browser-head">/);
  assert.match(view, /<div className="project-browser-types">/);
  assert.match(view, /className="col project-browser-list"/);
  assert.ok(
    view.indexOf('project-browser-types') < view.indexOf('project-browser-list'),
    'tür süzgeçleri listeden önce ve donuk bölümde yer alır'
  );

  const css = read('src/app/styles/features.css');
  assert.match(css, /\.project-browser \{[^}]*display: flex;[^}]*\}/s);
  assert.match(css, /\.project-browser-head \{ flex: 0 0 auto; \}/);
  assert.match(css, /\.project-browser-list \{[^}]*overflow-y: auto;[^}]*\}/s);
});
