'use client';

import { useMemo, useState } from 'react';
import { Icons } from '../../components/icons';
import { SearchableSelect } from '../../components/SearchableSelect';
import { Avatar } from '../../components/ui';
import { AnimatedNumber, FilterableTH, InfoButton, numericMatchesFilter } from '../../components/ui-extras';
import { diffDays, parseDate } from '../../scheduling/dates';
import { useTodayKey } from '../../hooks/useTodayKey';
import { projectColorVar } from '../../lib/colors';
import { useTasks, usePeople, useTaskActions } from '../../state/hooks';
import { PersonDetailDialog } from './PersonDetailDialog.jsx';
import {
  applyOrgSelection,
  createEmptyOrgFilter,
  hasOrgSelection,
  matchesOrgFilter,
  orgLevelOptions,
  organizationValue,
  UNASSIGNED_DIRECTORATE
} from '../../domain/organization/organizationHierarchy.js';
import {
  sortTeamRows
} from './teamFilterPolicy.js';

const PERSON_PAGE_SIZE = 80;

function createEmptyColumnFilter() {
  return { name: '', role: [], total: null, active: null, late: null, upcoming: '' };
}

function personSearchText(person) {
  return [
    person.name,
    person.employeeNo,
    person.username,
    person.role,
    person.team,
    organizationValue(person, 'sector'),
    organizationValue(person, 'directorate'),
    organizationValue(person, 'department'),
    organizationValue(person, 'unit')
  ].filter(Boolean).join(' ').toLocaleLowerCase('tr-TR');
}

function lower(value) {
  return String(value || '').toLocaleLowerCase('tr-TR');
}

/** Kurumsal düzey açılır listesi/başlık süzgeci için ortak seçenek listesi. */
function orgOptionList(options, allLabel) {
  return [
    { value: '', label: allLabel, icon: <Icons.Layers size={13} /> },
    ...options.map((option) => ({
      value: option.value,
      label: option.label,
      description: option.description || null,
      icon: option.value === UNASSIGNED_DIRECTORATE ? <Icons.Users size={13} /> : <Icons.Briefcase size={13} />
    }))
  ];
}

function addTaskToPerson(map, personId, task) {
  if (!personId) return;
  if (!map.has(personId)) map.set(personId, []);
  const current = map.get(personId);
  if (!current.some((item) => item.id === task.id)) current.push(task);
}

/** Yakın görevler: en yakın ilgili tarih, sonra görev adı. */
function upcomingTaskOrder(tasks = []) {
  return [...tasks].sort((left, right) => {
    const leftDate = left.targetFinish || left.plannedFinish || '';
    const rightDate = right.targetFinish || right.plannedFinish || '';
    if (leftDate && rightDate && leftDate !== rightDate) return leftDate.localeCompare(rightDate);
    if (leftDate && !rightDate) return -1;
    if (!leftDate && rightDate) return 1;
    return String(left.task || '').localeCompare(String(right.task || ''), 'tr');
  });
}

