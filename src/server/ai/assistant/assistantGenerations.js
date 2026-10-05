import 'server-only';
import { ServerPersistenceError } from '../../errors.js';
import { raceWithAbort } from '../aiDeadline.js';

/**
 * Konuşma başına TEK etkin yanıt üretimi (süreç içi).
 *
 * Aynı konuşmada ikinci bir tur, süren üretim bitmeden (ya da durdurulmadan)
 * başlatılamaz: iki denetimsiz üretim aynı geçmişe karşı yarışmaz. Farklı
 * konuşmalar ve farklı kullanıcılar Phase 1 kapasite sınırları içinde birlikte
 * yürür.
 *
 * Aynı turun geçerli yeniden gönderimi etkin üretimin ve yazımın bitmesini
 * bekler. Yeniden gönderim tek başına iptal yetkisi vermez.
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

/**
 * Üretim hakkını alır. Yeni konuşmanın ilk turu henüz konuşma kimliği
 * taşımadığı için tur kimliğiyle alınır; konuşma açılınca `bindConversation`
 * ile konuşmaya da bağlanır. Hak her yolda `release()` ile bırakılmalıdır.
 */
export async function claimAssistantGeneration({ sicil, conversationId = null, turnId, content = null, signal }) {
  const current = registry();
  const keys = [turnKey(sicil, turnId), ...(conversationId ? [conversationKey(sicil, conversationId)] : [])];
  for (;;) {
    const owner = keys.map((key) => current.get(key)).find(Boolean);
    if (!owner) break;
    if (owner.turnId !== turnId) throw generationInProgress();
    if ((content != null && content !== owner.content) || (conversationId && owner.conversationId && conversationId !== owner.conversationId)) throw new ServerPersistenceError('CONFLICT',
      'Bu ileti kimliği farklı bir içerikle kullanılmış. Sayfayı yenileyip yeniden gönderin.', { details: { reason: 'TURN_ID_REUSED' } });
    await raceWithAbort(() => owner.finished, signal);
    if (!conversationId && owner.conversationId) {
      conversationId = owner.conversationId;
      keys.push(conversationKey(sicil, conversationId));
    }
  }
  if (signal.aborted) throw signal.reason;
  const controller = new AbortController();
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  const entry = { controller, turnId, content, conversationId, keys, finished };
  for (const key of keys) current.set(key, entry);
  return {
    conversationId,
    signal: controller.signal,
    bindConversation(id) {
      entry.conversationId = id;
      const key = conversationKey(sicil, id);
      if (current.get(key) === entry) return;
      if (current.has(key)) throw generationInProgress();
      current.set(key, entry);
      entry.keys.push(key);
    },
    release() {
      for (const key of entry.keys) {
        if (current.get(key) === entry) current.delete(key);
      }
      finish();
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
