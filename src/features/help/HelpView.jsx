'use client';
import { useRef, useState } from 'react';
import { Icons } from '../../components/icons';

const SECTIONS = [
  { id: 'summary', label: 'Başlangıç', icon: 'Dashboard' },
  { id: 'modes', label: 'Çalışma Modları', icon: 'Sparkle' },
  { id: 'ozet', label: 'Özet', icon: 'Dashboard' },
  { id: 'veri', label: 'Görevler', icon: 'Table' },
  { id: 'wbs', label: 'Proje Yapısı', icon: 'Layers' },
  { id: 'takvim', label: 'Takvim', icon: 'Calendar' },
  { id: 'gantt', label: 'Gantt', icon: 'Gantt' },
  { id: 'kanban', label: 'Kanban', icon: 'Kanban' },
  { id: 'rapor', label: 'Raporlar', icon: 'Chart' },
  { id: 'kisi', label: 'Ekip', icon: 'Users' },
  { id: 'ayarlar', label: 'Ayarlar', icon: 'Settings' }
];

const CONTENT = {
  ozet: {
    title: 'Özet',
    intro: 'Seçili çalışma alanının genel durumunu tek bakışta izlemek için kullanılır. Proje seçildiğinde göstergeler yalnızca o projeyi, portföy seçildiğinde tüm projeleri temel alır.',
    points: ['Görev, gecikme ve ilerleme göstergelerini izleyin.', 'Grafiklerdeki eğilimleri ayrıntılı sayfalara geçmeden önce kontrol edin.', 'Bir gösterge beklenmedik görünüyorsa önce üstteki seçili proje bilgisini doğrulayın.']
  },
  veri: {
    title: 'Görevler',
    intro: 'Görevlerin ayrıntılı listesidir. Yeni görev oluşturma, filtreleme, sıralama ve görev ayrıntılarını düzenleme işlemleri burada yapılır.',
    points: ['Yeni görev düğmesi seçili proje altında yeni kayıt oluşturur.', 'Sütun başlıklarındaki filtreler birden çok koşulu birlikte kullanabilir.', 'Göreve tıklayarak tarihleri, etiketi, sorumluları ve ilişkileri düzenleyin.', 'Tatil veya hafta sonuna denk gelen plan tarihleri görev ayrıntısında uyarı olarak gösterilir.']
  },
  wbs: {
    title: 'Proje Yapısı',
    intro: 'Projelerin oluşturulduğu, temel bilgilerinin ve kullanılabilir etiketlerin yönetildiği, iş dağılım ağacının düzenlendiği ana tanım alanıdır.',
    points: ['Yeni Proje ile proje kaydı oluşturun; proje kodu kurumsal projelerde kullanılabilir, serbest projelerde isteğe bağlıdır.', 'Proje Tanımı bölümünde kod, ad, sorumlu, veri tarihi, renk ve etiketleri yönetin.', 'Etiketler görevlerde seçilebilir değerler olarak kullanılır.', 'İş Dağılım Ağacı sekmesinde WBS düğümlerini ekleyin, yeniden adlandırın ve hiyerarşiyi düzenleyin.']
  },
  takvim: {
    title: 'Takvim',
    intro: 'Görevleri aylık takvim üzerinde görsel olarak izlemek için kullanılır. Basit Modda Takvim varsayılan sekmedir; Hızlı Görev Tanımı ayrı bir sekmede açılır. Hafta sonları ve resmi tatiller çalışma takvimine göre ayırt edilir.',
    points: ['Basit Modda önce Takvim görünür; yeni kayıt için Hızlı Görev Tanımı sekmesine geçin.', 'Sorumluları ad veya personel numarasıyla arayın ve bir ya da daha çok kişiyi seçin.', 'Ay ve yıl seçerek dönemler arasında ilerleyin.', 'Görev kartına tıklayarak ayrıntı panelini açın.', 'Planlama yaparken çalışma günü dışı uyarılarını dikkate alın.']
  },
  gantt: {
    title: 'Gantt',
    intro: 'Zaman çizelgesini, WBS yapısını, sorumluları, bağımlılıkları ve kritik yolu birlikte incelemek için kullanılır.',
    points: ['Tarih aralığını elle seçebilir veya Otomatik seçeneğiyle görevlerin kapsadığı döneme dönebilirsiniz.', 'Proje görünümünde WBS ile Sorumlu / Kritik Yol görünümleri arasında geçiş yapın.', 'FS, SS, FF ve SF ilişkileri ile pozitif gecikme (lag) veya negatif öne çekme (lead) tanımlanabilir.', 'Gantt içeriği kendi alanında yatay ve dikey kaydırılır; sayfanın bütünü gereksiz yere kaymaz.']
  },
  kanban: {
    title: 'Kanban',
    intro: 'Görevlerin durum bazlı akışını izlemek ve işin hangi aşamada biriktiğini görmek için kullanılır.',
    points: ['Görevleri durum kolonlarında izleyin.', 'Kartlara tıklayarak görev ayrıntılarını açın.', 'Proje seçimi değiştiğinde pano otomatik olarak seçili projenin görevlerine geçer.']
  },
  rapor: {
    title: 'Raporlar',
    intro: 'Tamamlama, teslim, çevrim süresi, iş hızı, kaynak kullanımı ve eğilimleri analiz eder.',
    points: ['Grafikler sayfa açıldığında ve veri değiştiğinde hareketli olarak görünür.', 'Gösterge açıklamaları için bilgi simgelerini kullanın.', 'Dışa Aktar menüsünden seçili proje veya portföy için biçimlendirilmiş Excel raporu ve CSV alın.']
  },
  kisi: {
    title: 'Ekip',
    intro: 'Ekip üyelerinin görev dağılımını ve iş yükünü incelemek için kullanılır. Veritabanı entegrasyonunda kişi adıyla birlikte çalışan numarası da saklanabilir.',
    points: ['Proje çalışma alanında yalnızca ilgili kişiler ve görevler gösterilir.', 'İş yükü dengesini raporlarla birlikte değerlendirin.', 'Görev sorumlularını görev ayrıntı panelinden güncelleyin.']
  },
  ayarlar: {
    title: 'Ayarlar',
    intro: 'Basit / Gelişmiş Mod seçimi ile tema, vurgu rengi, yoğunluk, yazı boyutu ve hareket tercihlerini yönetir. Bu sayfa proje seçiminden bağımsızdır.',
    points: ['Çalışma Modu kartlarından Basit veya Gelişmiş Modu seçin.', 'Mod değiştirmek veriyi dönüştürmez veya silmez; aynı kayıtlar kullanılmaya devam eder.', 'Yazı boyutunu büyüttüğünüzde kenar çubuğu alt alanı görünür kalır.', 'Hareketi azalt seçeneği açıkken grafik ve arayüz animasyonları sınırlandırılır.']
  }
};

