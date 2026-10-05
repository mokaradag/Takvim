import 'server-only';
import { ServerPersistenceError } from '../../errors.js';

/**
 * Konuşma başına TEK etkin yanıt üretimi (süreç içi).
 *
 * Aynı konuşmada ikinci bir tur, süren üretim bitmeden (ya da durdurulmadan)
 * başlatılamaz: iki denetimsiz üretim aynı geçmişe karşı yarışmaz. Farklı
 * konuşmalar ve farklı kullanıcılar Phase 1 kapasite sınırları içinde birlikte
 * yürür.
 *
 * AYNI turun yeniden gönderimi istisnadır: istemci o turu terk ettiğini
 * (bağlantı koptu, süre doldu) yeniden isteyerek gösterir. Terk edilen üretim
 * durdurulur ve hak yeni isteğe geçer; böylece yanıtı görülemeyen bir tur
 * konuşmayı süresiz kilitlemez. Tekillik korunur: her an tek üretim etkindir ve
 * yanıt satırı zaten tur başına tekil yazılır.
 *
 * Anahtarlar Sicil içerir: başka bir kullanıcının konuşma kimliğini bilen
 * çağıran, o konuşmada üretim sürüp sürmediğini (ve konuşmanın varlığını) bu
 * kayıttan öğrenemez. Her kaydın kendi iptal sinyali vardır; konuşma silinirken
 * süren üretimi durdurmak için kullanılır.
 *
 * Dağıtım şartı: aynı konuşma veritabanının tüm AI uçları tek Node.js
 * sürecine gider (docs/AI-PLATFORM.md §18.14). Tur tekilliği süreçler arası
 * üretim kilidi değildir; çok örnekli AI dağıtımı desteklenmez.
 */

const STATE_KEY = Symbol.for('mergen-rota.ai-assistant-generations');

function registry() {
  globalThis[STATE_KEY] ||= new Map();
  return globalThis[STATE_KEY];
}

const conversationKey = (sicil, conversationId) => `${sicil}:conversation:${conversationId}`;
const turnKey = (sicil, turnId) => `${sicil}:turn:${turnId}`;

function generationInProgress() {
  return new ServerPersistenceError(
    'CONFLICT',
    'Bu konuşmada bir yanıt hâlâ üretiliyor. Önce yanıtı durdurun ya da tamamlanmasını bekleyin.',
    { details: { reason: 'GENERATION_IN_PROGRESS' } }
  );
}

/** Aynı turun terk edilmiş üretimi: durdurulur ve bütün anahtarları bırakılır. */
function releaseAbandoned(current, key, turnId) {
  const owner = current.get(key);
  if (!owner || owner.turnId !== turnId) return;
  owner.controller.abort();
  for (const ownerKey of owner.keys) {
    if (current.get(ownerKey) === owner) current.delete(ownerKey);
  }
}

/**
 * Üretim hakkını alır. Yeni konuşmanın ilk turu henüz konuşma kimliği
 * taşımadığı için tur kimliğiyle alınır; konuşma açılınca `bindConversation`
 * ile konuşmaya da bağlanır. Hak her yolda `release()` ile bırakılmalıdır.
 */
export function claimAssistantGeneration({ sicil, conversationId = null, turnId }) {
  const current = registry();
  const firstKey = conversationId ? conversationKey(sicil, conversationId) : turnKey(sicil, turnId);
  releaseAbandoned(current, firstKey, turnId);
  if (current.has(firstKey)) throw generationInProgress();
  const controller = new AbortController();
  const entry = { controller, turnId, keys: [firstKey] };
  current.set(firstKey, entry);
  return {
    signal: controller.signal,
    bindConversation(id) {
      const key = conversationKey(sicil, id);
      if (current.get(key) === entry) return;
      releaseAbandoned(current, key, turnId);
      if (current.has(key)) throw generationInProgress();
      current.set(key, entry);
      entry.keys.push(key);
    },
    release() {
      for (const key of entry.keys) {
        if (current.get(key) === entry) current.delete(key);
      }
    }
  };
}

/** Sicil'in bu konuşmadaki süren üretimini durdurur (konuşma silinirken). */
export function abortAssistantGeneration({ sicil, conversationId }) {
  registry().get(conversationKey(sicil, conversationId))?.controller.abort();
}

/** Yalnızca testler: etkin üretim anahtarlarının sayısı. */
export function activeAssistantGenerationCountForTests() {
  return new Set(registry().values()).size;
}

export function resetAssistantGenerationsForTests() {
  globalThis[STATE_KEY] = new Map();
}
