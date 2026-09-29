import 'server-only';

/**
 * Rota AI alan araçlarının SABİT sınırları.
 *
 * Model yalnızca kayıtlı bir aracı seçebilir; ne kadar çalışacağını seçemez.
 * Döngü, eşzamanlılık, süre ve boyut sınırlarının tamamı sunucudadır ve bir
 * tur bu sınırları hangi yolla aşarsa aşsın güvenli bir araç hatasına ya da
 * son (araçsız) yanıt turuna düşer.
 */
export const TOOL_LIMITS = Object.freeze({
  /** Araç çağırabilen model turu. Sonrasında model yalnızca eldeki kanıtla yanıtlar. */
  maxToolRounds: 4,
  /** Tek model yanıtındaki en fazla yürütülen çağrı; fazlası yürütülmeden reddedilir. */
  maxCallsPerRound: 5,
  /** Tek turdaki en fazla yürütülen çağrı. */
  maxTotalCalls: 12,
  /** Aynı turda aynı anda yürütülen çağrı (her biri ayrıca SQL kapısından geçer). */
  roundConcurrency: 2,
  /** Tek çağrının varsayılan süre sınırı (kapı beklemesi ve sorgu dâhil). */
  callTimeoutMs: 8000,
  /** Tur boyunca araç SQL'inde geçirilebilecek toplam süre. */
  maxCumulativeSqlMs: 25000,
  /** Araç evresinin duvar saati sınırı (turun ilk aracından itibaren). */
  maxToolPhaseMs: 45000,
  /** Modele verilen tek araç sonucunun en büyük boyutu (UTF-8 bayt). */
  maxResultBytes: 16 * 1024,
  /** Tur boyunca modele verilen araç sonuçlarının toplam boyutu. */
  maxTotalResultBytes: 96 * 1024,
  /** Bağımsız değişken metninin en büyük boyutu (çözümlemeden önce). */
  maxArgumentBytes: 8 * 1024,
  /** Kanıta dayanan yanıtın tek düzeltme turu. */
  maxRepairRounds: 1,
  /** Görev kümesi analizinde sunucuya okunabilecek en fazla yetkili görev satırı. */
  maxAnalyzedTasks: 20000,
  /** Liste araçlarının en fazla sayfa ötelemesi (imleç). */
  maxCursorOffset: 1000
});

/**
 * Araç SQL kapısı: ortak havuzu yapay zekâ turları tüketemez. Dört eşzamanlı
 * kapıdan (rehber 2, anahtar 2, konuşma 4) sonra araç işleri için yalnızca iki
 * bağlantı ayrılır; tek bir Sicil aynı anda bir araç sorgusu çalıştırır.
 */
export const TOOL_SQL_GATE = Object.freeze({
  slots: 2,
  queue: 32,
  perUserActive: 1,
  perUserQueued: 6
});