export function TeamView() {
  const tasks = useTasks();
  const people = usePeople();
  const { openTask: onOpenTask } = useTaskActions();
  const [query, setQuery] = useState('');
  // Üstteki dizin açılır listeleri ve tablo başlığı süzgeçleri TEK durumu paylaşır.
  const [orgFilter, setOrgFilter] = useState(createEmptyOrgFilter);
  const [colFilter, setColFilter] = useState(createEmptyColumnFilter);
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
  const [limit, setLimit] = useState(PERSON_PAGE_SIZE);
  // Açık personel penceresi KİMLİKLE tutulur: süzgeç değişince satır listeden
  // düşse bile saklanan bir satır nesnesi eski verilerle ekranda kalırdı.
  const [openPersonId, setOpenPersonId] = useState(null);
  // Gün ANAHTARI kararlıdır; `today()` her boyamada yeni bir `Date` üretir ve
  // `stats` memosu hiçbir zaman yeniden kullanılamıyordu: binlerce kişilik
  // rehberde arama kutusundaki her tuş vuruşu tüm süzgeç/sıralama hattını
  // baştan çalıştırıyordu. Gün döndüğünde anahtar değişir ve memo tazelenir.
  const todayKey = useTodayKey();
  const today_ = useMemo(() => parseDate(todayKey), [todayKey]);

  // Ad başına TÜM kimlikler tutulur. `Map` ile tek kimlik saklandığında,
  // kurumsal rehberde aynı adı taşıyan iki kişiden sonraki öncekini eziyor;
  // aşağıdaki ad yedeği o adı içeren bütün görevleri adaşlardan yalnızca birine
  // bağlıyordu. Öteki adaş sıfır toplam, sıfır geciken ve boş "Yakın görevler"
  // ile görünüyordu.
  const peopleIdsByName = useMemo(() => {
    const map = new Map();
    for (const person of people) {
      if (!map.has(person.name)) map.set(person.name, []);
      map.get(person.name).push(person.id);
    }
    return map;
  }, [people]);
  const tasksByPersonId = useMemo(() => {
    const map = new Map();
    for (const task of tasks) {
      for (const personId of task.assigneeIds || []) addTaskToPerson(map, String(personId), task);
      if (!(task.assigneeIds || []).length) {
        for (const name of task.sorumlu || []) {
          // Anahtar METİNLEŞTİRİLİR: arama her zaman `String(person.id)` ile
          // yapılır, sayısal bir kimlikle yazılan `12` anahtarı `'12'` ile
          // eşleşmiyor ve yalnızca `sorumlu` adı taşıyan görevler kişinin
          // toplamlarından, geciken sayısından ve yaklaşan listesinden
          // tümüyle düşüyordu.
          for (const personId of peopleIdsByName.get(name) || []) {
            if (personId != null) addTaskToPerson(map, String(personId), task);
          }
        }
      }
    }
    return map;
  }, [tasks, peopleIdsByName]);

  const stats = useMemo(() => people.map((person) => {
    const personTasks = upcomingTaskOrder(tasksByPersonId.get(String(person.id)) || []);
    const done = personTasks.filter((task) => task.status === 'done').length;
    const active = personTasks.filter((task) => task.status === 'in_progress').length;
    const late = personTasks.filter((task) => task.status !== 'done' && task.targetFinish && diffDays(task.targetFinish, today_) < 0).length;
    // "Yakın görevler" sütunu AÇIK görevleri gösterir. `PersonDetailDialog`
    // tamamlananları zaten eliyor; satır listesi, "+N görev daha" sayacı ve
    // sütun metin süzgeci onları saydığında iki görünüm birbirini tutmuyor,
    // bütün görevleri bitmiş bir kişi yine de "yakın görev" gösteriyordu.
    const openTasks = personTasks.filter((task) => task.status !== 'done');
    const nearest = openTasks[0] || null;
    return {
      person,
      total: personTasks.length,
      done,
      active,
      late,
      tasks: personTasks,
      openTasks,
      // Sıralama kararlıdır: önce en yakın ilgili tarih, sonra görev adı.
      upcomingSortValue: nearest ? `${nearest.targetFinish || nearest.plannedFinish || '9999-12-31'}|${nearest.task || ''}` : '',
      upcomingText: openTasks.map((task) => task.task).filter(Boolean).join(' ')
    };
  }), [people, tasksByPersonId, today_]);

  /* ── Süzgeç seçenekleri (hiyerarşik daraltma) ─────────── */
  const directorateOptions = useMemo(() => orgLevelOptions(people, 'directorate', orgFilter), [people, orgFilter]);
  const departmentOptions = useMemo(() => orgLevelOptions(people, 'department', orgFilter), [people, orgFilter]);
  const unitOptions = useMemo(() => orgLevelOptions(people, 'unit', orgFilter), [people, orgFilter]);
  const roleOptions = useMemo(() => [...new Set(people.map((person) => String(person.role || '').trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'tr'))
    .map((role) => ({ value: role, label: role })), [people]);

  /* ── Süzgeç + sıralama (sayfalamadan ÖNCE) ───────────── */
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('tr-TR');
    const nameNeedle = lower(colFilter.name.trim());
    const upcomingNeedle = lower(colFilter.upcoming.trim());

    const rows = stats
      .filter(({ person }) => matchesOrgFilter(person, orgFilter))
      .filter(({ person }) => !needle || personSearchText(person).includes(needle))
      .filter(({ person }) => !nameNeedle
        || lower(person.name).includes(nameNeedle)
        || lower(person.employeeNo).includes(nameNeedle))
      .filter(({ person }) => !colFilter.role.length || colFilter.role.includes(String(person.role || '').trim()))
      .filter((row) => !colFilter.total || numericMatchesFilter(row.total, colFilter.total))
      .filter((row) => !colFilter.active || numericMatchesFilter(row.active, colFilter.active))
      .filter((row) => !colFilter.late || numericMatchesFilter(row.late, colFilter.late))
      .filter((row) => !upcomingNeedle || lower(row.upcomingText).includes(upcomingNeedle));

    return sortTeamRows(rows, sort);
  }, [stats, query, orgFilter, colFilter, sort]);

  const directorateSummaries = useMemo(() => {
    const summarize = (key, name, members) => ({
      key,
      name,
      people: members.length,
      departments: new Set(members.map(({ person }) => organizationValue(person, 'department')).filter(Boolean)).size,
      units: new Set(members.map(({ person }) => organizationValue(person, 'unit')).filter(Boolean)).size,
      active: members.reduce((sum, member) => sum + member.active, 0),
      late: members.reduce((sum, member) => sum + member.late, 0)
    });

    // Direktörlüğü olmayan çalışanlar da kendi kartıyla listelenir; aksi hâlde
    // dizinin varsayılan görünümünde hiç görünmüyorlardı.
    return directorateOptions.map((option) => summarize(
      option.value,
      option.label,
      stats.filter(({ person }) => matchesOrgFilter(person, { ...createEmptyOrgFilter(), directorate: option.value }))
    ));
  }, [directorateOptions, stats]);

  const visiblePeople = filtered.slice(0, limit);
  const openMember = openPersonId ? stats.find((row) => row.person.id === openPersonId) || null : null;
  const columnFilterActive = Boolean(colFilter.name || colFilter.role.length || colFilter.total || colFilter.active || colFilter.late || colFilter.upcoming);
  const anyFilterActive = Boolean(query.trim()) || hasOrgSelection(orgFilter) || columnFilterActive;
  const showingDirectorySummary = !anyFilterActive;

  /* Kurumsal düzey seçimi TEK giriş noktasından geçer: üstteki açılır liste de,
     tablo başlığı süzgeci de aynı durumu günceller. */
  const selectOrgLevel = (level) => (value) => {
    setOrgFilter((current) => applyOrgSelection(current, level, value));
    setLimit(PERSON_PAGE_SIZE);
  };
  const setColumn = (key) => (value) => {
    setColFilter((current) => ({ ...current, [key]: value }));
    setLimit(PERSON_PAGE_SIZE);
  };
  const setSortFor = (key) => (dir) => setSort({ key, dir });
  const sortDirFor = (key) => (sort.key === key ? sort.dir : null);
  const clearAllFilters = () => {
    setQuery('');
    setOrgFilter(createEmptyOrgFilter());
    setColFilter(createEmptyColumnFilter());
    setLimit(PERSON_PAGE_SIZE);
  };

  return (
    /* Sayfa kendi yüksekliğini yönetir: dizin kartı sabit kalır, yalnızca
       personel tablosu kayar. Böylece "Kurumsal ekip dizini" kartı ve tablo
       başlığı aşağı kaydırırken de görünür kalır. */
    <div className="team-page col">
      <div className="card team-directory-card">
        <div className="row" style={{ justifyContent: 'space-between', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div className="col" style={{ gap: 4 }}>
            <div style={{ fontSize: 18, fontWeight: 750 }}>Kurumsal ekip dizini</div>
            <div className="muted" style={{ maxWidth: 820, lineHeight: 1.55 }}>
              Personel, direktörlük → müdürlük → birim düzeninde gezilir. Buradaki seçimler tablo başlığı filtreleriyle aynı durumu paylaşır; birinde yapılan değişiklik diğerine anında yansır.
            </div>
          </div>
          <div className="row" style={{ gap: 9, flexWrap: 'wrap' }}>
            <span className="badge"><Icons.Users size={12} /> {people.length} personel</span>
            <span className="badge"><Icons.Briefcase size={12} /> {directorateOptions.length} direktörlük</span>
            <InfoButton title="Ekip tablosu" icon={<Icons.Table size={12} />}>
              <p>Kurumsal dizin ve tablo başlıkları tek filtre durumunu paylaşır.</p>
              <div className="rt-sep" />
              <div className="rt-row"><Icons.Search size={12} className="rt-ico" /><span>Üstteki arama: tüm alanlarda arar</span></div>
              <div className="rt-row"><Icons.Filter size={12} className="rt-ico" /><span>Sütun başlığına tıkla: filtrele/sırala</span></div>
              <div className="rt-row"><Icons.Briefcase size={12} className="rt-ico" /><span>Kurumsal düzeyler tek seçimlidir</span></div>
            </InfoButton>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 1.4fr) repeat(3, minmax(180px, 1fr))', gap: 10, marginTop: 18 }}>
          <label className="topbar-search" style={{ width: '100%', maxWidth: 'none' }}>
            <Icons.Search size={14} />
            <input
              value={query}
              onChange={(event) => { setQuery(event.target.value); setLimit(PERSON_PAGE_SIZE); }}
              placeholder="Ad, sicil, unvan veya birimle ara"
              aria-label="Personel ara"
            />
            {query && <button type="button" className="icon-btn" style={{ width: 22, height: 22 }} onClick={() => setQuery('')}><Icons.Close size={11} /></button>}
          </label>
          <SearchableSelect
            value={orgFilter.directorate}
            options={orgOptionList(directorateOptions, 'Tüm direktörlükler')}
            onChange={selectOrgLevel('directorate')}
            searchPlaceholder="Direktörlük ara"
            ariaLabel="Direktörlük süzgeci"
            compact
          />
          <SearchableSelect
            value={orgFilter.department}
            options={orgOptionList(departmentOptions, 'Tüm müdürlükler')}
            onChange={selectOrgLevel('department')}
            searchPlaceholder="Müdürlük ara"
            ariaLabel="Müdürlük süzgeci"
            disabled={departmentOptions.length === 0}
            compact
          />
          <SearchableSelect
            value={orgFilter.unit}
            options={orgOptionList(unitOptions, 'Tüm birimler')}
            onChange={selectOrgLevel('unit')}
            searchPlaceholder="Birim ara"
            ariaLabel="Birim süzgeci"
            disabled={unitOptions.length === 0}
            compact
          />
        </div>

        <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
          {anyFilterActive && (
            <button type="button" className="btn ghost sm" onClick={clearAllFilters}>
              <Icons.Close size={12} /> Filtreleri temizle
            </button>
          )}
          <span className="muted tabular" style={{ marginLeft: 'auto', fontSize: 12 }}>{filtered.length} / {people.length} personel</span>
        </div>
      </div>

      {showingDirectorySummary ? (
        <div className="team-summary-grid">
          {directorateSummaries.map((summary) => (
            <button
              type="button"
              key={summary.key}
              className="card"
              onClick={() => selectOrgLevel('directorate')(summary.key)}
              style={{ padding: 17, textAlign: 'left', cursor: 'pointer', color: 'var(--text)' }}
            >
              <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                <span style={{ width: 34, height: 34, borderRadius: 'var(--r-md)', display: 'grid', placeItems: 'center', background: 'var(--bg-elev-2)', border: '1px solid var(--border)' }}>
                  {summary.key === UNASSIGNED_DIRECTORATE ? <Icons.Users size={16} /> : <Icons.Briefcase size={16} />}
                </span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <strong style={{ display: 'block', lineHeight: 1.35 }}>{summary.name}</strong>
                  <small className="muted" style={{ display: 'block', marginTop: 3 }}>
                    {summary.key === UNASSIGNED_DIRECTORATE
                      ? 'Yalnızca yönetici bilgisi tanımlı personel'
                      : `${summary.departments} müdürlük · ${summary.units} birim`}
                  </small>
                </span>
                <Icons.ChevronRight size={14} />
              </div>
              <div className="row" style={{ gap: 18, marginTop: 16 }}>
                <Mini label="Personel" value={summary.people} />
                <Mini label="Devam" value={summary.active} />
                <Mini label="Geciken" value={summary.late} attention={summary.late > 0} />
              </div>
            </button>
          ))}
          {!directorateSummaries.length && <div className="card muted">Kurumsal organizasyon bilgisi bulunamadı.</div>}
        </div>
      ) : (
        <div className="card team-table-card">
          <div className="team-table-scroll">
            <table className="tbl" style={{ minWidth: 1180 }}>
              <thead>
                <tr>
                  <FilterableTH label="Personel" style={{ minWidth: 230 }}
                    sortKey={sortDirFor('name')} onSort={setSortFor('name')}
                    filter={colFilter.name} onFilter={setColumn('name')}
                    filterType="text"
                  />
                  <FilterableTH label="Unvan" style={{ minWidth: 160 }}
                    sortKey={sortDirFor('role')} onSort={setSortFor('role')}
                    filter={colFilter.role} onFilter={setColumn('role')}
                    filterType="multi" filterOptions={roleOptions}
                  />
                  <FilterableTH label="Direktörlük" style={{ minWidth: 180 }}
                    sortKey={sortDirFor('directorate')} onSort={setSortFor('directorate')}
                    filter={orgFilter.directorate} onFilter={selectOrgLevel('directorate')}
                    filterType="single" filterOptions={orgOptionList(directorateOptions, 'Tüm direktörlükler')}
                  />
                  <FilterableTH label="Müdürlük" style={{ minWidth: 180 }}
                    sortKey={sortDirFor('department')} onSort={setSortFor('department')}
                    filter={orgFilter.department} onFilter={selectOrgLevel('department')}
                    filterType="single" filterOptions={orgOptionList(departmentOptions, 'Tüm müdürlükler')}
                  />
                  <FilterableTH label="Birim" style={{ minWidth: 170 }}
                    sortKey={sortDirFor('unit')} onSort={setSortFor('unit')}
                    filter={orgFilter.unit} onFilter={selectOrgLevel('unit')}
                    filterType="single" filterOptions={orgOptionList(unitOptions, 'Tüm birimler')}
                  />
                  <FilterableTH label="Toplam" style={{ width: 104 }}
                    sortKey={sortDirFor('total')} onSort={setSortFor('total')}
                    filter={colFilter.total} onFilter={setColumn('total')}
                    filterType="number" numericMin={0} numericUnit=" görev"
                  />
                  <FilterableTH label="Devam" style={{ width: 104 }}
                    sortKey={sortDirFor('active')} onSort={setSortFor('active')}
                    filter={colFilter.active} onFilter={setColumn('active')}
                    filterType="number" numericMin={0} numericUnit=" görev"
                  />
                  <FilterableTH label="Geciken" style={{ width: 104 }}
                    sortKey={sortDirFor('late')} onSort={setSortFor('late')}
                    filter={colFilter.late} onFilter={setColumn('late')}
                    filterType="number" numericMin={0} numericUnit=" görev"
                  />
                  <FilterableTH label="Yakın görevler" style={{ minWidth: 260 }}
                    sortKey={sortDirFor('upcoming')} onSort={setSortFor('upcoming')}
                    filter={colFilter.upcoming} onFilter={setColumn('upcoming')}
                    filterType="text"
                  />
                </tr>
              </thead>
              <tbody>
                {visiblePeople.map((member) => (
                  <tr key={member.person.id}>
                    <td>
                      {/* Personel adı tıklanabilir: ayrıntı penceresi kişinin
                          yakın görevlerini tam liste hâlinde açar. */}
                      <button
                        type="button"
                        className="team-person-button"
                        onClick={() => setOpenPersonId(member.person.id)}
                        aria-label={`${member.person.name} ayrıntılarını aç`}
                      >
                        <Avatar name={member.person.name} person={member.person} size="md" />
                        <span style={{ minWidth: 0 }}>
                          <strong>{member.person.name}</strong>
                          <small className="muted">{member.person.employeeNo || member.person.id}</small>
                        </span>
                      </button>
                    </td>
                    <td className="muted">{member.person.role || '—'}</td>
                    <td>{organizationValue(member.person, 'directorate') || <span className="muted">Tanımsız</span>}</td>
                    <td>{organizationValue(member.person, 'department') || <span className="muted">—</span>}</td>
                    <td>{organizationValue(member.person, 'unit') || <span className="muted">{member.person.team || '—'}</span>}</td>
                    <td className="tabular">{member.total}</td>
                    <td className="tabular">{member.active}</td>
                    <td className="tabular" style={member.late > 0 ? { color: 'var(--status-overdue)', fontWeight: 700 } : null}>{member.late}</td>
                    <td>
                      <div className="col" style={{ gap: 3 }}>
                        {member.openTasks.slice(0, 2).map((task) => (
                          <button
                            type="button"
                            key={task.id}
                            onClick={() => onOpenTask(task)}
                            style={{ display: 'flex', alignItems: 'center', gap: 7, padding: 0, border: 0, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', textAlign: 'left' }}
                          >
                            <span style={{ width: 6, height: 6, borderRadius: 99, background: projectColorVar(task.proje), flexShrink: 0 }} />
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>{task.task}</span>
                          </button>
                        ))}
                        {member.openTasks.length > 2 && <small className="muted">+{member.openTasks.length - 2} görev daha</small>}
                        {/* Liste AÇIK görevleri gösterir: tamamlanmış atamaları
                            olan bir personel için "Atanmış görev yok" yanlıştı. */}
                        {!member.openTasks.length && <small className="muted">Atanmış açık görev yok</small>}
                      </div>
                    </td>
                  </tr>
                ))}
                {!visiblePeople.length && <tr><td colSpan={9} className="empty">Eşleşen personel bulunamadı.</td></tr>}
              </tbody>
            </table>
          </div>
          {filtered.length > limit && (
            <div className="row" style={{ justifyContent: 'center', padding: 14, borderTop: '1px solid var(--border)' }}>
              <button type="button" className="btn" onClick={() => setLimit((current) => current + PERSON_PAGE_SIZE)}>
                <Icons.Plus size={13} /> Daha fazla göster ({Math.min(PERSON_PAGE_SIZE, filtered.length - limit)})
              </button>
            </div>
          )}
        </div>
      )}

      {openMember && (
        <PersonDetailDialog
          member={openMember}
          onClose={() => setOpenPersonId(null)}
          onOpenTask={(task) => { setOpenPersonId(null); onOpenTask(task); }}
        />
      )}
    </div>
  );
}

function Mini({ label, value, attention = false }) {
  return (
    <div className="col" style={{ gap: 1, flex: 1 }}>
      <div className="muted" style={{ fontSize: 10.5, fontWeight: 650, letterSpacing: '0.01em' }}>{label}</div>
      <div className="tabular" style={{ fontSize: 19, fontWeight: 750, color: attention ? 'var(--status-overdue)' : 'var(--text)', lineHeight: 1.2 }}>
        <AnimatedNumber value={value} duration={500} />
      </div>
    </div>
  );
}
