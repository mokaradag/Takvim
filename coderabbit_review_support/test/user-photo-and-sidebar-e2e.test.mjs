/**
 * Kullanıcı fotoğrafı + kenar çubuğu kimliği — UÇTAN UCA.
 *
 * Zincir gerçek kodla kurulur:
 *   imzalı Keycloak jetonu → gerçek `/auth/session` rotası → HttpOnly çerez
 *   → gerçek `/api/mergen-rota/session` (SQL ikizi + yetkilendirme)
 *   → `session.currentUser` → kenar çubuğu etiketleri + fotoğraf URL'si
 *
 * Fotoğraf taban adresi TESTE ÖZGÜ ve sentetiktir; gerçek kurum içi adres
 * hiçbir yerde bulunmaz.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { corporateSeed, createActualStack } from './helpers/actualStack.mjs';
import {
  TEST_SICIL,
  accessTokenClaims,
  applyKeycloakEnvironment,
  createSigningKey,
  installJwksEndpoint,
  loadAuthModules,
  readSetCookie,
  sessionExchangeRequest,
  signJwt
} from './helpers/keycloakStack.mjs';
import { SESSION_COOKIE_NAME } from '../src/server/identity/keycloakSessionCookie.js';
import {
  USER_DEPARTMENT_FALLBACK,
  buildSessionCurrentUser,
  resolveUserDepartmentLabel,
  resolveUserDisplayName
} from '../src/domain/identity/sessionUser.js';
import {
  buildUserPhotoUrl,
  isPhotographableEmployeeNo,
  normalizeUserPhotoBaseUrl,
  personPhotoUrl
} from '../src/lib/userPhoto.js';
import { createPersonLookup, resolveAvatarEntries } from '../src/components/avatarIdentity.js';

const PHOTO_BASE = 'https://fotograf.test.internal/kurumsal/personel';
const signingKey = createSigningKey('photo-key-1');
const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

/* ── Merkezî fotoğraf URL yardımcısı ────────────────────── */

test('fotoğraf URL yardımcısı sicilden beklenen adresi üretir', () => {
  assert.equal(buildUserPhotoUrl('900001', PHOTO_BASE), `${PHOTO_BASE}/900001.jpg`);
  assert.equal(buildUserPhotoUrl(900001, PHOTO_BASE), `${PHOTO_BASE}/900001.jpg`);
});

test('taban adresteki sondaki eğik çizgiler normalize edilir', () => {
  for (const base of [`${PHOTO_BASE}/`, `${PHOTO_BASE}///`, ` ${PHOTO_BASE}/ `]) {
    assert.equal(buildUserPhotoUrl('900001', base), `${PHOTO_BASE}/900001.jpg`);
  }
  assert.equal(normalizeUserPhotoBaseUrl(`${PHOTO_BASE}/`), PHOTO_BASE);
  assert.equal(normalizeUserPhotoBaseUrl('   '), '');
});

test('sicil değeri URL için güvenli biçimde kodlanır', () => {
  // Yalnızca rakamlardan oluşan değerler kabul edilir; kodlama yine de uygulanır.
  assert.equal(buildUserPhotoUrl('00900001', PHOTO_BASE), `${PHOTO_BASE}/00900001.jpg`);
  for (const unsafe of ['../gizli', '900001/../../etc', 'a b', '900001?x=1', '900001#frag']) {
    assert.equal(buildUserPhotoUrl(unsafe, PHOTO_BASE), null, unsafe);
  }
});

test('taban adres veya sicil yoksa fotoğraf URL üretilmez (baş harf yedeği)', () => {
  assert.equal(buildUserPhotoUrl('900001', ''), null);
  assert.equal(buildUserPhotoUrl('900001', '   '), null);
  for (const missing of [null, undefined, '', '   ', '0', '000', 'demo-user', 'unknown']) {
    assert.equal(buildUserPhotoUrl(missing, PHOTO_BASE), null, String(missing));
    assert.equal(isPhotographableEmployeeNo(missing), false, String(missing));
  }
});

