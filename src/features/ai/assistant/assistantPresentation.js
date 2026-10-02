import { AI_CREDENTIAL_SOURCES } from '../../../domain/ai/aiCredentialPolicy.js';
import { AI_ERROR_CODES, aiErrorMessage, isAiErrorCode } from '../../../domain/ai/aiErrorCatalog.js';
import { ASSISTANT_STREAM_PHASES } from '../../../domain/ai/assistantContract.js';
import { EVIDENCE_KINDS, GROUNDING_FAILED_FINISH_REASON } from '../../../domain/ai/evidenceContract.js';

/**
 * Rota AI'nin saf sunum kuralları: hata ve durum metinleri, tonları, yeniden
 * deneme ve yönlendirme önerileri. Bileşen yalnızca çizer; kurallar tarayıcı
 * olmadan sınanır.
 *
 * Ton sözlüğü: `muted` (kullanıcının kendi kararı, ör. Durdur), `warn` (geçici
 * yoğunluk ya da yapılandırma eksiği; sistem arızası değil), `fail` (gerçek
 * hata). Yığın izi, sağlayıcı gövdesi, adres ya da anahtar hiçbir metinde yoktur.
 */

const GENERIC_FAILURE = 'Yanıt alınamadı. Yeniden deneyebilirsiniz.';

const CLIENT_FAILURES = Object.freeze({
  REQUEST_CANCELLED: { tone: 'muted', title: 'Yanıt durduruldu', message: 'Yanıtı durdurdunuz. İsterseniz yeniden deneyebilirsiniz.' },
  REQUEST_TIMEOUT: { tone: 'fail', title: 'Sunucu yanıt vermedi', message: 'Sunucudan süre sınırında yanıt alınamadı.' },
  NETWORK: { tone: 'fail', title: 'Bağlantı sorunu', message: 'Sunucuyla bağlantı kurulamadı ya da kesildi. Bağlantınızı denetleyip yeniden deneyin.' },
  STREAM_STALLED: { tone: 'fail', title: 'Bağlantı yanıt vermiyor', message: 'Sunucudan uzun süredir veri gelmedi; bağlantı kesilmiş olabilir.' },
  STREAM_INTERRUPTED: { tone: 'fail', title: 'Yanıt yarıda kesildi', message: 'Yanıt tamamlanmadan bağlantı kesildi. Yanıt kaydedilmedi; yeniden deneyebilirsiniz.' },
  PROTOCOL_ERROR: { tone: 'fail', title: 'Beklenmeyen yanıt', message: 'Sunucudan beklenmeyen bir yanıt alındı. Yeniden deneyin.' },
  INVALID_RESPONSE: { tone: 'fail', title: 'Beklenmeyen yanıt', message: 'Sunucudan beklenmeyen bir yanıt alındı. Yeniden deneyin.' }
});

const SERVER_CANCELLED = Object.freeze({
  tone: 'muted',
  title: 'Yanıt durduruldu',
  message: 'Yanıt sunucuda durduruldu ve kaydedilmedi. Konuşma başka bir pencerede silinmiş olabilir.'
});

const SESSION_CODES = new Set(['UNAUTHORIZED', 'SESSION_REQUIRED']);

function serverMessage(result, fallback) {
  const message = typeof result?.message === 'string' ? result.message.trim() : '';
  return message || fallback;
}

/**
 * Tur ya da istek sonucunun kullanıcıya dönük görünümü:
 * `{ tone, title, message, retryable, action }`; `action` önerilen yönlendirmedir
 * (`settings`, `new-conversation`, `reload`).
 */
