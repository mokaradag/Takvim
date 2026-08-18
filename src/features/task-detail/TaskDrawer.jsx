'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { DateInput } from '../../components/DateInput';
import { Icons } from '../../components/icons';
import { SearchableSelect } from '../../components/SearchableSelect';
import { buildWbsTree, flattenWbsTree, formatWbsPath } from '../../domain/selectors/index.js';
import { isArchivedProject, projectTypeMeta, visibleProjects } from '../../domain/projectTypes';
import { normalizeProjectTags, projectTagCatalog } from '../../domain/tags';
import {
  LAG_UNITS,
  REL_TYPES,
  depId,
  dependencyLagDays,
  formatDependencyLag,
  lagUnitOf,
  lagValueOf,
  relTypeOf
} from '../../scheduling/dependencies';
import { TR_DAYS, diffDays, fmt, today } from '../../scheduling/dates';
import {
  MAX_RECURRENCE_OCCURRENCES,
  RECURRENCE_WEEKDAYS,
  describeRecurrenceRule,
  formatRecurrenceRule,
  normalizeRecurrenceRule,
  planRecurringOccurrences
} from '../../scheduling/recurrence';
import { getTaskCalendarWarnings } from '../../scheduling/calendarWarnings';
import { resolveTaskCalendar } from '../../scheduling/calendars';
import { COLOR_MAP, projectColorVar } from '../../lib/colors';
import { Avatar, StatusIcon, statusColorVar } from '../../components/ui';
import { TaskKeyword } from '../../components/TaskKeyword';
import { InfoButton } from '../../components/ui-extras';
import { useAllPeople, useAllProjects, useAllWbs, useCalendars, useTaskActions, useTaskPrimaryBaseline } from '../../state/hooks';

function legacyProjectTags(projectId, tasks) {
  return Array.from(new Set(
    tasks
      .filter((item) => item.projectId === projectId && String(item.keyword || '').trim() && String(item.keyword).trim() !== 'Yeni')
      .map((item) => String(item.keyword).trim())
  )).sort((a, b) => a.localeCompare(b, 'tr'));
}

/**
 * Kanonik etiket kataloğu: `{name, color, icon}` üçlüleri.
 *
 * BOŞ katalog yetkilidir: projede bilinçli olarak etiket tanımlanmamış olabilir.
 * Yalnızca katalog alanı HİÇ yoksa (eski anlık görüntü) görev anahtar
 * sözcüklerinden türetilir.
 */
function tagsForProject(project, tasks) {
  if (!project) return [];
  const hasCatalog = Array.isArray(project.tagCatalog) || Array.isArray(project.tags);
  return hasCatalog ? projectTagCatalog(project) : normalizeProjectTags(legacyProjectTags(project.id, tasks));
}

function projectLabel(project) {
  if (!project) return '';
  return project.code ? `${project.code} · ${project.name}` : project.name;
}

function personLabel(person) {
  const employeeNo = person.employeeNo || person.SicilNo || person.PersonelNo || person.CalisanNo;
  return employeeNo ? `${employeeNo} · ${person.name}` : person.name;
}