function Flow({ steps }) {
  return (
    <div className="help-flow" aria-label="İş akışı">
      {steps.map((step, index) => (
        <div className="help-flow-part" key={step.title}>
          <div className="help-flow-step">
            <span>{index + 1}</span>
            <div><strong>{step.title}</strong><small>{step.text}</small></div>
          </div>
          {index < steps.length - 1 && <div className="help-flow-arrow">→</div>}
        </div>
      ))}
    </div>
  );
}

function ModeGuide() {
  return (
    <div className="help-content-grid">
      <section className="help-hero-card">
        <div className="help-kicker">İki deneyim · tek veri altyapısı</div>
        <h2>İhtiyacınıza göre başlayın, istediğiniz zaman derinleşin</h2>
        <p>Basit Mod ve Gelişmiş Mod ayrı uygulamalar değildir. İkisi de aynı proje, görev ve kişi kayıtlarını kullanır. Basit Modda girilen bir kayıt daha sonra Gelişmiş Modda WBS, plan tarihleri, iş gücü, ilişkiler ve diğer alanlarla zenginleştirilebilir.</p>
      </section>
      <div className="help-mode-grid">
        <section className="card help-mode-card simple">
          <div className="help-mode-card-head"><Icons.Calendar size={20} /><div><small>Hızlı takip</small><h3>Basit Mod</h3></div></div>
          <Flow steps={[
            { title: 'Takvimi izle', text: 'Takvim sayfası varsayılan olarak aylık görünümle açılır.' },
            { title: 'Hızlı tanıma geç', text: 'Yeni kayıt için Hızlı Görev Tanımı sekmesini açın.' },
            { title: 'Sorumluyu ara', text: 'Ad veya personel numarasıyla bir ya da daha çok kişi seçin.' },
            { title: 'Termini ver', text: 'Termin tarihini belirleyip Takvime ekleyin.' }
          ]} />
        </section>
        <section className="card help-mode-card advanced">
          <div className="help-mode-card-head"><Icons.Gantt size={20} /><div><small>Tam proje yönetimi</small><h3>Gelişmiş Mod</h3></div></div>
          <Flow steps={[
            { title: 'Projeyi yapılandır', text: 'Kod, tanımlar, etiket ve WBS yapısını yönetin.' },
            { title: 'Planı ayrıntılandır', text: 'Tarih, süre, iş gücü ve sorumluları tamamlayın.' },
            { title: 'İlişkileri kur', text: 'FS/SS/FF/SF ile lead/lag değerlerini tanımlayın.' },
            { title: 'İzle ve raporla', text: 'Gantt, Kanban, Takvim ve raporlarla yönetin.' }
          ]} />
        </section>
      </div>
      <section className="card help-section-card">
        <h3>Modlar arasında geçiş</h3>
        <div className="help-checks">
          <div><span>1</span><p><strong>Ayarlar</strong> sayfasını açın.</p></div>
          <div><span>2</span><p>Üstteki çalışma modu kartlarından istediğiniz modu seçin.</p></div>
          <div><span>3</span><p>Basit Mod seçildiğinde uygulama Takvim odaklı sade görünüme geçer; Gelişmiş Mod seçildiğinde tüm proje yönetimi sayfaları yeniden açılır.</p></div>
        </div>
      </section>
    </div>
  );
}

