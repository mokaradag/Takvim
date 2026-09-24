import 'server-only';

/**
 * Varsayılan model kaydı — kurum içi model dizisinin başlangıç eşlemesi.
 *
 * Bu dosya VERİDİR ve `config/ai-model-registry.onprem.json` içindeki güncel
 * kurum içi katalogla aynı profil tercihlerini taşır. Model dizisi değiştiğinde
 * iş kodu değişmez; kurulum `MERGEN_ROTA_AI_MODEL_REGISTRY_PATH` ile dış JSON
 * kaydını gösterebilir (bkz. docs/AI-PLATFORM.md).
 */

const model = (id, capabilities, contextTokens = null) => ({
  id,
  provider: 'onprem',
  capabilities,
  contextTokens,
  maxConcurrency: null,
  enabled: true
});

export const DEFAULT_AI_MODEL_REGISTRY = Object.freeze({
  version: 1,
  models: [
    model('VoxCPM2', ['speech.tts']),
    model('DeepSeek-V4-Flash-0731', ['chat', 'tools', 'reasoning'], 1048576),
    model('Qwen3.8-27B', ['chat', 'tools', 'reasoning', 'vision'], 262144),
    model('intfloat/multilingual-e5-large', ['embedding']),
    model('tts-1-hd', ['speech.tts']),
    model('dall-e-3', ['image.generation']),
    model('whisper-large-v3', ['speech.stt']),
    model('openai/gpt-oss-120b', ['chat', 'tools', 'reasoning'], 131072),
    model('Qwen3-Next-80B-A3B-Instruct', ['chat', 'tools'], 262144),
    model('tts-1', ['speech.tts']),
    model('Qwen3-Embedding-8B', ['embedding']),
    model('Qwen3.5-397B-A17B-FP8', ['chat', 'tools', 'reasoning', 'vision'], 262144),
    model('bge-reranker-v2-m3', ['rerank'], 8192),
    model('Qwen3-Reranker-8B', ['rerank'], 32768),
    model('gemma-4-31B-it', ['chat', 'tools', 'reasoning', 'vision'], 131072),
    model('Qwen3.6-35B-A3B', ['chat', 'tools', 'reasoning', 'vision'], 262144),
    model('Qwen3-VL-8B-Instruct', ['chat', 'vision'], 32768)
  ],
  profiles: {
    'chat.fast': { model: 'Qwen3-Next-80B-A3B-Instruct', maxOutputTokens: 512 },
    'chat.general': { model: 'Qwen3-Next-80B-A3B-Instruct', maxOutputTokens: 1024 },
    'chat.reasoning': { model: 'DeepSeek-V4-Flash-0731', maxOutputTokens: 2048, timeoutMs: 180000 },
    'chat.tools': { model: 'Qwen3-Next-80B-A3B-Instruct', maxOutputTokens: 1024 },
    vision: { model: 'Qwen3-VL-8B-Instruct', maxOutputTokens: 1024 },
    embedding: { model: 'intfloat/multilingual-e5-large' },
    rerank: { model: 'bge-reranker-v2-m3' },
    'speech.stt': { model: 'whisper-large-v3' },
    'speech.tts.fast': { model: 'tts-1' },
    'speech.tts.quality': { model: 'tts-1-hd' },
    'image.generation': { model: 'dall-e-3' }
  }
});
