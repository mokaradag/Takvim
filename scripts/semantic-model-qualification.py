#!/usr/bin/env python3
"""Rota AI anlamsal model nitelendirme koşucusu.

Geliştirme aracıdır; uygulama, CI ve Rota sunucusu bu dosyayı çalıştırmaz.
Kamuya açık (ya da yerel klasördeki) gömme ve yeniden sıralama modellerini
çalıştırır ve yalnızca HAM çıktıyı (vektörler, skorlar, gecikme) koşu dosyasına
yazar. Doğrulama, sıralama ve ölçüler burada YAPILMAZ: koşu dosyası
`scripts/semantic-evaluation.mjs report` ile üretimdeki aynı Node
sözleşmesinden geçer. Koşu dosyası modele GERÇEKTEN verilen metni ve önekleri
de taşır; rapor bunları girdiyle birebir karşılaştırır.

Ucuz ön koşullar (girdi, çıktı klasörü ve dosya kimliği, model ve sağlayıcı
kimlikleri) model yüklenmeden ÖNCE denetlenir. Model yükleme ve katalog gömme
hatası ölümcüldür: her belgenin tam bir sonlu, sıfır olmayan ve aynı boyutlu
vektörü yoksa koşu dosyası yazılmaz. Tek bir sorgunun gömme ya da yeniden
sıralama hatası (tek sorguya tek vektör dönmemesi dâhil) `INFERENCE_FAILED`
koduyla kaydedilir (ileti yazılmaz), rapor o vakayı ıska sayar ve tamamlanan
ölçümler korunur. Başarısız denemenin eski çıktısı kalmaz: çıktı yolu işe
başlamadan silinir, sonuç baştan ayrılan geçici dosyadan atomik olarak yerine
konur.

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
# Node sözleşmesinin (semanticContract.js) belirteçleri; rapor aynı biçimi ister.
PREPROCESSING = re.compile(r'[a-z0-9][a-z0-9.:-]{0,63}')
MODEL_TOKEN = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}')
INFERENCE_FAILED = 'INFERENCE_FAILED'
MAX_PREFIX = 200
MAX_TEXT = 200
MAX_BATCH_SIZE = 4096
MAX_DIMENSIONS = 8192


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


def same_file(left, right):
    # Aynı dosyanın farklı yazımı (Windows büyük/küçük harf, kısa ad, sembolik ya da sabit bağ) da aynıdır.
    if os.path.normcase(os.path.realpath(left)) == os.path.normcase(os.path.realpath(right)):
        return True
    try:
        return os.path.samefile(left, right)
    except OSError:
        return False


def reserve_output(path):
    # Çıktı klasörü işe başlamadan doğrulanır: geçici dosya burada ayrılır, sonuç sonda atomik olarak yerine konur.
    if os.path.isdir(path):
        sys.exit('Çıktı yolu bir klasör; koşu dosyasının adını verin.')
    directory = os.path.dirname(os.path.abspath(path))
    if not os.path.isdir(directory):
        sys.exit(f'Çıktı klasörü yok: {directory}')
    try:
        return tempfile.mkstemp(prefix='.semantic-run-', suffix='.tmp', dir=directory)
    except OSError:
        sys.exit(f'Çıktı klasörüne yazılamıyor: {directory}')


def read_input(path):
    try:
        with open(path, encoding='utf-8') as handle:
            source = json.load(handle)
    except (OSError, ValueError):
        sys.exit('Girdi dosyası okunamadı ya da JSON değil.')
    documents = source.get('documents') if isinstance(source, dict) else None
    queries = source.get('queries') if isinstance(source, dict) else None
    if (source.get('format') if isinstance(source, dict) else None) != INPUT_FORMAT or source.get('version') != 1 \
            or not isinstance(source.get('benchmark'), str) or not isinstance(source.get('catalogue'), str) \
            or not isinstance(documents, list) or not documents or not isinstance(queries, list) or not queries \
            or not all(isinstance(item, dict) and isinstance(item.get('id'), str) and isinstance(item.get('text'), str) for item in documents) \
            or not all(isinstance(item, dict) and isinstance(item.get('case'), str) and isinstance(item.get('text'), str) for item in queries):
        sys.exit('Girdi biçimi tanınmadı; önce `node scripts/semantic-evaluation.mjs input` çalıştırın.')
    return source


def preflight(args):
    """Model yüklemeden önce bütün ucuz ön koşullar; uzun koşu sonunda reddedilecek değer burada durdurulur."""
    if not PREPROCESSING.fullmatch(args.preprocessing):
        sys.exit('Ön işleme belirteci küçük harf, rakam, nokta, iki nokta ve tireden oluşmalıdır.')
    if bool(args.query_prefix or args.document_prefix) == (args.preprocessing == 'none'):
        sys.exit('Önek kullanılıyorsa --preprocessing onu adlandırmalı; önek yoksa "none" kalmalıdır.')
    if len(args.query_prefix) > MAX_PREFIX or len(args.document_prefix) > MAX_PREFIX:
        sys.exit(f'Önek en fazla {MAX_PREFIX} karakter olabilir.')
    if not 1 <= args.batch_size <= MAX_BATCH_SIZE:
        sys.exit(f'--batch-size 1 ile {MAX_BATCH_SIZE} arasında olmalıdır.')
    if len(args.device) > MAX_TEXT:
        sys.exit(f'--device en fazla {MAX_TEXT} karakter olabilir.')
    # Yerel klasör yolu model kimliği değildir: kayda yazılan kimlik raporun model belirteci biçiminde olmalıdır.
    identities = [(args.embedding_model, args.embedding_name, '--embedding-name')]
    if args.reranker_model:
        identities.append((args.reranker_model, args.reranker_name, '--reranker-name'))
    for model, name, flag in identities:
        if os.path.isdir(model) and not name:
            sys.exit(f'Yerel model klasörü için {flag} ile model kimliği verilmelidir.')
        if not MODEL_TOKEN.fullmatch(name or model):
            sys.exit(f'Model kimliği "{name or model}" geçersiz; harf, rakam ve ._:/@+- kullanın ya da {flag} verin.')
    if not MODEL_TOKEN.fullmatch(args.provider):
        sys.exit(f'Sağlayıcı belirteci "{args.provider}" geçersiz; harf, rakam ve ._:/@+- kullanın.')
    if not os.path.isfile(args.input):
        sys.exit('Girdi dosyası bulunamadı.')
    if same_file(args.input, args.output):
        sys.exit('Çıktı dosyası girdi dosyasıyla aynı olamaz.')
    source = read_input(args.input)
    reserved = reserve_output(args.output)
    # Başarısız deneme önceki koşuyu bırakmaz: rapor eski çıktıyı yeni sanamaz.
    if os.path.exists(args.output):
        os.remove(args.output)
    return source, reserved


def catalogue_vectors(vectors, count):
    """Katalog gömmesi ölümcül sınırdır: her belgenin tam bir sonlu, sıfır olmayan ve aynı boyutlu vektörü olmalıdır."""
    try:
        rows = [[float(value) for value in vector] for vector in vectors]
    except (TypeError, ValueError):
        return None
    dimensions = len(rows[0]) if rows else 0
    if len(rows) != count or not 1 <= dimensions <= MAX_DIMENSIONS:
        return None
    for row in rows:
        if len(row) != dimensions or not all(math.isfinite(value) for value in row) or not any(row):
            return None
    return rows


def main():
    args = arguments()
    # Windows'ta yönlendirilen stdout yerel kod sayfasıyla kodlanır; yazılamayan karakter koşuyu düşürmez.
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(errors='backslashreplace')
    source, (handle, temporary) = preflight(args)
    try:
        run = qualify(args, source)
        with os.fdopen(handle, 'w', encoding='utf-8') as stream:
            handle = None
            json.dump(run, stream, ensure_ascii=False, allow_nan=False)
        os.replace(temporary, args.output)
    finally:
        if handle is not None:
            os.close(handle)
        if os.path.exists(temporary):
            os.remove(temporary)
    failures = sum('failure' in entry for entry in run['embedding']['queries']) \
        + sum('failure' in entry for entry in (run['rerank'] or {}).get('queries', []))
    # Özet satırı yalnızca ASCII'dir: Windows kod sayfasında da yazılabilir.
    print(f'{len(source["documents"])} documents, {len(source["queries"])} queries, '
          f'dimensions {len(run["embedding"]["documents"][0]["vector"])}, '
          f'reranker {"yes" if run["rerank"] else "no"}, failed calls {failures} -> {args.output}')


def qualify(args, source):
    # Ağır bağımlılıklar yalnızca gerçek koşuda ve ön koşullardan sonra yüklenir.
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
    document_vectors = catalogue_vectors(document_vectors, len(documents))
    if document_vectors is None:
        sys.exit('Katalog gömmesi geçersiz (eksik/fazla, sonlu olmayan, sıfır ya da farklı boyutlu vektör); koşu dosyası yazılmadı.')
    query_entries = []
    for query in queries:
        entry = {'case': query['case'], 'text': query['text']}
        started = time.perf_counter()
        # Hata iletisi güvenilmezdir; yalnızca güvenli kod kaydedilir. Tek sorguya tam bir vektör dönmelidir.
        try:
            vectors = embedder.encode([args.query_prefix + query['text']], convert_to_numpy=True,
                                      normalize_embeddings=False, show_progress_bar=False)
            if len(vectors) != 1:
                raise ValueError(INFERENCE_FAILED)
            entry['vector'] = finite(vectors[0])
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
                  'runtime': runtime, 'batchSize': args.batch_size, 'queries': entries}

    return {
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
            'batchSize': args.batch_size,
            'documentLatencyMs': document_latency,
            'documents': [{'id': item['id'], 'text': item['text'], 'vector': vector}
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


if __name__ == '__main__':
    main()