export function assistantFailureView(result, now = Date.now()) {
  const code = String(result?.code ?? '');
  // Sunucuda durdurulan üretim (ör. konuşma başka pencerede silindi) kullanıcının Durdur'u değildir.
  if (code === AI_ERROR_CODES.AI_CANCELLED) return { ...SERVER_CANCELLED, retryable: true, action: null };
  if (Object.hasOwn(CLIENT_FAILURES, code)) return { ...CLIENT_FAILURES[code], retryable: true, action: null };
  if (SESSION_CODES.has(code)) {
    return {
      tone: 'fail',
      title: 'Oturum doğrulanamadı',
      message: 'Oturumunuz sona ermiş olabilir. Sayfayı yenileyip yeniden oturum açın.',
      retryable: false,
      action: 'reload'
    };
  }
  switch (code) {
    case AI_ERROR_CODES.AI_BUSY:
    case AI_ERROR_CODES.AI_QUEUE_TIMEOUT:
      return {
        tone: 'warn',
        title: 'Rota AI şu anda yoğun',
        message: 'Çok sayıda istek aynı anda işleniyor. Birkaç saniye sonra yeniden deneyin.',
        retryable: true,
        action: null
      };
    case AI_ERROR_CODES.AI_RATE_LIMITED:
      return {
        retryAt: now + (Number.isFinite(result?.retryAfterMs) ? Math.max(0, result.retryAfterMs) : 0),
        tone: 'warn',
        title: 'İstek sınırına ulaşıldı',
        message: serverMessage(result, aiErrorMessage(code)),
        retryable: true,
        action: null
      };
    case AI_ERROR_CODES.AI_KEY_MISSING:
      return {
        tone: 'warn',
        title: 'API anahtarı gerekli',
        message: 'Rota AI için kullanılabilir bir API anahtarı yok. Ayarlar → Yapay zekâ erişimi bölümünden kişisel anahtarınızı ekleyebilirsiniz.',
        retryable: false,
        credential: true,
        action: 'settings'
      };
    case AI_ERROR_CODES.AI_KEY_INVALID:
    case AI_ERROR_CODES.AI_UNAUTHORIZED:
      return {
        tone: 'fail',
        title: result?.credentialSource === AI_CREDENTIAL_SOURCES.DEFAULT ? 'Kurumsal anahtar kabul edilmedi' : 'Kişisel anahtar kabul edilmedi',
        message: serverMessage(result, aiErrorMessage(code)),
        retryable: false,
        // Anahtar düzeltilince (hazırlık yeniden kullanılabilir olunca) tur yeniden denenebilir olur.
        credential: true,
        action: result?.credentialSource === AI_CREDENTIAL_SOURCES.DEFAULT ? null : 'settings'
      };
    case AI_ERROR_CODES.AI_TIMEOUT:
      return {
        tone: 'fail',
        title: 'Yanıt süre sınırında tamamlanmadı',
        message: result?.partial
          ? 'Yanıt süre sınırı dolduğu için yarıda kesildi ve kaydedilmedi.'
          : 'Yapay zekâ hizmeti süre sınırında yanıt vermedi.',
        retryable: true,
        action: null
      };
    case AI_ERROR_CODES.AI_PROVIDER_UNAVAILABLE:
      return result?.partial
        ? { ...CLIENT_FAILURES.STREAM_INTERRUPTED, retryable: true, action: null }
        : { tone: 'fail', title: 'Hizmete ulaşılamıyor', message: aiErrorMessage(code), retryable: true, action: null };
    case AI_ERROR_CODES.AI_PROVIDER_RESPONSE_INVALID:
      return {
        tone: 'fail',
        title: 'Yanıt üretilemedi',
        message: result?.reason === 'EMPTY_COMPLETION'
          ? 'Model görünür bir yanıt üretmeden durdu. Soruyu daraltıp yeniden deneyin.'
          : 'Yapay zekâ hizmetinden geçersiz bir yanıt alındı.',
        // Katalog bu kodu yinelenemez sayar; sunucunun sınıflandırması korunur.
        retryable: result?.retryable === true,
        action: 'new-conversation'
      };
    case AI_ERROR_CODES.AI_REQUEST_INVALID:
      return {
        tone: 'fail',
        title: 'İstek kabul edilmedi',
        message: result?.phase === 'stream'
          ? 'Yapay zekâ hizmeti isteği reddetti. Konuşma çok uzunsa yeni bir konuşma başlatmayı deneyin.'
          : serverMessage(result, aiErrorMessage(code)),
        retryable: false,
        action: result?.phase === 'stream' ? 'new-conversation' : null
      };
    case AI_ERROR_CODES.AI_DISABLED:
    case AI_ERROR_CODES.AI_CONFIGURATION_ERROR:
      return { tone: 'warn', title: 'Rota AI kullanılamıyor', message: serverMessage(result, aiErrorMessage(code)), retryable: false, action: null };
    case 'CONFLICT':
      return {
        tone: 'warn',
        title: result?.reason === 'CONVERSATION_FULL' ? 'Konuşma çok uzadı' : 'İşlem şu anda yapılamıyor',
        message: result?.reason === 'GENERATION_IN_PROGRESS'
          ? 'Bu konuşmada başka bir pencerede yanıt üretiliyor. Tamamlanmasını bekleyip yeniden deneyin.'
          : serverMessage(result, 'İşlem şu anda yapılamıyor.'),
        retryable: result?.reason === 'GENERATION_IN_PROGRESS',
        action: result?.reason === 'CONVERSATION_STALE' ? 'refresh-conversation' : ['CONVERSATION_FULL', 'TURN_UNANSWERED'].includes(result?.reason) ? 'new-conversation' : null
      };
    case 'NOT_FOUND':
      return {
        tone: 'fail',
        title: 'Konuşma bulunamadı',
        message: 'Konuşma bulunamadı; silinmiş olabilir.',
        retryable: false,
        action: 'new-conversation'
      };
    case 'DATABASE_UNAVAILABLE':
      return { tone: 'fail', title: 'Konuşma geçmişine ulaşılamadı', message: serverMessage(result, GENERIC_FAILURE), retryable: true, action: null };
    default:
      return {
        tone: 'fail',
        title: 'Yanıt alınamadı',
        message: isAiErrorCode(code) ? aiErrorMessage(code) : serverMessage(result, GENERIC_FAILURE),
        retryable: result?.retryable === true,
        action: null
      };
  }
}

