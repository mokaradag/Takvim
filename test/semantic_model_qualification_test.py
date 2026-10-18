"""Yapay zekâ · anlamsal model nitelendirme koşucusu (Python).

CI bu dosyayı çalıştırmaz (CI Python'a bağlı değildir); koşucu değiştiğinde elle
çalıştırılır: `python3 test/semantic_model_qualification_test.py`.
Yalnızca standart kitaplık kullanılır; gerçek model yerine yüklendiğini bir
işaret dosyasıyla bildiren saplama `sentence_transformers` ve `torch`
modülleri kullanılır. NumPy varsa NumPy skalerleri de sınanır.

Sınananlar: model yüklenmeden önceki girdi reddi (yinelenen kimlik, sayı ve
metin sınırı, kapalı şema), Node ile aynı UTF-16 uzunluk ölçüsü, sayı olmayan
gömme değerinin sayıya çevrilmemesi, ölümcül katalog doğrulaması, eski çıktı
silinemediğinde geçici dosya bırakılmaması.
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from fractions import Fraction
from unittest import mock

# Sınama depoda bayt kodu önbelleği bırakmaz.
sys.dont_write_bytecode = True
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, 'scripts', 'semantic-model-qualification.py')
SPEC = importlib.util.spec_from_file_location('semantic_model_qualification', SCRIPT)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)

try:
    import numpy
except ImportError:
    numpy = None

STUB_TORCH = '''
import os
open(os.environ['STUB_MARKER'], 'a').close()
__version__ = 'stub'
def get_num_threads():
    return 1
'''

STUB_SENTENCE_TRANSFORMERS = '''
import os
open(os.environ['STUB_MARKER'], 'a').close()
__version__ = 'stub'
MODE = os.environ.get('STUB_MODE', 'ok')

class SentenceTransformer:
    def __init__(self, name, device=None):
        pass

    def encode(self, texts, **options):
        rows = [[1.0 if column == position % 4 else 0.0 for column in range(4)] for position in range(len(texts))]
        if len(texts) > 1 and MODE == 'strings':
            rows[0] = ['1', '0', '0', '0']
        if len(texts) > 1 and MODE == 'booleans':
            rows[0] = [True, False, False, False]
        if len(texts) == 1 and MODE == 'query-strings':
            rows[0] = ['1', '0', '0', '0']
        return rows

class CrossEncoder:
    def __init__(self, name, device=None):
        pass

    def predict(self, pairs, **options):
        return [float(position) for position in range(len(pairs))]
'''


def read_json(path):
    with open(path, encoding='utf-8') as handle:
        return json.load(handle)


def valid_input(documents=3, queries=2):
    return {
        'format': runner.INPUT_FORMAT,
        'version': 1,
        'benchmark': '0' * 64,
        'catalogue': 'a' * 64,
        'documents': [{'id': f'rota_{index}', 'text': f'Belge {index}'} for index in range(documents)],
        'queries': [{'case': f'tr-{index:03d}', 'text': f'Soru {index}'} for index in range(queries)],
    }


class RunnerTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp(prefix='rota-semantic-runner-')
        self.addCleanup(shutil.rmtree, self.directory)
        stubs = os.path.join(self.directory, 'stubs')
        for name, source in (('torch', STUB_TORCH), ('sentence_transformers', STUB_SENTENCE_TRANSFORMERS)):
            os.makedirs(os.path.join(stubs, name))
            with open(os.path.join(stubs, name, '__init__.py'), 'w', encoding='utf-8') as handle:
                handle.write(source)
        self.stubs = stubs
        self.marker = os.path.join(self.directory, 'models-loaded')
        self.work = os.path.join(self.directory, 'work')
        os.makedirs(self.work)

    def write_input(self, source):
        path = os.path.join(self.work, 'girdi.json')
        with open(path, 'w', encoding='utf-8') as handle:
            json.dump(source, handle, ensure_ascii=False)
        return path

    def run_cli(self, source, *extra, mode='ok'):
        output = os.path.join(self.work, 'kosu.json')
        environment = dict(os.environ, PYTHONPATH=self.stubs, STUB_MARKER=self.marker, STUB_MODE=mode)
        completed = subprocess.run(
            [sys.executable, SCRIPT, '--input', self.write_input(source), '--output', output, '--embedding-model', 'kahin-gomme', *extra],
            capture_output=True, text=True, encoding='utf-8', env=environment, check=False)
        return completed, output

    def temporaries(self):
        return [name for name in os.listdir(self.work) if name.startswith('.semantic-run-')]

    def test_unconsumable_input_is_rejected_before_models_load(self):
        duplicate_document = valid_input()
        duplicate_document['documents'][1]['id'] = 'rota_0'
        duplicate_case = valid_input()
        duplicate_case['queries'][1]['case'] = 'tr-000'
        long_document = valid_input()
        long_document['documents'][0]['text'] = 'ş' * (runner.MAX_DOCUMENT_TEXT + 1)
        # Astral karakter Node'da iki UTF-16 birimidir: kod noktası sınırın altında olsa da reddedilir.
        astral_query = valid_input()
        astral_query['queries'][0]['text'] = '😀' * (runner.MAX_QUERY_TEXT // 2 + 1)
        unknown_field = valid_input()
        unknown_field['documents'][0]['vector'] = [1]
        boolean_version = valid_input()
        boolean_version['version'] = True
        cases = {
            'yinelenen belge kimliği': duplicate_document,
            'yinelenen vaka kimliği': duplicate_case,
            'fazla belge': valid_input(documents=runner.MAX_DOCUMENTS + 1),
            'fazla sorgu': valid_input(queries=runner.MAX_QUERIES + 1),
            'uzun belge metni': long_document,
            'astral sorgu metni': astral_query,
            'bilinmeyen alan': unknown_field,
            'mantıksal sürüm': boolean_version,
            'boş belge listesi': valid_input(documents=0),
        }
        previous = os.path.join(self.work, 'kosu.json')
        for label, source in cases.items():
            with self.subTest(label):
                with open(previous, 'w', encoding='utf-8') as handle:
                    handle.write('{}')
                completed, _ = self.run_cli(source)
                self.assertNotEqual(completed.returncode, 0)
                self.assertIn('Girdi biçimi', completed.stderr)
                self.assertFalse(os.path.exists(self.marker))
                self.assertEqual(self.temporaries(), [])
                # Ön koşul reddi diske dokunmaz.
                self.assertTrue(os.path.exists(previous))

    def test_prefix_bound_uses_utf16_units_like_the_report(self):
        self.assertEqual(runner.utf16_length('😀' * 101), 202)
        self.assertEqual(runner.utf16_length('ş' * 200), 200)
        for flag in ('--query-prefix', '--document-prefix', '--device'):
            with self.subTest(flag):
                extra = [flag, '😀' * 101] + ([] if flag == '--device' else ['--preprocessing', 'astral'])
                completed, _ = self.run_cli(valid_input(), *extra)
                self.assertNotEqual(completed.returncode, 0)
                self.assertIn('UTF-16', completed.stderr)
                self.assertFalse(os.path.exists(self.marker))
        completed, output = self.run_cli(valid_input(), '--query-prefix', '😀' * 100, '--preprocessing', 'astral')
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(read_json(output)['embedding']['queryPrefix'], '😀' * 100)

    def test_embedding_scalars_must_already_be_numbers(self):
        self.assertIsNone(runner.number('1'))
        self.assertIsNone(runner.number(True))
        self.assertIsNone(runner.number(False))
        self.assertIsNone(runner.number(None))
        self.assertIsNone(runner.number(float('nan')))
        self.assertIsNone(runner.number(float('inf')))
        self.assertEqual(runner.number(Fraction(1, 2)), 0.5)
        self.assertEqual(runner.number(3), 3.0)
        if numpy is not None:
            self.assertEqual(runner.number(numpy.float32(0.5)), 0.5)
            self.assertEqual(runner.number(numpy.int64(2)), 2.0)
            self.assertIsNone(runner.number(numpy.bool_(True)))
            self.assertIsNone(runner.number(numpy.float64('nan')))
            self.assertEqual(runner.catalogue_vectors(numpy.eye(3, dtype=numpy.float32), 3), [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])
        valid = [[1.0, 0.0], [0.0, 1.0]]
        self.assertEqual(runner.catalogue_vectors(valid, 2), valid)
        for label, vectors in {
            'sayısal metin': [['1', '0'], [0.0, 1.0]],
            'mantıksal': [[True, False], [0.0, 1.0]],
            'metin vektör': ['10', [0.0, 1.0]],
            'NaN': [[float('nan'), 0.0], [0.0, 1.0]],
            'sonsuz': [[float('inf'), 0.0], [0.0, 1.0]],
            'sıfır vektör': [[0.0, 0.0], [0.0, 1.0]],
            'farklı boyut': [[1.0], [0.0, 1.0]],
            'eksik vektör': [[1.0, 0.0]],
            'sayı': 7,
        }.items():
            with self.subTest(label):
                self.assertIsNone(runner.catalogue_vectors(vectors, 2))

    def test_type_invalid_catalogue_writes_no_run_and_query_values_stay_invalid(self):
        for mode in ('strings', 'booleans'):
            with self.subTest(mode):
                completed, output = self.run_cli(valid_input(), mode=mode)
                self.assertNotEqual(completed.returncode, 0)
                self.assertIn('Katalog gömmesi geçersiz', completed.stderr)
                self.assertFalse(os.path.exists(output))
                self.assertEqual(self.temporaries(), [])
        # Sorgu düzeyinde sayı olmayan değer sayıya çevrilmez: null yazılır, rapor çağrıyı geçersiz sayar.
        completed, output = self.run_cli(valid_input(), '--reranker-model', 'kahin-siralama', mode='query-strings')
        self.assertEqual(completed.returncode, 0, completed.stderr)
        run = read_json(output)
        self.assertEqual([entry['vector'] for entry in run['embedding']['queries']], [[None, None, None, None]] * 2)
        self.assertEqual(len(run['rerank']['queries'][0]['scores']), 3)
        self.assertEqual(self.temporaries(), [])

    def test_failed_removal_of_previous_output_leaves_no_temporary(self):
        output = os.path.join(self.work, 'kosu.json')
        with open(output, 'w', encoding='utf-8') as handle:
            handle.write('{}')
        with mock.patch.object(runner.os, 'remove', side_effect=PermissionError('kilitli')):
            with self.assertRaises(SystemExit) as raised:
                runner.reserve_output(output)
        self.assertIn('Önceki çıktı silinemiyor', str(raised.exception.code))
        self.assertEqual(self.temporaries(), [])
        self.assertTrue(os.path.exists(output))
        handle, temporary = runner.reserve_output(output)
        os.close(handle)
        os.remove(temporary)
        self.assertFalse(os.path.exists(output))


if __name__ == '__main__':
    unittest.main()