export function TaskDrawer({ task, tasks, onClose, onUpdate, onDelete }) {
  const people = useAllPeople();
  const projects = useAllProjects();
  const calendars = useCalendars();
  const allWbs = useAllWbs();
  const { baseline, snapshot: baselineSnapshot } = useTaskPrimaryBaseline(task.id);
  const { generateTaskSeries, cancelTaskFieldUpdates } = useTaskActions();
  const occurrenceCount = useMemo(
    () => tasks.filter((item) => item.recurrenceParentId === task.id).length,
    [tasks, task.id]
  );
  const [local, setLocal] = useState({ ...task });
  // Kalıcılaştırılmayan başlık taslağı. Boş başlık sunucuya gönderilmediği için
  // yetkili görev kaydı eski başlığı taşımaya devam eder; taslak bu referansta
  // tutulmasaydı, kullanıcı başka bir alanı düzenler düzenlemez gelen yeni
  // `task` nesnesi silinen başlığı geri yazardı.
  const titleDraftRef = useRef(null);

  useEffect(() => {
    titleDraftRef.current = null;
  }, [task.id]);

  useEffect(() => {
    setLocal((current) => {
      const draft = titleDraftRef.current;
      return draft === null ? { ...task } : { ...task, task: draft };
    });
  }, [task]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === local.projectId) || null,
    [projects, local.projectId]
  );
  const projectTags = useMemo(() => tagsForProject(selectedProject, tasks), [selectedProject, tasks]);
  const calendarWarnings = useMemo(
    () => getTaskCalendarWarnings(local, { projects, calendars }),
    [local, projects, calendars]
  );
  // Görev kendi takvimini geçersiz kılabilir; tekrar önizlemesi de üretimle aynı
  // takvimi kullanmalıdır (bkz. resolveTaskCalendar önceliği).
  const taskCalendar = useMemo(
    () => resolveTaskCalendar(local, projects, calendars),
    [local, projects, calendars]
  );

  const projectWbsRows = useMemo(() => {
    const projectWbs = allWbs.filter((node) => node.projectId === local.projectId);
    return flattenWbsTree(buildWbsTree(projectWbs));
  }, [allWbs, local.projectId]);
  // Büyük projelerde dağılım ağacı yüzlerce düğüm içerebilir; liste canlı aramayla sunulur.
  const wbsOptions = useMemo(() => projectWbsRows.map(({ node, depth }) => ({
    value: node.id,
    label: `${'— '.repeat(depth)}${node.code} · ${node.name}`,
    description: formatWbsPath(allWbs, node.id),
    keywords: [node.code, node.name]
  })), [projectWbsRows, allWbs]);

  const projectOptions = useMemo(() => {
    const listed = visibleProjects(projects);
    if (selectedProject && !listed.some((project) => project.id === selectedProject.id)) listed.unshift(selectedProject);
    return [
      { value: '', label: 'Proje seçilmedi', icon: <Icons.Layers size={13} /> },
      ...listed.map((project) => {
        const type = projectTypeMeta(project.projectTypeCode, project.projectTypeName);
        const ProjectIcon = Icons[type.icon] || Icons.Layers;
        return {
          value: project.id,
          label: projectLabel(project),
          group: `${type.code} · ${type.name}`,
          description: isArchivedProject(project) ? 'Tamamlanan / kapatılan' : null,
          keywords: [project.code, project.name, type.code, type.name],
          icon: <ProjectIcon size={13} />
        };
      })
    ];
  }, [projects, selectedProject]);

  const selectedAssignees = useMemo(() => {
    const records = [];
    const usedNames = new Set();
    for (const id of local.assigneeIds || []) {
      const person = people.find((item) => String(item.id) === String(id));
      if (!person) continue;
      records.push({ id: person.id, name: person.name, person });
      usedNames.add(person.name);
    }
    for (const name of local.sorumlu || []) {
      if (usedNames.has(name)) continue;
      const person = people.find((item) => item.name === name) || null;
      records.push({ id: person?.id || name, name, person });
      usedNames.add(name);
    }
    return records;
  }, [people, local.assigneeIds, local.sorumlu]);

  const personOptions = useMemo(() => {
    const selectedIds = new Set(selectedAssignees.map((record) => String(record.id)));
    // Yalnızca Sicil kimliğiyle eşleşmeyen (eski ad tabanlı) kayıtlar için ad
    // eşlemesi kullanılır. Aksi hâlde aynı ada sahip ikinci bir çalışan listeden
    // düşer ve göreve hiçbir zaman atanamazdı.
    const legacyNames = new Set(selectedAssignees.filter((record) => !record.person).map((record) => record.name));
    return people
      .filter((person) => !selectedIds.has(String(person.id)) && !legacyNames.has(person.name))
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name, 'tr'))
      .map((person) => ({
        value: person.id,
        label: personLabel(person),
        description: person.role || null,
        group: [person.organization?.directorate, person.organization?.department, person.organization?.unit].filter(Boolean).join(' / '),
        keywords: [person.name, person.employeeNo, person.username, person.role, person.team],
        icon: <Avatar name={person.name} person={person} size="sm" />
      }));
  }, [people, selectedAssignees]);

  const save = (patch) => {
    const next = { ...local, ...patch };
    setLocal(next);
    onUpdate(task.id, patch);
  };

  /**
   * Başlık yazımı.
   *
   * Kullanıcı başlığı silip yeniden yazabilmelidir; bu yüzden yerel değer her
   * tuş vuruşunda güncellenir. Ancak BOŞ başlık kalıcılaştırmaya GÖNDERİLMEZ:
   * sunucu `TASK_TITLE_REQUIRED` ile tüm yamayı reddediyor, aynı yamada
   * birleştirilen ilerleme ve tarih düzenlemeleri de birlikte düşüyordu.
   *
   * Alan boşaldığında kuyrukta bekleyen başlık yaması da İPTAL EDİLİR: `ABC` →
   * `AB` → `A` → boş yazımında kuyrukta hâlâ `A` duruyordu ve gecikme dolunca
   * (ya da panel kapanınca) arayüzün "kaydedilmeyecek" dediği bu ön ek
   * kalıcılaşıyordu.
   */
  const saveTitle = (value) => {
    setLocal((current) => ({ ...current, task: value }));
    if (String(value).trim()) {
      titleDraftRef.current = null;
      onUpdate(task.id, { task: value });
      return;
    }
    titleDraftRef.current = value;
    cancelTaskFieldUpdates(task.id, ['task']);
  };

  useEffect(() => {
    if (local.keyword !== 'Yeni' || projectTags.some((tag) => tag.name === 'Yeni')) return;
    setLocal((current) => ({ ...current, keyword: '' }));
    onUpdate(task.id, { keyword: '' });
  }, [local.keyword, projectTags, task.id, onUpdate]);

  const changeProject = (projectId) => {
    const project = projects.find((item) => item.id === projectId) || null;
    const tags = tagsForProject(project, tasks);
    const roots = allWbs.filter((node) => node.projectId === projectId && node.parentId == null);
    save({
      projectId: projectId || null,
      projectCode: project?.code || '',
      proje: project?.name || '',
      color: project?.color || local.color,
      wbsId: roots.length === 1 ? roots[0].id : null,
      keyword: tags.some((tag) => tag.name === local.keyword) ? local.keyword : (tags[0]?.name || '')
    });
  };

  const addAssignee = (personId) => {
    const person = people.find((item) => String(item.id) === String(personId));
    if (!person) return;
    const assigneeIds = [...new Set([...(local.assigneeIds || []).map(String), String(person.id)])];
    const sorumlu = [...new Set([...(local.sorumlu || []), person.name])];
    save({ assigneeIds, sorumlu });
  };

  const removeAssignee = (record) => {
    save({
      assigneeIds: (local.assigneeIds || []).filter((id) => String(id) !== String(record.id)),
      sorumlu: (local.sorumlu || []).filter((name) => name !== record.name)
    });
  };

  const today_ = today();
  const overdue = local.status !== 'done' && local.targetFinish && diffDays(local.targetFinish, today_) < 0;
  const color = projectColorVar(local.proje);

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-head">
          <div className="col" style={{ gap: 8, flex: 1 }}>
            <div className="row" style={{ gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: 99, background: color }} />
              <span className="muted" style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                {projectLabel(selectedProject) || local.proje}
              </span>
              {local.keyword && <><span className="muted">·</span><TaskKeyword task={local} /></>}
            </div>
            {/* Başlık boşken KAYDEDİLMEZ. Boş başlık sunucuda
                TASK_TITLE_REQUIRED ile reddediliyor; aynı yamada birleştirilen
                ilerleme/tarih düzenlemeleri de o istekle birlikte kaybediliyordu. */}
            <textarea
              value={local.task}
              onChange={(e) => saveTitle(e.target.value)}
              aria-label="Görev başlığı"
              aria-invalid={!String(local.task || '').trim()}
              rows={2}
              style={{
                border: 0, background: 'transparent', resize: 'none',
                font: 'inherit', fontSize: 18, fontWeight: 600, lineHeight: 1.35,
                color: 'var(--text)', letterSpacing: '-0.015em', outline: 'none',
                padding: 0, width: '100%'
              }}
            />
            {!String(local.task || '').trim() && (
              <span className="drawer-title-warning">
                <Icons.Alert size={12} /> Görev başlığı boş bırakılamaz; başlık girilene kadar değişiklikler kaydedilmez.
              </span>
            )}
          </div>
          <button className="icon-btn" onClick={onClose} title="Kapat (Esc)"><Icons.Close size={16} /></button>
        </div>

        <div className="drawer-body">
          <div className="col" style={{ gap: 18 }}>
            <Section title="Durum">
              <div className="seg" style={{ width: '100%' }}>
                {[
                  ['todo', 'Yapılacak', statusColorVar('todo'), 'todo'],
                  ['in_progress', 'Devam ediyor', statusColorVar('in_progress'), 'in_progress'],
                  ['done', 'Tamamlandı', statusColorVar('done'), 'done']
                ].map(([id, label, statusColor, iconId]) => {
                  const isActive = (local.status || 'todo') === id;
                  return (
                    <button
                      key={id}
                      className={isActive ? 'active' : ''}
                      onClick={() => save({ status: id })}
                      style={{
                        flex: 1,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                        color: isActive ? statusColor : 'var(--text-muted)',
                        background: isActive ? `color-mix(in oklab, ${statusColor} 14%, transparent)` : 'transparent',
                        fontWeight: 600
                      }}
                    >
                      <StatusIcon id={iconId} size={12} /> {label}
                    </button>
                  );
                })}
              </div>
            </Section>

            <Section title="Proje, WBS & Etiket">
              <div className="task-project-wbs-grid">
                <div className="col" style={{ gap: 6 }}>
                  <div className="label">Proje</div>
                  <SearchableSelect
                    value={local.projectId || ''}
                    options={projectOptions}
                    onChange={changeProject}
                    placeholder="Proje seçilmedi"
                    searchPlaceholder="Proje kodu, adı veya türüyle ara"
                    maxVisible={60}
                  />
                </div>
                <div className="col" style={{ gap: 6 }}>
                  <div className="label">WBS</div>
                  <SearchableSelect
                    value={local.wbsId || ''}
                    options={wbsOptions}
                    onChange={(wbsId) => save({ wbsId: wbsId || null })}
                    placeholder="WBS seçilmedi"
                    searchPlaceholder="WBS kodu veya adıyla ara"
                    emptyText="Bu projede dağılım düğümü bulunamadı."
                    disabled={!local.projectId || projectWbsRows.length === 0}
                    maxVisible={60}
                  />
                </div>
              </div>
              <div className="col" style={{ gap: 6 }}>
                <div className="label">Etiket</div>
                <SearchableSelect
                  value={local.keyword || ''}
                  options={projectTags.map((tag) => {
                    const TagIcon = Icons[tag.icon] || Icons.Flag;
                    return {
                      value: tag.name,
                      label: tag.name,
                      keywords: [tag.name],
                      icon: <TagIcon size={13} style={{ color: COLOR_MAP[tag.color] || 'var(--c-blue)' }} />
                    };
                  })}
                  onChange={(keyword) => save({ keyword })}
                  placeholder={projectTags.length ? 'Etiket seçin' : 'Önce Proje Yapısı sayfasında etiket tanımlayın'}
                  searchPlaceholder="Etiket adıyla ara"
                  emptyText="Eşleşen etiket bulunamadı."
                  disabled={!local.projectId || projectTags.length === 0}
                  allowClear
                  clearLabel="Etiketi kaldır"
                />
                <div className="muted" style={{ fontSize: 11.5 }}>
                  Görev etiketi serbest metin değildir; seçili projenin kontrollü etiket kataloğundan açıkça seçilir.
                </div>
              </div>
            </Section>

            <Section title="Sorumlular">
              <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {selectedAssignees.map((record) => (
                  <span key={`${record.id}:${record.name}`} className="row" style={{ gap: 6, padding: '3px 8px 3px 4px', border: '1px solid var(--border)', borderRadius: 'var(--r-pill)', background: 'var(--bg-elev-2)' }}>
                    <Avatar name={record.name} person={record.person} size="sm" />
                    <span style={{ fontSize: 12 }}>{record.name}</span>
                    <button className="icon-btn" style={{ width: 18, height: 18 }} onClick={() => removeAssignee(record)}><Icons.Close size={10} /></button>
                  </span>
                ))}
              </div>
              <SearchableSelect
                value=""
                options={personOptions}
                onChange={addAssignee}
                placeholder="+ Sorumlu ekle"
                searchPlaceholder="Ad, sicil, unvan veya birimle ara"
                emptyText="Eklenebilecek başka personel bulunamadı."
                maxVisible={60}
                compact
              />
            </Section>

            <Section title="Güncel Plan">
              <div className="task-date-grid">
                <DateField label="Planlanan Başlangıç" value={local.plannedStart} onChange={(v) => save({ plannedStart: v })} />
                <DateField label="Planlanan Bitiş" value={local.plannedFinish} onChange={(v) => save({ plannedFinish: v })} />
                <DateField label="Hedef Bitiş" value={local.targetFinish} onChange={(v) => save({ targetFinish: v })} accent={overdue ? 'var(--status-overdue)' : null} />
              </div>
              <div className="muted" style={{ fontSize: 11.5 }}>
                Planlanan süre: <span className="tabular">{local.plannedDurationDays ?? '—'}</span> çalışma günü
              </div>
              {calendarWarnings.length > 0 && (
                <div className="calendar-warning">
                  <strong>Çalışma takvimi uyarısı</strong>
                  {calendarWarnings.map((warning) => (
                    <div key={warning.field}>{warning.label}: {fmt(warning.date, 'dd MMM yyyy')} · {warning.reason}</div>
                  ))}
                </div>
              )}
            </Section>

            <Section
              title="Tekrar"
              info={
                <InfoButton title="Tekrarlayan görev" icon={<Icons.Clock size={12} />}>
                  <p>Uzun süre boyunca aynı işin düzenli olarak yinelendiği durumlar için tekrar kuralı tanımlayın.</p>
                  <div className="rt-sep" />
                  <p>Kural, takvim uygulamalarının ortak standardı olan <strong>RFC 5545 RRULE</strong> biçiminde saklanır;
                    dışa aktarıldığında başka bir sisteme olduğu gibi taşınabilir.</p>
                  <div className="rt-sep" />
                  <div className="rt-row"><span className="rt-label">Şablon</span><span className="rt-val">Kuralı taşıyan görev</span></div>
                  <div className="rt-row"><span className="rt-label">Yineleme</span><span className="rt-val">Üretilen sıradan görev</span></div>
                  <div className="rt-foot"><Icons.Sparkle size={11} /> Yinelemeler tek tek ilerletilebilir ve düzenlenebilir.</div>
                </InfoButton>
              }
            >
              <RecurrenceEditor
                task={local}
                calendar={taskCalendar}
                occurrenceCount={occurrenceCount}
                onChange={(recurrence) => save({ recurrence })}
                onGenerate={() => generateTaskSeries(task.id)}
              />
            </Section>

            <Section title="Gerçekleşen & Kalan">
              <div className="task-date-grid">
                <DateField label="Gerçekleşen Başlangıç" value={local.actualStart} onChange={(v) => save({ actualStart: v })} nullable />
                <DateField label="Gerçekleşen Bitiş" value={local.actualFinish} onChange={(v) => save({ actualFinish: v })} nullable />
                <NumberField label="Kalan Süre" value={local.remainingDurationDays} onChange={(v) => save({ remainingDurationDays: v })} suffix="gün" />
              </div>
            </Section>

            {baselineSnapshot && (
              <Section title={`Baz Plan · ${baseline?.name || 'Birincil Baz Plan'}`}>
                <div className="task-date-grid">
                  <ReadOnlyField label="Başlangıç" value={baselineSnapshot.plannedStart ? fmt(baselineSnapshot.plannedStart, 'dd MMM yyyy') : '—'} />
                  <ReadOnlyField label="Bitiş" value={baselineSnapshot.plannedFinish ? fmt(baselineSnapshot.plannedFinish, 'dd MMM yyyy') : '—'} />
                  <ReadOnlyField label="Süre" value={baselineSnapshot.plannedDurationDays == null ? '—' : `${baselineSnapshot.plannedDurationDays} gün`} />
                </div>
              </Section>
            )}

            <Section title="İlerleme">
              <div className="row" style={{ gap: 12 }}>
                <input
                  type="range" min={0} max={100} step={5}
                  value={local.progress || 0}
                  onChange={(e) => save({ progress: parseInt(e.target.value) })}
                  style={{ flex: 1, accentColor: 'var(--accent)' }}
                />
                <span className="tabular" style={{ fontWeight: 600, minWidth: 38, textAlign: 'right' }}>{local.progress || 0}%</span>
              </div>
            </Section>

            <Section
              title="İlişkiler & Bağımlılıklar"
              info={
                <InfoButton title="Görev ilişkileri" icon={<Icons.Link size={12} />}>
                  <p><strong>Bağımlılık tipleri ve lead/lag:</strong></p>
                  <div className="rt-sep" />
                  {Object.values(REL_TYPES).map((rt) =>
                    <div key={rt.code} style={{ marginBottom: 6 }}>
                      <div className="rt-row">
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--accent)', minWidth: 28 }}>{rt.code}</span>
                        <span style={{ fontWeight: 600 }}>{rt.name}</span>
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', paddingLeft: 36, lineHeight: 1.45 }}>{rt.description}</div>
                    </div>
                  )}
                  <div className="rt-sep" />
                  <p>Pozitif değer gecikme (lag), negatif değer öne çekme (lead) oluşturur. Gün, hafta veya ay birimi seçilebilir.</p>
                </InfoButton>
              }
            >
              <RelEditor task={local} tasks={tasks} onChange={(deps) => save({ deps })} />
            </Section>

            <Section title="Notlar">
              <textarea
                className="input" rows={4}
                value={local.description || ''}
                onChange={(e) => save({ description: e.target.value })}
                placeholder="Notlar, gereksinimler, bağlantılar..."
                style={{ resize: 'vertical', fontFamily: 'inherit' }}
              />
            </Section>
          </div>
        </div>

        <div className="drawer-foot">
          <button className="btn" onClick={() => { if (confirm('Görev silinsin mi?')) { onDelete(task.id); onClose(); } }}>
            <Icons.Trash size={13} /> Sil
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn primary" onClick={onClose}>Tamam</button>
        </div>
      </div>
    </>
  );
}