/** Oturum düzeyinde (tur dışı) hata mı? Öyleyse panel güncel oturumu yeniden istemelidir. */
export function isSessionFailure(result) {
  return SESSION_CODES.has(String(result?.code ?? ''));
}

const READINESS_MESSAGES = Object.freeze({
  AI_DISABLED: { tone: 'muted', title: 'Rota AI kapalı', message: 'Yapay zekâ özellikleri bu kurulumda kapalı.', action: null },
  AI_CONFIGURATION_ERROR: {
    tone: 'warn',
    title: 'Rota AI yapılandırılmadı',
    message: 'Yapay zekâ hizmeti henüz yapılandırılmadı ya da yapılandırması eksik. Sistem yöneticinize başvurun.',
    action: null
  },
  AI_KEY_MISSING: {
    tone: 'warn',
    title: 'API anahtarı gerekli',
    message: 'Rota AI için kullanılabilir bir API anahtarı yok. Ayarlar → Yapay zekâ erişimi bölümünden kişisel anahtarınızı ekleyebilirsiniz.',
    action: 'settings'
  },
  AI_KEY_UNREADABLE: {
    tone: 'warn',
    title: 'Kişisel anahtar okunamıyor',
    message: 'Kayıtlı kişisel anahtarınız okunamıyor. Ayarlar → Yapay zekâ erişimi bölümünden anahtarı yeniden kaydedin.',
    action: 'settings'
  },
  PROFILE_UNAVAILABLE: {
    tone: 'warn',
    title: 'Rota AI kullanılamıyor',
    message: 'Sohbet yeteneği bu kurulumda yapılandırılmamış. Sistem yöneticinize başvurun.',
    action: null
  }
});

/** Kullanılamayan hazırlık durumunun açıklaması; kullanılabilirse `null`. */
export function readinessNotice(readiness) {
  if (!readiness || readiness.available) return null;
  return READINESS_MESSAGES[readiness.reason] || READINESS_MESSAGES.AI_CONFIGURATION_ERROR;
}

/** Demo Kipinde gösterilen açıklama; hiçbir istek gönderilmez. */
export const DEMO_NOTICE = Object.freeze({
  tone: 'muted',
  title: 'Rota AI Gerçek Sistem\'de kullanılabilir',
  message: 'Demo Kipinde yapay zekâ isteği gönderilmez ve konuşma kaydedilmez. Rota AI, kurumsal oturumla Gerçek Sistem verisinde çalışır.'
});

/** Rota verisi okunurken gösterilen konu metni; araç adı ya da bağımsız değişken gösterilmez. */
const TOOL_TOPIC_LABELS = Object.freeze({
  tasks: 'Görevler inceleniyor…',
  projects: 'Proje bilgileri okunuyor…',
  portfolio: 'Portföy özeti hazırlanıyor…',
  wbs: 'İş dağılım yapısı inceleniyor…',
  workload: 'İş yükü dağılımı hesaplanıyor…',
  people: 'Personel aranıyor…',
  activity: 'Hareket geçmişi okunuyor…',
  requests: 'Talepler inceleniyor…',
  notifications: 'Bildirimler okunuyor…',
  baseline: 'Baz plan karşılaştırılıyor…',
  dependencies: 'Bağımlılıklar inceleniyor…',
  recurrence: 'Tekrar serileri inceleniyor…',
  calendar: 'Çalışma takvimi okunuyor…',
  outlook: 'Outlook durumu okunuyor…',
  quality: 'Plan veri kalitesi denetleniyor…'
});