function Summary() {
  return (
    <div className="help-content-grid">
      <section className="help-hero-card">
        <div className="help-kicker">MERGEN Rota · Sürüm 1.0</div>
        <h2>İki çalışma biçimiyle hızlı başlangıç</h2>
        <p>Yalnızca proje, görev, kısa açıklama, sorumlu ve termin takibi gerekiyorsa Basit Modu; WBS, bağımlılık, kritik yol, Kanban ve raporlama gerekiyorsa Gelişmiş Modu kullanın. Ayarlar sayfasından iki mod arasında veri kaybı olmadan geçiş yapabilirsiniz.</p>
      </section>
      <section className="card help-section-card">
        <h3>Basit Mod akışı</h3>
        <Flow steps={[
          { title: 'Takvim', text: 'Basit Mod Takvim sayfasında aylık görünümle başlar.' },
          { title: 'Hızlı Görev Tanımı', text: 'Yeni kayıt için ayrı sekmeye geçin.' },
          { title: 'Proje ve görev', text: 'Projeyi belirleyip görevi ve kısa açıklamayı yazın.' },
          { title: 'Sorumlu', text: 'Ad veya personel numarasıyla kişileri arayıp seçin.' },
          { title: 'Termin', text: 'Termin tarihini girip kaydı Takvime ekleyin.' }
        ]} />
      </section>
      <section className="card help-section-card">
        <h3>Gelişmiş Mod akışı</h3>
        <Flow steps={[
          { title: 'Proje oluştur', text: 'Proje Yapısı sayfasında kod ve temel bilgileri girin.' },
          { title: 'Etiket ve WBS', text: 'Etiketleri tanımlayın, iş dağılım ağacını kurun.' },
          { title: 'Görevleri girin', text: 'Tarih, sorumlu ve etiket bilgilerini tamamlayın.' },
          { title: 'İlişkileri kurun', text: 'FS/SS/FF/SF ve lead/lag değerlerini tanımlayın.' },
          { title: 'Planı izleyin', text: 'Gantt, Takvim ve Raporlar ile kontrol edin.' }
        ]} />
      </section>
      <section className="help-tip-grid">
        <div><Icons.Sparkle size={18} /><strong>Tek veri altyapısı</strong><span>Basit Mod kayıtları Gelişmiş Modda yeniden kullanılabilir ve zenginleştirilebilir.</span></div>
        <div><Icons.Calendar size={18} /><strong>Hızlı takip</strong><span>Takvim varsayılan görünüm, hızlı görev tanımı ise aynı sayfadaki ayrı sekmedir.</span></div>
        <div><Icons.Gantt size={18} /><strong>Derinleşen plan</strong><span>Gerektiğinde WBS, bağımlılık ve kritik yol araçlarına geçin.</span></div>
      </section>
    </div>
  );
}

