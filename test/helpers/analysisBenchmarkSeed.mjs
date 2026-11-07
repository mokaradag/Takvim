/**
 * Bilgin yönetim analizi kıyas kümesinin (Aşama F) SENTETİK verisi. Gerçek kişi, proje ya da kurum adı içermez.
 *
 * Arayüz kabulünün sentetik verisini (`scripts/ui-acceptance/uiSeed.mjs`) değiştirmeden genişletir; özgün 40 sorunun
 * analitik yapısını ve zorluğunu korumak için:
 *   - adında kurumsal sözcük geçen bir proje ("BGS Şube Çalışmaları") ve kısaltma + "TOOL" adlı bir proje ("KAP TOOL");
 *   - üç ve iki parçalı, soyadı büyük harfli ve Türkçe karakterli iki kişi (tamamen uydurma) ("Deniz Ufuk KARAAĞAÇLI", "Nehir SÜRMELİOĞLU");
 *   - B profilindeki yöneticiye birim, bölüm ve direktörlük düzeyinde yönetim kapsamı;
 *   - yüksek tamamlanmaya rağmen gecikmesi olan, gecikmesi bir kişide toplanan ve yakın teslimatı yoğun projeler.
 * Tarihler çağrı anındaki Türkiye gününe göredir (sınamalar saati sabitledikten sonra çağırır).
 */
import { P, PROJ, uiSeed } from '../../scripts/ui-acceptance/uiSeed.mjs';

export const BENCH_PEOPLE = Object.freeze({ KARAAGACLI: 920051, SURMELIOGLU: 920052 });
export const BENCH_PROJECTS = Object.freeze({ BGS: '11000000-0000-4000-8000-000000000011', KAP: '11000000-0000-4000-8000-000000000012' });
export const BENCH_PROFILES = Object.freeze({ A: P.A, B: P.B, C: P.C, D: P.D, E: P.E, F: P.F, G: P.G });