test('personPhotoUrl person nesnesinden sicili çözer', () => {
  assert.equal(personPhotoUrl({ employeeNo: '900001' }, PHOTO_BASE), `${PHOTO_BASE}/900001.jpg`);
  assert.equal(personPhotoUrl({ sicil: 900002 }, PHOTO_BASE), `${PHOTO_BASE}/900002.jpg`);
  assert.equal(personPhotoUrl({ id: '900003' }, PHOTO_BASE), `${PHOTO_BASE}/900003.jpg`);
  assert.equal(personPhotoUrl({ id: 'u-demo' }, PHOTO_BASE), null);
  assert.equal(personPhotoUrl(null, PHOTO_BASE), null);
});

test('fotoğraf taban adresi NEXT_PUBLIC ortam değişkeninden okunur', async () => {
  const original = process.env.NEXT_PUBLIC_MERGEN_ROTA_USER_PHOTO_BASE_URL;
  try {
    process.env.NEXT_PUBLIC_MERGEN_ROTA_USER_PHOTO_BASE_URL = `${PHOTO_BASE}/`;
    // Modül değeri çağrı anında okur; yeniden içe aktarma gerekmez.
    const { userPhotoBaseUrl, buildUserPhotoUrl: build } = await import('../src/lib/userPhoto.js');
    assert.equal(userPhotoBaseUrl(), PHOTO_BASE);
    assert.equal(build('900001'), `${PHOTO_BASE}/900001.jpg`);

    delete process.env.NEXT_PUBLIC_MERGEN_ROTA_USER_PHOTO_BASE_URL;
    assert.equal(userPhotoBaseUrl(), '');
    assert.equal(build('900001'), null, 'taban adres yoksa baş harf yedeği kullanılır');
  } finally {
    if (original == null) delete process.env.NEXT_PUBLIC_MERGEN_ROTA_USER_PHOTO_BASE_URL;
    else process.env.NEXT_PUBLIC_MERGEN_ROTA_USER_PHOTO_BASE_URL = original;
  }
});

/* ── Avatar kimlik çözümü ───────────────────────────────── */

const people = [
  { id: '900001', employeeNo: '900001', name: 'Ada Yılmaz' },
  { id: '900002', employeeNo: '900002', name: 'Bora Demir' },
  { id: '900003', employeeNo: '900003', name: 'Aynı Ad' },
  { id: '900004', employeeNo: '900004', name: 'Aynı Ad' }
];

test('avatar yığını kanonik kimlikten kişiyi ve fotoğrafı çözer', () => {
  const lookup = createPersonLookup(people);
  const entries = resolveAvatarEntries({ personIds: ['900001', '900002'], names: ['Ada Yılmaz', 'Bora Demir'], lookup });

  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((entry) => entry.name), ['Ada Yılmaz', 'Bora Demir']);
  assert.equal(personPhotoUrl(entries[0].person, PHOTO_BASE), `${PHOTO_BASE}/900001.jpg`);
});

test('aynı ada sahip iki çalışanda tahmin yapılmaz; baş harf yedeğine düşülür', () => {
  const lookup = createPersonLookup(people);
  assert.equal(lookup.byName('Aynı Ad'), null, 'belirsiz ad kişi çözmemelidir');

  const entries = resolveAvatarEntries({ names: ['Aynı Ad'], lookup });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].person, null);
  assert.equal(personPhotoUrl(entries[0].person, PHOTO_BASE), null);

  // Kanonik kimlik verildiğinde belirsizlik kalmaz.
  const byId = resolveAvatarEntries({ personIds: ['900004'], lookup });
  assert.equal(byId[0].person.employeeNo, '900004');
});

test('kimlikle çözülemeyen sorumlu ad üzerinden korunur, kaybolmaz', () => {
  const lookup = createPersonLookup(people);
  const entries = resolveAvatarEntries({
    personIds: ['900001', 'bilinmeyen-id'],
    names: ['Ada Yılmaz', 'Eski Kayıt'],
    lookup
  });
  assert.deepEqual(entries.map((entry) => entry.name), ['Ada Yılmaz', 'Eski Kayıt']);
  assert.equal(entries[1].person, null);
});

