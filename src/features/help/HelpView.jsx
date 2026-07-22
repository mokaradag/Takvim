'use client';
import { useState } from 'react';
import { Icons } from '../../components/icons';

const SECTIONS = [
  { id: 'summary', label: 'Başlangıç', icon: 'Dashboard' },
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
    points: ['Görev, gecikme ve ilerleme göstergelerini izleyin.', 'Grafiklerdeki eğilimleri ayrıntılı sayfalara geçmeden önce kontrol edin.', 'Bir gösterge beklenmedik görünüyorsa önce üstteki aktif proje bilgisini doğrulayın.']
  },
  veri: {
    title: 'Görevler',
    intro: 'Görevlerin ayrıntılı listesidir. Yeni görev oluşturma, filtreleme, sıralama ve görev ayrıntılarını düzenleme işlemleri burada yapılır.',
    points: ['Yeni görev düğmesi seçili proje altında yeni kayıt oluşturur.', 'Sütun başlıklarındaki filtreler birden çok koşulu birlikte kullanabilir.', 'Göreve tıklayarak tarihleri, etiketi, sorumluları ve ilişkileri düzenleyin.', 'Tatil veya hafta sonuna denk gelen plan tarihleri görev ayrıntısında uyarı olarak gösterilir.']
  },
  wbs: {
    title: 'Proje Yapısı',
    intro: 'Projelerin oluşturulduğu, temel bilgilerinin ve kullanılabilir etiketlerin yönetildiği, iş dağılım ağacının düzenlendiği ana tanım alanıdır.',
    points: ['Yeni Proje ile proje kaydı oluşturun; yeni proje otomatik olarak aktif çalışma alanı olur.', 'Proje Tanımı bölümünde ad, sorumlu, veri tarihi, renk ve etiketleri yönetin.', 'Etiketler görevlerde seçilebilir değerler olarak kullanılır.', 'İş Dağılım Ağacı sekmesinde WBS düğümlerini ekleyin, yeniden adlandırın ve hiyerarşiyi düzenleyin.']
  },
  takvim: {
    title: 'Takvim',
    intro: 'Görevleri aylık takvim üzerinde görsel olarak izlemek için kullanılır. Hafta sonları ve resmi tatiller çalışma takvimine göre ayırt edilir.',
    points: ['Ay ve yıl seçerek dönemler arasında ilerleyin.', 'Görev kartına tıklayarak ayrıntı panelini açın.', 'Planlama yaparken çalışma günü dışı uyarılarını dikkate alın.']
  },
  gantt: {
    title: 'Gantt',
    intro: 'Zaman çizelgesini, WBS yapısını, sorumluları, bağımlılıkları ve kritik yolu birlikte incelemek için kullanılır.',
    points: ['Tarih aralığını elle seçebilir veya Otomatik seçeneğiyle görevlerin kapsadığı döneme dönebilirsiniz.', 'Proje görünümünde WBS ile Sorumlu / Kritik Yol görünümleri arasında geçiş yapın.', 'FS, SS, FF ve SF ilişkileri ile pozitif gecikme (lag) veya negatif öne çekme (lead) tanımlanabilir.', 'Sütun filtreleri açıldığında pencere Gantt zaman hücrelerinin üzerinde kalır.']
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
    intro: 'Ekip üyelerinin görev dağılımını ve iş yükünü incelemek için kullanılır.',
    points: ['Proje çalışma alanında yalnızca ilgili kişiler ve görevler gösterilir.', 'İş yükü dengesini raporlarla birlikte değerlendirin.', 'Görev sorumlularını görev ayrıntı panelinden güncelleyin.']
  },
  ayarlar: {
    title: 'Ayarlar',
    intro: 'Tema, vurgu rengi, yoğunluk, yazı boyutu ve hareket tercihlerini yönetir. Bu sayfa proje seçiminden bağımsızdır.',
    points: ['Açık ve koyu temalarda başlık alanları vurgu rengiyle ayırt edilir.', 'Yazı boyutunu büyüttüğünüzde kenar çubuğu alt alanı görünür kalır.', 'Hareketi azalt seçeneği açıkken grafik ve arayüz animasyonları sınırlandırılır.']
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

function Summary() {
  return (
    <div className="help-content-grid">
      <section className="help-hero-card">
        <div className="help-kicker">MERGEN Rota · Sürüm 1.0</div>
        <h2>Proje yönetimine hızlı başlangıç</h2>
        <p>Uygulamanın temel çalışma sırası; önce proje yapısını tanımlamak, sonra görevleri ve ilişkileri oluşturmak, ardından planı Gantt ve Takvim üzerinde izleyerek ilerlemeyi Kanban ve Raporlar üzerinden yönetmektir.</p>
      </section>
      <section className="card help-section-card">
        <h3>Temel kurulum akışı</h3>
        <Flow steps={[
          { title: 'Proje oluştur', text: 'Proje Yapısı sayfasında temel bilgileri girin.' },
          { title: 'Etiket ve WBS', text: 'Etiketleri tanımlayın, iş dağılım ağacını kurun.' },
          { title: 'Görevleri girin', text: 'Tarih, sorumlu ve etiket bilgilerini tamamlayın.' },
          { title: 'İlişkileri kurun', text: 'FS/SS/FF/SF ve lead/lag değerlerini tanımlayın.' },
          { title: 'Planı izleyin', text: 'Gantt, Takvim ve Raporlar ile kontrol edin.' }
        ]} />
      </section>
      <section className="card help-section-card">
        <h3>Günlük kullanım akışı</h3>
        <Flow steps={[
          { title: 'Aktif projeyi seç', text: 'Kenar çubuğundaki çalışma alanını doğrulayın.' },
          { title: 'Görevleri güncelle', text: 'Gerçekleşen tarih, ilerleme ve kalan süreyi girin.' },
          { title: 'Plan etkisini gör', text: 'Gantt üzerinde kritik yol ve bağımlılıkları inceleyin.' },
          { title: 'Raporla', text: 'Raporları inceleyin veya Excel/CSV dışa aktarın.' }
        ]} />
      </section>
      <section className="help-tip-grid">
        <div><Icons.Layers size={18} /><strong>Tanımların merkezi</strong><span>Proje, etiket ve WBS yönetimi Proje Yapısı sayfasındadır.</span></div>
        <div><Icons.Calendar size={18} /><strong>Çalışma takvimi</strong><span>Hafta sonu ve resmi tatil tarihleri planlama sırasında uyarılır.</span></div>
        <div><Icons.Gantt size={18} /><strong>Plan denetimi</strong><span>Lead/lag ve kritik yol etkisini Gantt üzerinden izleyin.</span></div>
      </section>
    </div>
  );
}

export function HelpView() {
  const [section, setSection] = useState('summary');
  const page = CONTENT[section];

  return (
    <div className="help-shell">
      <div className="help-page-switch" role="tablist" aria-label="Kullanım rehberi bölümleri">
        {SECTIONS.map((item) => {
          const Icon = Icons[item.icon];
          return (
            <button key={item.id} type="button" className={section === item.id ? 'active' : ''} onClick={() => setSection(item.id)}>
              <Icon size={13} /> {item.label}
            </button>
          );
        })}
      </div>
      {section === 'summary' ? <Summary /> : (
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
  );
}