const CAL = '41000000-0000-4000-8000-000000000001';
const tid = (n) => `22000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function todayIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** [proje, sorumlular, durum (t yapılacak, p devam ediyor, d tamamlandı), öncelik, termin ofseti (gün), başlık] */
const SPEC = Object.freeze([
  // BGS Şube Çalışmaları: tamamlanma yüksek (6/10), buna karşın iki gecikme ve yakın teslimatlar.
  [BENCH_PROJECTS.BGS, [BENCH_PEOPLE.SURMELIOGLU], 'd', 'medium', -20, 'Faaliyet planı onayı'],
  [BENCH_PROJECTS.BGS, [BENCH_PEOPLE.SURMELIOGLU], 'd', 'medium', -14, 'Bütçe kalemleri kontrolü'],
  [BENCH_PROJECTS.BGS, [BENCH_PEOPLE.SURMELIOGLU], 'd', 'low', -9, 'Toplantı tutanakları'],
  [BENCH_PROJECTS.BGS, [BENCH_PEOPLE.SURMELIOGLU], 'd', 'medium', -5, 'Eğitim takvimi'],
  [BENCH_PROJECTS.BGS, [P.SELIN], 'd', 'low', -12, 'Envanter sayımı'],
  [BENCH_PROJECTS.BGS, [P.MEHMET_KAYA], 'd', 'medium', -3, 'Süreç haritası'],
  [BENCH_PROJECTS.BGS, [BENCH_PEOPLE.KARAAGACLI], 't', 'high', -6, 'Faaliyet raporu taslağı'],
  [BENCH_PROJECTS.BGS, [BENCH_PEOPLE.KARAAGACLI], 'p', 'critical', -2, 'Denetim bulguları yanıtı'],
  [BENCH_PROJECTS.BGS, [BENCH_PEOPLE.SURMELIOGLU], 'p', 'medium', 3, 'Paydaş görüşmeleri'],
  [BENCH_PROJECTS.BGS, [P.SELIN], 't', 'medium', 11, 'Yıl sonu değerlendirmesi'],
  // KAP TOOL: gecikme yoğun (3/7), gecikmeler tek kişide toplanıyor, 30 gün içinde teslimatlar.
  [BENCH_PROJECTS.KAP, [BENCH_PEOPLE.KARAAGACLI], 't', 'critical', -15, 'Araç gereksinim belgesi'],
  [BENCH_PROJECTS.KAP, [BENCH_PEOPLE.KARAAGACLI], 'p', 'high', -8, 'Prototip doğrulaması'],
  [BENCH_PROJECTS.KAP, [BENCH_PEOPLE.KARAAGACLI, P.BURAK], 't', 'high', -1, 'Veri bağlantısı testi'],
  [BENCH_PROJECTS.KAP, [P.BURAK], 'd', 'medium', -10, 'Lisans araştırması'],
  [BENCH_PROJECTS.KAP, [P.BURAK], 'p', 'medium', 5, 'Kullanıcı arayüzü taslağı'],
  [BENCH_PROJECTS.KAP, [BENCH_PEOPLE.KARAAGACLI], 't', 'medium', 13, 'Pilot kullanım planı'],
  [BENCH_PROJECTS.KAP, [BENCH_PEOPLE.SURMELIOGLU], 't', 'low', 27, 'Kullanım kılavuzu']
]);

const STATUS = Object.freeze({ t: 'planned', p: 'in-progress', d: 'done' });

export function analysisBenchmarkSeed() {
  const seed = uiSeed();
  const today = todayIso();
  const d = (offset) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
  const person = (Sicil, DisplayName, Username, Unit = 'BT', Department = 'Teknoloji', Directorate = 'Bilgi Sistemleri') => ({ Sicil, DisplayName, Username, Unit, Department, Directorate });
  seed.people.push(person(BENCH_PEOPLE.KARAAGACLI, 'Deniz Ufuk KARAAĞAÇLI', 'dukaraagacli'), person(BENCH_PEOPLE.SURMELIOGLU, 'Nehir SÜRMELİOĞLU', 'nsurmelioglu'));
  seed.projects.push(
    { ProjectId: BENCH_PROJECTS.BGS, SourceType: 'MANUAL', ProjectCode: 'BGS', ProjectName: 'BGS Şube Çalışmaları', LeadSicil: P.B, CalendarId: CAL },
    { ProjectId: BENCH_PROJECTS.KAP, SourceType: 'MANUAL', ProjectCode: 'KAP', ProjectName: 'KAP TOOL', LeadSicil: P.B, CalendarId: CAL });
  SPEC.forEach(([projectId, sicils, status, priority, offset, title], index) => {
    const id = tid(index + 1);
    const done = status === 'd';
    seed.tasks.push({ TaskId: id, ProjectId: projectId, Title: title, Status: STATUS[status], Priority: priority, TargetFinish: d(offset), PlannedStart: d(offset - 10),
      PlannedFinish: d(offset), CalendarId: CAL, ...(done ? { ActualStart: d(offset - 8), ActualFinish: d(Math.min(offset, 0)), Progress: 100 } : { Progress: status === 'p' ? 40 : 0 }),
      PlannedHours: 8 });
    for (const sicil of sicils) seed.taskAssignees.push({ TaskId: id, Sicil: sicil });
  });
  // B profili: birim (doğrudan ekip), bölüm ve direktörlük düzeyinde yönetim kapsamı.
  const unit = [BENCH_PEOPLE.KARAAGACLI, BENCH_PEOPLE.SURMELIOGLU];
  const department = [P.MEHMET_KAYA, P.MEHMET_YILDIZ, P.SELIN, P.BURAK, ...unit, P.A];
  const directorate = [...department, P.E, P.GIZEM, P.HAKAN];
  seed.executiveScope.push(...unit.map((EmployeeSicil) => ({ ManagerSicil: P.B, EmployeeSicil })),
    ...department.map((EmployeeSicil) => ({ ManagerSicil: P.B, EmployeeSicil, ScopeType: 'DEPARTMENT' })),
    ...directorate.map((EmployeeSicil) => ({ ManagerSicil: P.B, EmployeeSicil, ScopeType: 'DIRECTORATE' })));
  return seed;
}

export { P, PROJ };