test('avatar girdileri tekilleştirilir ve sıra korunur', () => {
  const lookup = createPersonLookup(people);
  const entries = resolveAvatarEntries({ personIds: ['900001', '900001', '900002'], lookup });
  assert.deepEqual(entries.map((entry) => entry.key), ['900001', '900002']);
});

/* ── Kimlik → kenar çubuğu (uçtan uca) ──────────────────── */

async function loadKeycloakSession(claimOverrides = {}) {
  applyKeycloakEnvironment();
  const jwks = installJwksEndpoint([signingKey]);
  let cookieValue = null;
  try {
    const modules = await loadAuthModules();
    const token = signJwt(accessTokenClaims(claimOverrides), { key: signingKey });
    const response = await modules.sessionRoute.POST(sessionExchangeRequest(token));
    assert.equal(response.status, 200);
    cookieValue = readSetCookie(response, SESSION_COOKIE_NAME).value;
  } finally {
    jwks.restore();
  }

  const { KeycloakIdentityProvider } = await import('../src/server/identity/keycloakIdentityProvider.js');
  const stack = await createActualStack(corporateSeed(), {
    authMode: 'keycloak',
    currentUserProvider: new KeycloakIdentityProvider({
      readSessionCookie: async (name) => (name === SESSION_COOKIE_NAME ? cookieValue : null)
    })
  });
  try {
    return { session: await stack.repository.loadSessionContext() };
  } finally {
    await stack.dispose();
  }
}

test('kenar çubuğu kullanıcısı doğrulanmış oturumdan gelir ve fotoğrafı sicilden üretilir', async () => {
  const { session } = await loadKeycloakSession();
  const user = session.currentUser;

  assert.equal(resolveUserDisplayName(user), 'Test Kullanıcı');
  assert.equal(resolveUserDepartmentLabel(user), 'Test Departmanı');
  assert.equal(personPhotoUrl(user, PHOTO_BASE), `${PHOTO_BASE}/${TEST_SICIL}.jpg`);
});

test('Keycloak departman claim\'i yoksa nötr yedek metin gösterilir, uydurma rol gösterilmez', async () => {
  // Jetonda departman claim'i yok; kurumsal rehber tohumunda da müdürlük boş.
  const { session } = await loadKeycloakSession({ department: '', mudurluk: '' });
  const user = session.currentUser;

  assert.equal(user.department, null);
  assert.equal(resolveUserDepartmentLabel(user), USER_DEPARTMENT_FALLBACK);
  // Unvan (rol) departman satırına ASLA düşmez.
  assert.notEqual(resolveUserDepartmentLabel(user), user.role);
  assert.notEqual(resolveUserDepartmentLabel(user), 'Product Manager');

  // Aynı kural saf yardımcı düzeyinde de geçerlidir.
  const withoutDepartment = buildSessionCurrentUser(
    { id: '900001', employeeNo: '900001', name: 'Test Kullanıcı', role: 'Product Manager', organization: {} },
    { sicil: 900001, name: 'Test Kullanıcı' }
  );
  assert.equal(resolveUserDepartmentLabel(withoutDepartment), USER_DEPARTMENT_FALLBACK);
});

test('departman çözümü Keycloak claim → müdürlük → direktörlük sırasını izler', () => {
  const base = { id: '900001', employeeNo: '900001', name: 'Ada Yılmaz' };
  const withClaim = buildSessionCurrentUser(
    { ...base, organization: { department: 'Kurumsal Müdürlük', directorate: 'Kurumsal Direktörlük' } },
    { sicil: 900001, department: 'Keycloak Departmanı' }
  );
  assert.equal(resolveUserDepartmentLabel(withClaim), 'Keycloak Departmanı');

  const withoutClaim = buildSessionCurrentUser(
    { ...base, organization: { department: 'Kurumsal Müdürlük', directorate: 'Kurumsal Direktörlük' } },
    { sicil: 900001 }
  );
  assert.equal(resolveUserDepartmentLabel(withoutClaim), 'Kurumsal Müdürlük');

  const onlyDirectorate = buildSessionCurrentUser(
    { ...base, organization: { directorate: 'Kurumsal Direktörlük' } },
    { sicil: 900001 }
  );
  assert.equal(resolveUserDepartmentLabel(onlyDirectorate), 'Kurumsal Direktörlük');
});

