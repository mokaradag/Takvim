#!/usr/bin/env python3
"""Rota AI anlamsal model nitelendirme koşucusu.

Geliştirme aracıdır; uygulama, CI ve Rota sunucusu bu dosyayı çalıştırmaz.
Kamuya açık (ya da yerel klasördeki) gömme ve yeniden sıralama modellerini
çalıştırır ve yalnızca HAM çıktıyı (vektörler, skorlar, gecikme) koşu dosyasına
yazar. Doğrulama, sıralama ve ölçüler burada YAPILMAZ: koşu dosyası
`scripts/semantic-evaluation.mjs report` ile üretimdeki aynı Node
sözleşmesinden geçer. Koşu dosyası modele GERÇEKTEN verilen metni ve önekleri
de taşır; rapor bunları girdiyle birebir karşılaştırır.

Model yükleme ve katalog gömme hatası ölümcüldür. Tek bir sorgunun gömme ya da
yeniden sıralama hatası `INFERENCE_FAILED` koduyla kaydedilir (ileti yazılmaz),
rapor o vakayı ıska sayar ve tamamlanan ölçümler korunur. Başarısız denemenin
eski çıktısı kalmaz: çıktı yolu işe başlamadan silinir, sonuç geçici dosyadan
atomik olarak yerine konur.

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
import tempfile
import time

INPUT_FORMAT = 'mergen-rota-semantic-input'
RUN_FORMAT = 'mergen-rota-semantic-model-run'
PREPROCESSING = re.compile(r'^[a-z0-9][a-z0-9.:-]{0,63}$')
INFERENCE_FAILED = 'INFERENCE_FAILED'
MAX_PREFIX = 200


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


def write_atomic(path, run):
    # Aynı klasörde geçici dosya + os.replace: yarım ya da eski çıktı okunamaz.
    directory = os.path.dirname(os.path.abspath(path))
    handle, temporary = tempfile.mkstemp(prefix='.semantic-run-', suffix='.tmp', dir=directory)
    try:
        with os.fdopen(handle, 'w', encoding='utf-8') as stream:
            json.dump(run, stream, ensure_ascii=False, allow_nan=False)
        os.replace(temporary, path)
    except BaseException:
        if os.path.exists(temporary):
            os.remove(temporary)
        raise


def main():
    args = arguments()
    # Windows'ta yönlendirilen stdout yerel kod sayfasıyla kodlanır; yazılamayan karakter koşuyu düşürmez.
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(errors='backslashreplace')
    if os.path.abspath(args.output) == os.path.abspath(args.input):
        sys.exit('Çıktı dosyası girdi dosyasıyla aynı olamaz.')
    # Başarısız deneme önceki koşuyu bırakmaz: rapor eski çıktıyı yeni sanamaz.
    if os.path.exists(args.output):
        os.remove(args.output)
    with open(args.input, encoding='utf-8') as handle:
        source = json.load(handle)
    if source.get('format') != INPUT_FORMAT or source.get('version') != 1:
        sys.exit('Girdi biçimi tanınmadı; önce `node scripts/semantic-evaluation.mjs input` çalıştırın.')
    if not PREPROCESSING.match(args.preprocessing):
        sys.exit('Ön işleme belirteci küçük harf, rakam, nokta, iki nokta ve tireden oluşmalıdır.')
    if bool(args.query_prefix or args.document_prefix) == (args.preprocessing == 'none'):
        sys.exit('Önek kullanılıyorsa --preprocessing onu adlandırmalı; önek yoksa "none" kalmalıdır.')
    if len(args.query_prefix) > MAX_PREFIX or len(args.document_prefix) > MAX_PREFIX:
        sys.exit(f'Önek en fazla {MAX_PREFIX} karakter olabilir.')
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
        entry = {'case': query['case'], 'text': query['text']}
        started = time.perf_counter()
        # Hata iletisi güvenilmezdir; yalnızca güvenli kod kaydedilir.
        try:
            entry['vector'] = finite(embedder.encode([args.query_prefix + query['text']], convert_to_numpy=True,
                                                     normalize_embeddings=False, show_progress_bar=False)[0])
        except Exception:
            entry['failure'] = INFERENCE_FAILED
        entry['latencyMs'] = elapsed_ms(started)
        query_entries.append(entry)
    del embedder
    gc.collect()

    rerank = None
    if args.reranker_model:
        reranker = CrossEncoder(args.reranker_model, device=args.device)
        entries = []
        # Her sorguda bütün katalog puanlanır; rapor bu iş yükünü gecikmenin yanında açıkça yazar.
        for query in queries:
            entry = {'case': query['case']}
            started = time.perf_counter()
            try:
                scores = finite(reranker.predict([(query['text'], item['text']) for item in documents],
                                                 batch_size=args.batch_size, show_progress_bar=False))
                if len(scores) != len(documents):
                    raise ValueError(INFERENCE_FAILED)
                entry['scores'] = [{'id': item['id'], 'score': score} for item, score in zip(documents, scores)]
            except Exception:
                entry['failure'] = INFERENCE_FAILED
            entry['latencyMs'] = elapsed_ms(started)
            entries.append(entry)
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
            'queryPrefix': args.query_prefix,
            'documentPrefix': args.document_prefix,
            'runtime': runtime,
            'documentLatencyMs': document_latency,
            'documents': [{'id': item['id'], 'text': item['text'], 'vector': finite(vector)}
                          for item, vector in zip(documents, document_vectors)],
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
    write_atomic(args.output, run)
    failures = sum('failure' in entry for entry in query_entries) + sum('failure' in entry for entry in (rerank or {}).get('queries', []))
    # Özet satırı yalnızca ASCII'dir: Windows kod sayfasında da yazılabilir.
    print(f'{len(documents)} documents, {len(queries)} queries, dimensions {len(document_vectors[0])}, '
          f'reranker {"yes" if rerank else "no"}, failed calls {failures} -> {args.output}')


if __name__ == '__main__':
    main()