/**
 * Tekrar kuralı düzenleyicisi.
 *
 * Kural içeride RFC 5545 `RRULE` metni olarak tutulur; form alanları yalnızca
 * bu metnin okunabilir bir yüzüdür. Böylece kural dışa aktarımda ve başka
 * sistemlerle alışverişte standart kalır.
 */
function RecurrenceEditor({ task, calendar, occurrenceCount, onChange, onGenerate }) {
  const rule = normalizeRecurrenceRule(task.recurrence);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  // Serinin başlangıç günü (RFC 5545 DTSTART). Haftalık kuralda bu gün her zaman
  // seçili kalır: BYDAY başlangıç gününü dışlarsa kural üç yineleme derken
  // şablonla birlikte dört görev oluşur ve dışa aktarılan RRULE'ün DTSTART'ı
  // kendi kuralını sağlamaz.
  const startWeekday = task.plannedStart
    ? RECURRENCE_WEEKDAYS[(new Date(`${task.plannedStart}T00:00:00`).getDay() + 6) % 7]
    : null;

  const patch = (changes) => {
    const merged = { ...(rule || { freq: 'WEEKLY', interval: 1 }), ...changes };
    if (merged.freq === 'WEEKLY' && startWeekday) {
      const days = Array.isArray(merged.byWeekday) ? merged.byWeekday : [];
      merged.byWeekday = days.includes(startWeekday) ? days : [...days, startWeekday];
    }
    const next = normalizeRecurrenceRule(merged);
    setMessage(null);
    onChange(next ? formatRecurrenceRule(next) : null);
  };

  const clearRule = () => {
    // Üretilmiş yinelemeler şablona bağlı kalır; kural silinseydi bu görevler
    // kuralsız bir şablona bağlı "yineleme" olarak kalır, sonra tanımlanan yeni
    // bir kural eskilerin yanına ikinci bir seri eklerdi.
    if (occurrenceCount > 0) {
      setMessage({
        type: 'error',
        text: 'Bu seriden üretilmiş yinelemeler var. Kuralı kaldırmadan önce yinelemeleri silin.'
      });
      return;
    }
    setMessage(null);
    onChange(null);
  };

  // Önizleme üretimle AYNI planlayıcıyı kullanır: ham açılım hafta sonuna denk
  // gelen günleri gösterir, üretim ise onları iş gününe kaydırıp tekilleştirir;
  // ikisi ayrıştığında onay ekranı oluşacak görevlerle çelişirdi.
  const preview = rule
    ? planRecurringOccurrences(task, rule, { calendar, limit: 4 }).map((occurrence) => occurrence.plannedStart)
    : [];

  const generate = async () => {
    setBusy(true);
    setMessage(null);
    const result = await onGenerate();
    setBusy(false);
    if (!result?.ok) {
      setMessage({ type: 'error', text: result?.error?.message || 'Tekrarlar oluşturulamadı.' });
      return;
    }
    const created = Array.isArray(result.value?.taskUpserts) ? result.value.taskUpserts.length : 0;
    setMessage({
      type: 'success',
      text: created ? `${created} yineleme oluşturuldu.` : 'Oluşturulacak yeni yineleme yok.'
    });
  };

  if (task.recurrenceParentId) {
    return (
      <div className="recurrence-note">
        <Icons.Clock size={13} />
        <span>Bu görev bir tekrar serisinin yinelemesidir. Kural, serinin şablon görevinde tanımlıdır.</span>
      </div>
    );
  }

  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <select
          className="input"
          aria-label="Tekrar sıklığı"
          value={rule?.freq || ''}
          onChange={(event) => (event.target.value
            ? patch({ freq: event.target.value })
            : clearRule())}
          style={{ maxWidth: 170 }}
        >
          <option value="">Tekrar yok</option>
          <option value="DAILY">Günlük</option>
          <option value="WEEKLY">Haftalık</option>
          <option value="MONTHLY">Aylık</option>
          <option value="YEARLY">Yıllık</option>
        </select>
        {rule && (
          <label className="row" style={{ gap: 6, fontSize: 12 }}>
            <span className="muted">Aralık</span>
            <input
              className="input tabular"
              type="number"
              min={1}
              max={99}
              aria-label="Tekrar aralığı"
              value={rule.interval}
              onChange={(event) => patch({ interval: event.target.value })}
              style={{ width: 68 }}
            />
          </label>
        )}
      </div>

      {rule?.freq === 'WEEKLY' && (
        <div className="recurrence-days" role="group" aria-label="Tekrar günleri">
          {RECURRENCE_WEEKDAYS.map((day, index) => {
            const locked = day === startWeekday;
            return (
              <button
                key={day}
                type="button"
                className={`recurrence-day${rule.byWeekday.includes(day) ? ' active' : ''}`}
                aria-pressed={rule.byWeekday.includes(day)}
                disabled={locked}
                title={locked ? 'Serinin başlangıç günü her zaman seriye dahildir.' : undefined}
                onClick={() => patch({
                  byWeekday: rule.byWeekday.includes(day)
                    ? rule.byWeekday.filter((value) => value !== day)
                    : [...rule.byWeekday, day]
                })}
              >
                {TR_DAYS[index]}
              </button>
            );
          })}
        </div>
      )}

      {rule?.freq === 'MONTHLY' && (
        <label className="row" style={{ gap: 6, fontSize: 12 }}>
          <span className="muted">Ayın günü</span>
          <input
            className="input tabular"
            type="number"
            min={1}
            max={31}
            aria-label="Ayın günü"
            value={rule.byMonthDay || ''}
            placeholder="Başlangıç günü"
            onChange={(event) => patch({ byMonthDay: event.target.value })}
            style={{ width: 90 }}
          />
        </label>
      )}

      {rule && (
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <label className="row" style={{ gap: 6, fontSize: 12 }}>
            <span className="muted">Yineleme sayısı</span>
            <input
              className="input tabular"
              type="number"
              min={1}
              max={MAX_RECURRENCE_OCCURRENCES}
              aria-label="Yineleme sayısı"
              value={rule.count || ''}
              placeholder="—"
              // Açılım güvenlik tavanında durur; tavanı aşan bir sayı hiçbir
              // zaman tamamlanamayacağı için girildiği anda sınırlanır.
              onChange={(event) => patch({
                count: Math.min(Number(event.target.value) || 0, MAX_RECURRENCE_OCCURRENCES) || '',
                until: null
              })}
              style={{ width: 80 }}
            />
          </label>
          <label className="row" style={{ gap: 6, fontSize: 12 }}>
            <span className="muted">Bitiş tarihi</span>
            <DateInput
              value={rule.until || ''}
              // Başlangıçtan önce biten kural sözdizimsel olarak geçerlidir ama
              // hiçbir yineleme üretemez; kaydedilmeden önce reddedilir.
              onChange={(value) => {
                if (value && task.plannedStart && value < task.plannedStart) {
                  setMessage({ type: 'error', text: 'Tekrar bitiş tarihi planlanan başlangıçtan önce olamaz.' });
                  return;
                }
                patch({ until: value, count: null });
              }}
              allowEmpty
            />
          </label>
        </div>
      )}

      {rule && (
        <div className="recurrence-summary">
          <div className="row" style={{ gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <span className="recurrence-rule">{describeRecurrenceRule(rule)}</span>
            <code className="recurrence-code">RRULE:{formatRecurrenceRule(rule)}</code>
          </div>
          {preview.length > 0 && (
            <div className="muted" style={{ fontSize: 11.5 }}>
              İlk yinelemeler: {preview.map((date) => fmt(date, 'dd MMM')).join(' · ')}
              {!rule.count && !rule.until ? ' · …' : ''}
            </div>
          )}
          {!task.plannedStart && (
            <div className="muted" style={{ fontSize: 11.5, color: 'var(--status-overdue)' }}>
              Yinelemeleri üretmek için önce planlanan başlangıç tarihi girilmelidir.
            </div>
          )}
        </div>
      )}

      {rule && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn primary"
            disabled={busy || !task.plannedStart}
            onClick={generate}
          >
            <Icons.Plus size={13} /> {busy ? 'Oluşturuluyor…' : 'Tekrarları oluştur'}
          </button>
          <span className="muted" style={{ fontSize: 11.5, alignSelf: 'center' }}>
            {occurrenceCount} yineleme bu seriden üretildi.
          </span>
        </div>
      )}

      {message && (
        <div className="muted" style={{ fontSize: 11.5, color: message.type === 'error' ? 'var(--status-overdue)' : 'var(--status-done)' }}>
          {message.text}
        </div>
      )}
    </div>
  );
}

