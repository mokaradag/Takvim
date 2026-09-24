import 'server-only';

/**
 * Varsayılan model kaydı — kurum içi model dizisinin başlangıç eşlemesi.
 *
 * Bu dosya VERİDİR. Model dizisi değiştiğinde iş kodu değişmez: kurulum,
 * aynı biçimdeki bir JSON belgesini `MERGEN_ROTA_AI_MODEL_REGISTRY_PATH` ile
 * gösterip bu eşlemenin tamamını değiştirebilir (bkz. docs/AI-PLATFORM.md).
 * Bağlam sınırları dağıtımdaki sunum ayarına bağlıdır; bilinmedikçe `null`
 * bırakılır.
 */

const model = (id, capabilities) => ({ id, provider: 'onprem', capabilities, contextTokens: null, maxConcurrency: null, enabled: true });

export const DEFAULT_AI_MODEL_REGISTRY = Object.freeze({
  version: 1,
  models: [
    model('Qwen3-30B-A3B-Instruct-2507', ['chat', 'tools']),
    model('Qwen3-Next-80B-A3B-Instruct', ['chat', 'tools']),
    model('Qwen3-Coder-30B-A3B-Instruct', ['chat', 'tools']),
    model('Qwen3.6-35B-A3B', ['chat', 'tools']),
    model('Qwen3.8-27B', ['chat', 'tools']),
    model('Qwen3.5-397B-A17B-FP8', ['chat', 'tools', 'reasoning']),
    model('DeepSeek-V4-Flash-0731', ['chat', 'tools', 'reasoning']),
    model('openai/gpt-oss-120b', ['chat', 'tools', 'reasoning']),
    model('gemma-4-31B-it', ['chat']),
    model('Qwen2.5-VL-7B-Instruct', ['chat', 'vision']),
    model('Qwen3-VL-8B-Instruct', ['chat', 'vision']),
    model('Qwen3-VL-30B-A3B-Instruct', ['chat', 'vision']),
    model('intfloat/multilingual-e5-large', ['embedding']),
    model('Qwen3-Embedding-8B', ['embedding']),
    model('bge-reranker-v2-m3', ['rerank']),
    model('Qwen3-Reranker-8B', ['rerank']),
    model('whisper-large-v3', ['speech.stt']),
    model('tts-1', ['speech.tts']),
    model('tts-1-hd', ['speech.tts']),
    model('VoxCPM2', ['speech.tts']),
    model('dall-e-3', ['image.generation'])
  ],
  profiles: {
    'chat.fast': { model: 'Qwen3-30B-A3B-Instruct-2507', maxOutputTokens: 512 },
    'chat.general': { model: 'Qwen3-Next-80B-A3B-Instruct', maxOutputTokens: 1024 },
    'chat.reasoning': { model: 'openai/gpt-oss-120b', maxOutputTokens: 2048, timeoutMs: 180000 },
    'chat.tools': { model: 'Qwen3-Next-80B-A3B-Instruct', maxOutputTokens: 1024 },
    vision: { model: 'Qwen3-VL-30B-A3B-Instruct', maxOutputTokens: 1024 },
    embedding: { model: 'intfloat/multilingual-e5-large' },
    rerank: { model: 'bge-reranker-v2-m3' },
    'speech.stt': { model: 'whisper-large-v3' },
    'speech.tts.fast': { model: 'tts-1' },
    'speech.tts.quality': { model: 'tts-1-hd' },
    'image.generation': { model: 'dall-e-3' }
  }
});