/** Üretim evresinin kısa metni; metin akmaya başlayınca gösterilmez. */
export function generationPhaseLabel(phase, topic = null) {
  switch (phase) {
    case 'sending':
      return 'Gönderiliyor…';
    case 'accepted':
      return 'Hazırlanıyor…';
    case ASSISTANT_STREAM_PHASES.THINKING:
      return 'Derin düşünülüyor…';
    // Akıl yürütme yalnızca sağlayıcı bildirdiğinde (`thinking`) gösterilir; kip bunu uydurmaz.
    case ASSISTANT_STREAM_PHASES.GENERATING:
      return 'Yanıt oluşturuluyor…';
    case ASSISTANT_STREAM_PHASES.TOOLS:
      return TOOL_TOPIC_LABELS[topic] || 'Rota verisi okunuyor…';
    case ASSISTANT_STREAM_PHASES.VERIFYING:
      return 'Yanıt kaynaklarla doğrulanıyor…';
    default:
      return null;
  }
}

/* ── Kanıtlar ────────────────────────────────────────────────── */

/** "3 Rota kaynağı" gibi kısa özet; kanıt yoksa `null`. */
export function evidenceSummaryLabel(evidence) {
  const count = Array.isArray(evidence) ? evidence.length : 0;
  if (!count) return null;
  return `${count} Rota kaynağı`;
}

export function evidenceKindLabel(kind) {
  return EVIDENCE_KINDS[kind] || 'Rota kaynağı';
}

/** Kanıtın veri zamanı (Türkiye saati): "Veri zamanı: 29 Eyl 2026 11:12". */
export function evidenceTimeLabel(generatedAt) {
  const at = generatedAt ? new Date(generatedAt) : null;
  if (!at || Number.isNaN(at.getTime())) return null;
  const text = at.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `Veri zamanı: ${text}`;
}

/** Kanıtın kapsam ve tamlık notları (kısmi erişim, kısaltma). */
export function evidenceNotes(item) {
  const notes = [];
  if (item?.partial) notes.push('Yalnızca yetkili kayıtlar');
  if (item?.truncated) notes.push('Kısaltılmış sonuç');
  if (item?.counts?.total != null && item?.counts?.returned != null && item.counts.total > item.counts.returned) {
    notes.push(`${item.counts.returned} / ${item.counts.total} kayıt gösterildi`);
  }
  return notes;
}

/** Yanıt kanıtla doğrulanamadığında sunucunun kaydettiği güvenli ileti mi? */
export function isGroundingFailure(finishReason) {
  return finishReason === GROUNDING_FAILED_FINISH_REASON;
}

/** Olağan bitiş nedenleri; bunların dışındaki her neden yanıtın eksik olabileceğini söyler. */
const COMPLETE_FINISH_REASONS = new Set(['stop', 'end_turn', 'eos', 'stop_sequence']);

/** Yanıtın bitiş nedeni kullanıcıya not olarak gösterilmeli mi? */
export function finishReasonNote(finishReason) {
  if (!finishReason || COMPLETE_FINISH_REASONS.has(finishReason) || ['not_found', 'clarification', 'unavailable', 'general'].includes(finishReason)) return null;
  if (finishReason === GROUNDING_FAILED_FINISH_REASON) return 'Yanıt Rota verisiyle doğrulanamadığı için gösterilmedi; soruyu daha dar kapsamda yeniden sorabilirsiniz.';
  if (finishReason === 'length') return 'Yanıt uzunluk sınırına ulaştığı için sonu eksik olabilir.';
  if (finishReason === 'content_filter') return 'Yanıt içerik süzgeci nedeniyle durduruldu; sonu eksik olabilir.';
  return 'Yanıt olağan dışı bir nedenle sonlandı; sonu eksik olabilir.';
}

/** Konuşma listesi için göreli zaman ("şimdi", "5 dk önce", "dün", tarih). */
export function relativeTimeLabel(value, now = Date.now()) {
  const at = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(at)) return '';
  const minutes = Math.floor(Math.max(0, now - at) / 60000);
  if (minutes < 1) return 'şimdi';
  if (minutes < 60) return `${minutes} dk önce`;
  const hours = Math.floor(minutes / 60);
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  if (sameDay) return `${hours} sa önce`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (new Date(at).toDateString() === yesterday.toDateString()) return 'dün';
  return new Date(at).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', ...(new Date(at).getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }) });
}

/** Sayaç metni: sınıra yaklaşınca görünür. */
export function characterCountLabel(length, max) {
  if (length < max * 0.8) return null;
  return `${length.toLocaleString('tr-TR')} / ${max.toLocaleString('tr-TR')}`;
}