function Section({ title, info, children }) {
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 4, alignItems: 'center' }}>
        <div className="label" style={{ margin: 0 }}>{title}</div>
        {info}
      </div>
      {children}
    </div>
  );
}

function RelEditor({ task, tasks, onChange }) {
  const deps = useMemo(() => task.deps || [], [task.deps]);
  const others = tasks.filter((t) => t.id !== task.id && (!task.projectId || t.projectId === task.projectId));
  const [selectedType, setSelectedType] = useState('FS');
  // Öncül görev listesi de büyük projelerde canlı arama gerektirir.
  const predecessorOptions = useMemo(() => others
    .filter((candidate) => !deps.some((dependency) => depId(dependency) === candidate.id))
    .slice()
    .sort((left, right) => String(left.task || '').localeCompare(String(right.task || ''), 'tr'))
    .map((candidate) => ({
      value: candidate.id,
      label: candidate.task,
      description: candidate.keyword || null,
      keywords: [candidate.task, candidate.keyword, candidate.projectCode]
    })), [others, deps]);

  const updateDep = (idx, patch) => {
    const next = deps.map((d, i) => {
      if (i !== idx) return d;
      const cur = typeof d === 'string' ? { id: d, type: 'FS', lagValue: 0, lagUnit: 'day', lagDays: 0 } : { ...d };
      const updated = { ...cur, ...patch };
      return { ...updated, lagDays: dependencyLagDays(updated) };
    });
    onChange(next);
  };
  const removeDep = (idx) => onChange(deps.filter((_, i) => i !== idx));
  const addDep = (depTaskId, type) => {
    if (!depTaskId) return;
    onChange([...deps, { id: depTaskId, predecessorId: depTaskId, type: type || 'FS', lagValue: 0, lagUnit: 'day', lagDays: 0 }]);
  };

  return (
    <div className="col" style={{ gap: 8 }}>
      {deps.length === 0 &&
        <div className="muted" style={{ fontSize: 12, padding: '8px 10px', background: 'var(--bg-elev-2)', borderRadius: 'var(--r-md)', textAlign: 'center' }}>
          Bu görevin henüz bir ilişkisi yok. Aşağıdan ekleyebilirsiniz.
        </div>
      }
      {deps.map((d, idx) => {
        const id = depId(d);
        const type = relTypeOf(d);
        const dep = tasks.find((x) => x.id === id);
        const rt = REL_TYPES[type];
        const lagValue = lagValueOf(d);
        const lagUnit = lagUnitOf(d);
        if (!dep) return null;
        return (
          <div key={`${id}-${idx}`} className="rel-item">
            <div className="rel-row">
              <div className="row" style={{ gap: 8, minWidth: 0 }}>
                <span style={{ width: 6, height: 6, borderRadius: 99, background: projectColorVar(dep.proje), flexShrink: 0 }} />
                <span style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dep.task}</span>
                {lagValue !== 0 && <span className="badge">{formatDependencyLag(d)}</span>}
              </div>
              <button className="icon-btn" style={{ width: 24, height: 24, flexShrink: 0 }} onClick={() => removeDep(idx)}><Icons.Close size={11} /></button>
            </div>
            <div className="rel-fields-grid">
              <label className="rel-type-field">
                <span className="rel-type-field-label">İlişki türü</span>
                <select
                  className="input rel-type-select"
                  value={type}
                  onChange={(e) => updateDep(idx, { type: e.target.value })}
                >
                  {Object.values(REL_TYPES).map((item) =>
                    <option key={item.code} value={item.code}>{item.code} — {item.name}</option>
                  )}
                </select>
              </label>
              <label className="rel-type-field">
                <span className="rel-type-field-label">Lead / Lag</span>
                <input
                  type="number"
                  step="1"
                  className="input"
                  value={lagValue}
                  onChange={(e) => updateDep(idx, { lagValue: e.target.value === '' ? 0 : Number(e.target.value) })}
                />
              </label>
              <label className="rel-type-field">
                <span className="rel-type-field-label">Birim</span>
                <select className="input" value={lagUnit} onChange={(e) => updateDep(idx, { lagUnit: e.target.value })}>
                  {Object.values(LAG_UNITS).map((unit) => <option key={unit.id} value={unit.id}>{unit.label}</option>)}
                </select>
              </label>
            </div>
            <div className="rel-type-help">
              <strong>{rt.code} · {rt.name}:</strong> {rt.description}
              <div style={{ marginTop: 4, color: 'var(--text-dim)' }}>
                {lagValue > 0 ? `+${lagValue} ${LAG_UNITS[lagUnit].short} gecikme` : lagValue < 0 ? `${Math.abs(lagValue)} ${LAG_UNITS[lagUnit].short} öne çekme` : 'Ek lead/lag yok'}
              </div>
            </div>
          </div>
        );
      })}

      <div className="rel-add-row">
        <select
          className="input"
          value={selectedType}
          onChange={(e) => setSelectedType(e.target.value)}
        >
          {Object.values(REL_TYPES).map((rt) =>
            <option key={rt.code} value={rt.code}>{rt.code}</option>
          )}
        </select>
        <SearchableSelect
          value=""
          options={predecessorOptions}
          onChange={(taskId) => addDep(taskId, selectedType)}
          placeholder="+ Öncül görev seçin..."
          searchPlaceholder="Görev adı veya etiketiyle ara"
          emptyText="Eklenebilecek başka öncül görev yok."
          maxVisible={60}
          compact
        />
      </div>
    </div>
  );
}

function DateField({ label, value, onChange, accent, nullable = false }) {
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="label">{label}</div>
      <DateInput
        value={value || ''}
        onChange={(next) => onChange(nullable && !next ? null : next)}
        allowEmpty={nullable}
        style={accent ? { '--date-field-accent': accent } : undefined}
      />
    </div>
  );
}

function NumberField({ label, value, onChange, suffix }) {
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="label">{label}</div>
      <div className="row" style={{ gap: 6 }}>
        <input
          type="number"
          min={0}
          step={1}
          className="input"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? null : Math.max(0, Number(e.target.value)))}
        />
        {suffix && <span className="muted" style={{ fontSize: 12 }}>{suffix}</span>}
      </div>
    </div>
  );
}

function ReadOnlyField({ label, value }) {
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="label">{label}</div>
      <div className="input tabular" style={{ background: 'var(--bg-elev-2)', color: 'var(--text-muted)' }}>{value}</div>
    </div>
  );
}
