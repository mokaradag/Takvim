#!/usr/bin/env python3
"""Rota AI anlamsal model nitelendirme koşucusu.

Geliştirme aracıdır; uygulama, CI ve Rota sunucusu bu dosyayı çalıştırmaz.
Kamuya açık (ya da yerel klasördeki) gömme ve yeniden sıralama modellerini
çalıştırır ve yalnızca HAM çıktıyı (vektörler, skorlar, gecikme) koşu dosyasına
yazar. Doğrulama, sıralama ve ölçüler burada YAPILMAZ: koşu dosyası
`scripts/semantic-evaluation.mjs report` ile üretimdeki aynı Node
sözleşmesinden geçer.

    node scripts/semantic-evaluation.mjs input --out girdi.json
    python3 scripts/semantic-model-qualification.py --input girdi.json --output kosu.json \\
        --embedding-model intfloat/multilingual-e5-large \\
        --query-prefix "query: " --document-prefix "passage: " --preprocessing e5-query-passage \\
        --reranker-model BAAI/bge-reranker-v2-m3
    node scripts/semantic-evaluation.mjs report --run kosu.json

Gereksinim: `pip install sentence-transformers`. Ayrıntı: docs/YAPAY-ZEKA-ANLAMSAL-KATMAN.md
"""
import argparse
import gc
import json
import math
import os
import platform
import re
import sys
import time

INPUT_FORMAT = 'mergen-rota-semantic-input'
RUN_FORMAT = 'mergen-rota-semantic-model-run'
PREPROCESSING = re.compile(r'^[a-z0-9][a-z0-9.:-]{0,63}$')


def finite(values):
    # JSON NaN/Infinity taşıyamaz: sonlu olmayan değer null yazılır ve Node sözleşmesi reddeder.
    return [float(value) if math.isfinite(float(value)) else None for value in values]


def elapsed_ms(started):
    return round((time.perf_counter() - started) * 1000, 3)


def arguments():
    parser = argparse.ArgumentParser(description='Rota AI anlamsal model nitelendirme koşucusu')
    parser.add_argument('--input', required=True, help='semantic-evaluation.mjs input çıktısı')
    parser.add_argument('--output', required=True, help='yazılacak koşu dosyası')
    parser.add_argument('--embedding-model', required=True, help='Hugging Face kimliği ya da yerel model klasörü')
    parser.add_argument('--embedding-name', help='raporda görünecek model kimliği (yerel klasörde zorunlu)')
    parser.add_argument('--query-prefix', default='', help='sorgu öneki (ör. E5 için "query: ")')
    parser.add_argument('--document-prefix', default='', help='belge öneki (ör. E5 için "passage: ")')
    parser.add_argument('--preprocessing', default='none', help='ön işleme belirteci; önekler değişirse değiştirilmelidir')
    parser.add_argument('--reranker-model', help='Hugging Face kimliği ya da yerel model klasörü')
    parser.add_argument('--reranker-name', help='raporda görünecek yeniden sıralama modeli kimliği')
    parser.add_argument('--provider', default='huggingface', help='model kaynağı belirteci')
    parser.add_argument('--device', default='cpu')
    parser.add_argument('--batch-size', type=int, default=8)
    return parser.parse_args()


def main():
    args = arguments()
    with open(args.input, encoding='utf-8') as handle:
        source = json.load(handle)
    if source.get('format') != INPUT_FORMAT or source.get('version') != 1:
        sys.exit('Girdi biçimi tanınmadı; önce `node scripts/semantic-evaluation.mjs input` çalıştırın.')
    if not PREPROCESSING.match(args.preprocessing):
        sys.exit('Ön işleme belirteci küçük harf, rakam, nokta, iki nokta ve tireden oluşmalıdır.')
    if bool(args.query_prefix or args.document_prefix) == (args.preprocessing == 'none'):
        sys.exit('Önek kullanılıyorsa --preprocessing onu adlandırmalı; önek yoksa "none" kalmalıdır.')
    # Yerel klasör yolu model kimliği değildir; rapora kayıttaki kimlik yazılmalıdır.
    for model, name, flag in ((args.embedding_model, args.embedding_name, '--embedding-name'),
                              (args.reranker_model, args.reranker_name, '--reranker-name')):
        if model and os.path.isdir(model) and not name:
            sys.exit(f'Yerel model klasörü için {flag} ile model kimliği verilmelidir.')

    # Ağır bağımlılıklar yalnızca gerçek koşuda yüklenir.
    import sentence_transformers
    import torch
    from sentence_transformers import CrossEncoder, SentenceTransformer

    documents = source['documents']
    queries = source['queries']
    runtime = f'sentence-transformers {sentence_transformers.__version__} · torch {torch.__version__}'

    embedder = SentenceTransformer(args.embedding_model, device=args.device)
    started = time.perf_counter()
    document_vectors = embedder.encode([args.document_prefix + item['text'] for item in documents],
                                       batch_size=args.batch_size, convert_to_numpy=True,
                                       normalize_embeddings=False, show_progress_bar=False)
    document_latency = elapsed_ms(started)
    query_entries = []
    for query in queries:
        started = time.perf_counter()
        vector = embedder.encode([args.query_prefix + query['text']], convert_to_numpy=True,
                                 normalize_embeddings=False, show_progress_bar=False)[0]
        query_entries.append({'case': query['case'], 'vector': finite(vector), 'latencyMs': elapsed_ms(started)})
    del embedder
    gc.collect()

    rerank = None
    if args.reranker_model:
        reranker = CrossEncoder(args.reranker_model, device=args.device)
        entries = []
        for query in queries:
            started = time.perf_counter()
            scores = reranker.predict([(query['text'], item['text']) for item in documents],
                                      batch_size=args.batch_size, show_progress_bar=False)
            entries.append({'case': query['case'], 'latencyMs': elapsed_ms(started),
                            'scores': [{'id': item['id'], 'score': score} for item, score in zip(documents, finite(scores))]})
        rerank = {'model': args.reranker_name or args.reranker_model, 'provider': args.provider,
                  'runtime': runtime, 'queries': entries}

    run = {
        'format': RUN_FORMAT,
        'version': 1,
        'benchmark': source['benchmark'],
        'catalogue': source['catalogue'],
        'embedding': {
            'model': args.embedding_name or args.embedding_model,
            'provider': args.provider,
            'preprocessing': args.preprocessing,
            'runtime': runtime,
            'documentLatencyMs': document_latency,
            'documents': [{'id': item['id'], 'vector': finite(vector)} for item, vector in zip(documents, document_vectors)],
            'queries': query_entries
        },
        'rerank': rerank,
        'environment': {
            'device': args.device,
            'threads': torch.get_num_threads(),
            'cpus': os.cpu_count(),
            'python': platform.python_version(),
            'platform': platform.platform(terse=True)
        }
    }
    with open(args.output, 'w', encoding='utf-8') as handle:
        json.dump(run, handle, ensure_ascii=False, allow_nan=False)
    print(f'{len(documents)} belge, {len(queries)} sorgu; boyut {len(document_vectors[0])}; '
          f'yeniden sıralama {"var" if rerank else "yok"} → {args.output}')


if __name__ == '__main__':
    main()