/* ── Kenar çubuğu ve avatar arayüz sözleşmeleri ─────────── */

test('kenar çubuğunda sabit örnek kullanıcı ve rol satırı kalmadı', () => {
  const shell = read('src/components/shell/AppShell.jsx');
  const panel = read('src/components/shell/SidebarUserPanel.jsx');

  for (const source of [shell, panel]) {
    assert.doesNotMatch(source, /Zeynep Aydın/);
    assert.doesNotMatch(source, /Product Manager/);
  }
  // Kimlik sunucu oturumundan okunur.
  assert.match(panel, /useCurrentUser\(\)/);
  assert.match(panel, /resolveUserDepartmentLabel/);
  assert.match(panel, /resolveUserDisplayName/);
  assert.match(shell, /<SidebarUserPanel/);
});

test('kenar çubuğu footer kısayolu kaldırıldı, Yardım sayfası ve gezinme öğesi korundu', () => {
  const shell = read('src/components/shell/AppShell.jsx');
  const panel = read('src/components/shell/SidebarUserPanel.jsx');
  const navigation = read('src/components/shell/navigation.js');

  // Yalnızca footer kısayolu kaldırıldı.
  for (const source of [shell, panel]) {
    assert.doesNotMatch(source, /title="Kullanım rehberi"/);
  }
  // Yardım sayfası ve gezinme öğesi yerinde.
  assert.match(navigation, /id: 'yardim'/);
  assert.match(shell, /case 'yardim': return <HelpView \/>;/);

  // Tema ve oturum kapatma denetimleri korunur.
  assert.match(panel, /onToggleTheme/);
  assert.match(panel, /title="Tema"/);
  assert.match(panel, /title="Oturumu kapat"/);
  assert.match(panel, /auth\/logout/);
  assert.match(panel, /session\?\.authMode === 'keycloak'/);
});

test('departman satırı uzun metin için sarmalanır ve küçük yazı tipi kullanır', () => {
  const panel = read('src/components/shell/SidebarUserPanel.jsx');
  const css = read('src/app/globals.css');

  assert.match(panel, /className="department"/);
  assert.match(panel, /title=\{department\}/);
  // Tek satır kısaltma YOK; çok satıra sarma VAR.
  assert.match(css, /\.user-chip \.department \{[^}]*white-space: normal/s);
  assert.match(css, /\.user-chip \.department \{[^}]*overflow-wrap: anywhere/s);
  assert.match(css, /\.user-chip \.department \{[^}]*font-size: 10\.5px/s);
  assert.match(css, /\.user-chip \.department \{[^}]*line-height: 1\.3/s);
  assert.doesNotMatch(css, /\.user-chip \.department \{[^}]*text-overflow: ellipsis/s);
  // Kimlik bloğu kalan yatay alanı alır.
  assert.match(css, /\.user-chip \{[^}]*min-width: 0/s);
});