export function HelpView() {
  const [section, setSection] = useState('summary');
  const page = CONTENT[section];
  const tabRefs = useRef(new Map());

  // Gezinen sekme durağı, OK TUŞLARIYLA birlikte anlam taşır. Yalnızca
  // `tabIndex={-1}` eklemek, seçili olmayan bölümleri klavyeyle tümüyle
  // ulaşılamaz yapardı: eskiden her düğme sekme sırasındaydı, dolayısıyla bu
  // tek başına bir gerileme olurdu. WAI-ARIA sekme kalıbı odağı ok, Home ve
  // End tuşlarıyla taşır.
  const focusSection = (id) => {
    setSection(id);
    // Odak, seçim durumu çizildikten sonra taşınır.
    requestAnimationFrame(() => tabRefs.current.get(id)?.focus());
  };

  const onTabKeyDown = (event) => {
    const ids = SECTIONS.map((item) => item.id);
    const current = ids.indexOf(section);
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      focusSection(ids[(current + 1) % ids.length]);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusSection(ids[(current - 1 + ids.length) % ids.length]);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusSection(ids[0]);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusSection(ids[ids.length - 1]);
    }
  };

  return (
    <div className="help-shell">
      {/* `role="tablist"` çocuklardan sekme anlamı bekler. Çocuklar düz düğme
          kaldığında ekran okuyucu "sekme içermeyen bir sekme listesi" duyuruyor
          ve seçili bölüm hiç bildirilmiyordu. */}
      <div className="help-page-switch" role="tablist" aria-label="Kullanım rehberi bölümleri">
        {SECTIONS.map((item) => {
          const Icon = Icons[item.icon];
          const selected = section === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`help-tab-${item.id}`}
              ref={(element) => {
                if (element) tabRefs.current.set(item.id, element);
                else tabRefs.current.delete(item.id);
              }}
              aria-selected={selected}
              aria-controls="help-tabpanel"
              tabIndex={selected ? 0 : -1}
              className={selected ? 'active' : ''}
              onKeyDown={onTabKeyDown}
              onClick={() => setSection(item.id)}
            >
              <Icon size={13} /> {item.label}
            </button>
          );
        })}
      </div>
      <div id="help-tabpanel" role="tabpanel" aria-labelledby={`help-tab-${section}`}>
        {section === 'summary' ? <Summary /> : section === 'modes' ? <ModeGuide /> : (
          <div className="help-content-grid">
            <section className="help-hero-card">
              <div className="help-kicker">Sayfa rehberi</div>
              <h2>{page.title}</h2>
              <p>{page.intro}</p>
            </section>
            <section className="card help-section-card">
              <h3>Nasıl kullanılır?</h3>
              <div className="help-checks">
                {page.points.map((point, index) => <div key={point}><span>{index + 1}</span><p>{point}</p></div>)}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
