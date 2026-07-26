'use client';

import { useMemo, useState } from 'react';
import { Icons } from '../../components/icons';
import { SearchableSelect } from '../../components/SearchableSelect';
import { Avatar } from '../../components/ui';
import { AnimatedNumber } from '../../components/ui-extras';
import { diffDays, today } from '../../scheduling/dates';
import { projectColorVar } from '../../lib/colors';
import { useTasks, usePeople, useTaskActions } from '../../state/hooks';
import {
  UNASSIGNED_DIRECTORATE,
  UNASSIGNED_DIRECTORATE_LABEL,
  matchesDirectorateFilter,
  organizationValue
} from './teamDirectoryPolicy.js';

const PERSON_PAGE_SIZE = 80;

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

function optionList(values, allLabel, extras = []) {
  return [
    { value: '', label: allLabel, icon: <Icons.Layers size={13} /> },
    ...extras,
    ...values.map((value) => ({ value, label: value, icon: <Icons.Briefcase size={13} /> }))
  ];
}

function addTaskToPerson(map, personId, task) {
  if (!personId) return;
  if (!map.has(personId)) map.set(personId, []);
  const current = map.get(personId);
  if (!current.some((item) => item.id === task.id)) current.push(task);
}

export function TeamView() {
  const tasks = useTasks();
  const people = usePeople();
  const { openTask: onOpenTask } = useTaskActions();
  const [query, setQuery] = useState('');
  const [directorate, setDirectorate] = useState('');
  const [department, setDepartment] = useState('');
  const [unit, setUnit] = useState('');
  const [limit, setLimit] = useState(PERSON_PAGE_SIZE);
  const today_ = today();

  const peopleByName = useMemo(() => new Map(people.map((person) => [person.name, person.id])), [people]);
  const tasksByPersonId = useMemo(() => {
    const map = new Map();
    for (const task of tasks) {
      for (const personId of task.assigneeIds || []) addTaskToPerson(map, String(personId), task);
      if (!(task.assigneeIds || []).length) {
        for (const name of task.sorumlu || []) addTaskToPerson(map, peopleByName.get(name), task);
      }
    }
    return map;
  }, [tasks, peopleByName]);

  const stats = useMemo(() => people.map((person) => {
    const personTasks = tasksByPersonId.get(String(person.id)) || [];
    const done = personTasks.filter((task) => task.status === 'done').length;
    const active = personTasks.filter((task) => task.status === 'in_progress').length;
    const late = personTasks.filter((task) => task.status !== 'done' && task.targetFinish && diffDays(task.targetFinish, today_) < 0).length;
    return { person, total: personTasks.length, done, active, late, tasks: personTasks };
  }), [people, tasksByPersonId, today_]);

  const directorates = useMemo(() => [...new Set(people.map((person) => organizationValue(person, 'directorate')).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'tr')), [people]);
  const unassignedPeopleCount = useMemo(
    () => people.filter((person) => !organizationValue(person, 'directorate')).length,
    [people]
  );
  const directorateOptions = useMemo(() => optionList(
    directorates,
    'Tüm direktörlükler',
    unassignedPeopleCount
      ? [{ value: UNASSIGNED_DIRECTORATE, label: UNASSIGNED_DIRECTORATE_LABEL, icon: <Icons.Users size={13} /> }]
      : []
  ), [directorates, unassignedPeopleCount]);
  const departments = useMemo(() => [...new Set(people
    .filter((person) => matchesDirectorateFilter(person, directorate))
    .map((person) => organizationValue(person, 'department'))
    .filter(Boolean))].sort((left, right) => left.localeCompare(right, 'tr')), [people, directorate]);
  const units = useMemo(() => [...new Set(people
    .filter((person) => matchesDirectorateFilter(person, directorate))
    .filter((person) => !department || organizationValue(person, 'department') === department)
    .map((person) => organizationValue(person, 'unit'))
    .filter(Boolean))].sort((left, right) => left.localeCompare(right, 'tr')), [people, directorate, department]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('tr-TR');
    return stats
      .filter(({ person }) => matchesDirectorateFilter(person, directorate))
      .filter(({ person }) => !department || organizationValue(person, 'department') === department)
      .filter(({ person }) => !unit || organizationValue(person, 'unit') === unit)
      .filter(({ person }) => !needle || personSearchText(person).includes(needle))
      .sort((left, right) => (
        organizationValue(left.person, 'directorate').localeCompare(organizationValue(right.person, 'directorate'), 'tr')
        || organizationValue(left.person, 'department').localeCompare(organizationValue(right.person, 'department'), 'tr')
        || organizationValue(left.person, 'unit').localeCompare(organizationValue(right.person, 'unit'), 'tr')
        || left.person.name.localeCompare(right.person.name, 'tr')
      ));
  }, [stats, query, directorate, department, unit]);

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

    const summaries = directorates.map((name) => summarize(
      name,
      name,
      stats.filter(({ person }) => organizationValue(person, 'directorate') === name)
    ));

    // Direktörlüğü olmayan çalışanlar da kendi kartıyla listelenir; aksi hâlde
    // dizinin varsayılan görünümünde hiç görünmüyorlardı.
    const unassigned = stats.filter(({ person }) => !organizationValue(person, 'directorate'));
    if (unassigned.length) {
      summaries.push(summarize(UNASSIGNED_DIRECTORATE, UNASSIGNED_DIRECTORATE_LABEL, unassigned));
    }
    return summaries;
  }, [directorates, stats]);

  const visiblePeople = filtered.slice(0, limit);
  const showingDirectorySummary = !query.trim() && !directorate && !department && !unit;

  const resetDependentFilters = (nextDirectorate) => {
    setDirectorate(nextDirectorate);
    setDepartment('');
    setUnit('');
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
              Personel, direktörlük → müdürlük → birim düzeninde gezilir. Büyük dizinlerde tüm çalışan kartları bir kerede oluşturulmaz; arama ve kurumsal süzgeçler sonucu daraltır.
            </div>
          </div>
          <div className="row" style={{ gap: 9, flexWrap: 'wrap' }}>
            <span className="badge"><Icons.Users size={12} /> {people.length} personel</span>
            <span className="badge"><Icons.Briefcase size={12} /> {directorates.length} direktörlük</span>
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
            value={directorate}
            options={directorateOptions}
            onChange={resetDependentFilters}
            searchPlaceholder="Direktörlük ara"
            compact
          />
          <SearchableSelect
            value={department}
            options={optionList(departments, 'Tüm müdürlükler')}
            onChange={(value) => { setDepartment(value); setUnit(''); setLimit(PERSON_PAGE_SIZE); }}
            searchPlaceholder="Müdürlük ara"
            disabled={!directorate && departments.length === 0}
            compact
          />
          <SearchableSelect
            value={unit}
            options={optionList(units, 'Tüm birimler')}
            onChange={(value) => { setUnit(value); setLimit(PERSON_PAGE_SIZE); }}
            searchPlaceholder="Birim ara"
            disabled={!department && units.length === 0}
            compact
          />
        </div>

        <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
          {(directorate || department || unit || query) && (
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => { setQuery(''); setDirectorate(''); setDepartment(''); setUnit(''); setLimit(PERSON_PAGE_SIZE); }}
            >
              <Icons.Close size={12} /> Süzgeçleri temizle
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
              onClick={() => resetDependentFilters(summary.key)}
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
            <table className="tbl" style={{ minWidth: 980 }}>
              <thead>
                <tr>
                  <th>Personel</th>
                  <th>Unvan</th>
                  <th>Direktörlük</th>
                  <th>Müdürlük / Birim</th>
                  <th style={{ width: 90 }}>Toplam</th>
                  <th style={{ width: 90 }}>Devam</th>
                  <th style={{ width: 90 }}>Geciken</th>
                  <th style={{ minWidth: 240 }}>Yakın görevler</th>
                </tr>
              </thead>
              <tbody>
                {visiblePeople.map((member) => (
                  <tr key={member.person.id}>
                    <td>
                      <div className="row" style={{ gap: 9 }}>
                        <Avatar name={member.person.name} size="md" />
                        <span style={{ minWidth: 0 }}>
                          <strong style={{ display: 'block', whiteSpace: 'nowrap' }}>{member.person.name}</strong>
                          <small className="muted">{member.person.employeeNo || member.person.id}</small>
                        </span>
                      </div>
                    </td>
                    <td className="muted">{member.person.role || '—'}</td>
                    <td>{organizationValue(member.person, 'directorate') || <span className="muted">Tanımsız</span>}</td>
                    <td>
                      <span style={{ display: 'block' }}>{organizationValue(member.person, 'department') || '—'}</span>
                      <small className="muted">{organizationValue(member.person, 'unit') || member.person.team || '—'}</small>
                    </td>
                    <td className="tabular">{member.total}</td>
                    <td className="tabular">{member.active}</td>
                    <td className="tabular" style={member.late > 0 ? { color: 'var(--status-overdue)', fontWeight: 700 } : null}>{member.late}</td>
                    <td>
                      <div className="col" style={{ gap: 3 }}>
                        {member.tasks.slice(0, 2).map((task) => (
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
                        {member.tasks.length > 2 && <small className="muted">+{member.tasks.length - 2} görev daha</small>}
                        {!member.tasks.length && <small className="muted">Atanmış görev yok</small>}
                      </div>
                    </td>
                  </tr>
                ))}
                {!visiblePeople.length && <tr><td colSpan={8} className="empty">Eşleşen personel bulunamadı.</td></tr>}
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
    </div>
  );
}

function Mini({ label, value, attention = false }) {
  return (
    <div className="col" style={{ gap: 1, flex: 1 }}>
      <div className="muted" style={{ fontSize: 10.5, fontWeight: 650, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{label}</div>
      <div className="tabular" style={{ fontSize: 19, fontWeight: 750, color: attention ? 'var(--status-overdue)' : 'var(--text)', lineHeight: 1.2 }}>
        <AnimatedNumber value={value} duration={500} />
      </div>
    </div>
  );
}