test('paylaşılan Avatar bileşeni fotoğrafı gösterir ve hata durumunda baş harfe döner', () => {
  const ui = read('src/components/ui.jsx');

  assert.match(ui, /personPhotoUrl/);
  assert.match(ui, /onError=\{\(\) => setPhotoFailed\(true\)\}/);
  assert.match(ui, /alt=\{label\}/);
  assert.match(ui, /title=\{label\}/);
  assert.match(ui, /personInitials\(label\)/);
  // Kimlik çözümü sırası: kişi → kanonik kimlik → ad.
  assert.match(ui, /person\s*\|\|\s*\(personId == null \? null : lookup\.byId\(personId\)\)/);
  // Paylaşılan bileşen uygulama durumunu içe aktarmaz (mimari sınır).
  assert.doesNotMatch(ui, /from '\.\.\/state\//);
});

test('tüm üretim Avatar/AvatarStack çağrıları kişi veya kanonik kimlik taşır', () => {
  const callSites = [
    'src/components/shell/ProjectCreateDialog.jsx',
    'src/features/tasks/TasksView.jsx',
    'src/features/gantt/GanttView.jsx',
    'src/features/simple/SimpleModePanel.jsx',
    'src/features/project/ProjectWorkspaceView.jsx',
    // Raporlar "Kaynak kullanımı" ve Özet "Ekip iş yükü" kartları avatarı artık
    // ortak kişi ölçüm tablosu üzerinden çizer; kimlik güvencesi orada aranır.
    'src/components/PeopleMetricTable.jsx',
    'src/features/kanban/KanbanView.jsx',
    'src/features/dashboard/DashboardView.jsx',
    'src/features/task-detail/TaskDrawer.jsx',
    'src/features/task-detail/ReadOnlyTaskDrawer.jsx',
    'src/features/calendar/CalendarView.jsx',
    'src/features/team/TeamView.jsx'
  ];

  const pattern = /<Avatar(?:Stack)?\s[^>]*\/>/g;
  for (const path of callSites) {
    const source = read(path);
    const matches = source.match(pattern) || [];
    assert.ok(matches.length > 0, `${path} en az bir avatar çağrısı içermelidir`);
    for (const call of matches) {
      assert.match(
        call,
        /\bperson=\{|\bpersonId=\{|\bpersonIds=\{|\bpeople=\{|\bemployeeNo=\{/,
        `${path} → ${call} kişi bilgisi taşımalıdır`
      );
    }
  }
});

test('avatar boyutları fotoğraf için okunabilir ölçüde büyütüldü', () => {
  const css = read('src/app/globals.css');
  const sizeOf = (pattern) => Number(css.match(pattern)?.[1]);

  assert.equal(sizeOf(/\.avatar \{[^}]*--avatar-size: (\d+)px/s), 32);
  assert.equal(sizeOf(/\.avatar\.sm \{ --avatar-size: (\d+)px/), 26);
  assert.equal(sizeOf(/\.avatar\.lg \{ --avatar-size: (\d+)px/), 40);
  // Fotoğraf kırpması merkezi ve baş harf avatarıyla aynı ölçüde.
  assert.match(css, /img\.avatar-photo \{[^}]*object-fit: cover/s);
  // Kenar çubuğu kullanıcısı büyük boy avatar kullanır (yaklaşık 40 px).
  assert.match(read('src/components/shell/SidebarUserPanel.jsx'), /size="lg"/);
});

test('kişi dizini bağlamı DOM düğümü eklemez ve kabuk ızgarasını bozmaz', () => {
  const context = read('src/components/PeopleDirectoryContext.jsx');
  assert.match(context, /<PeopleDirectoryContext\.Provider value=\{lookup\}>\{children\}<\/PeopleDirectoryContext\.Provider>/);

  const shell = read('src/components/shell/AppShell.jsx');
  const gridIndex = shell.indexOf('return (\n    <div className={`app app-mode-');
  const providerIndex = shell.indexOf('<PeopleDirectoryProvider people={directoryPeople}>');
  assert.ok(gridIndex > 0 && providerIndex > gridIndex, 'sağlayıcı .app ızgarasının içinde olmalıdır');
});

test('depoda gerçek kurum içi fotoğraf adresi bulunmaz', () => {
  for (const path of ['.env.example', 'src/lib/userPhoto.js', 'src/components/ui.jsx']) {
    const source = read(path);
    assert.doesNotMatch(source, /https:\/\/[a-z0-9.-]*\.(com|net|org)\//i);
  }
  // Yardımcı yalnızca ortam değişkeninden adres okur.
  assert.match(read('src/lib/userPhoto.js'), /process\.env\.NEXT_PUBLIC_MERGEN_ROTA_USER_PHOTO_BASE_URL/);
});
