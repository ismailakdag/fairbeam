"""In-process model transactions: concurrent editor requests must not lose updates.

No solver or server is started. Events hold a transaction after its disk checks;
all worker waits and joins are bounded, and gates are released even on failure.
"""
import copy
import json
import os
import stat
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fairbeam import modelfiles as m
from fairbeam.design import template_design


class ConcurrentFiles(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.models = Path(self.tmp.name) / 'models'
        self.hist = Path(self.tmp.name) / 'history'
        self.models.mkdir()

    def overlap(self, first, second, hook, match=lambda *a, **k: True, during=None):
        """Hold the first operation inside its write/move, then issue the second."""
        held, release, started, done = (threading.Event() for _ in range(4))
        results = {}
        owner, name = hook
        original = getattr(owner, name)

        def paused(*a, **k):
            if threading.current_thread().name == 'first' and match(*a, **k):
                held.set()
                if not release.wait(5):
                    raise TimeoutError('test gate was not released')
            return original(*a, **k)

        def worker(name, action):
            if name == 'second':
                started.set()
            try:
                results[name] = action()
            except Exception as exc:
                results[name] = exc
            finally:
                if name == 'second':
                    done.set()

        threads = [threading.Thread(target=worker, args=(name, fn), name=name, daemon=True)
                   for name, fn in [('first', first), ('second', second)]]
        with mock.patch.object(owner, name, paused):
            try:
                threads[0].start()
                self.assertTrue(held.wait(5), 'first transaction reached its write')
                threads[1].start()
                self.assertTrue(started.wait(5))
                self.assertFalse(done.wait(0.1), 'second operation must wait for the transaction')
                if during:
                    during()
            finally:
                release.set()
                for thread in threads:
                    if thread.ident is not None:
                        thread.join(5)
                self.assertFalse(any(t.is_alive() for t in threads), 'workers must finish')
        return results

    def assert_conflict(self, result, status):
        self.assertIsInstance(result, m.ModelFileError)
        self.assertEqual(result.status, status)

    def test_same_hash_model_saves_have_one_winner_and_one_backup(self):
        m.create_model(self.models, 'one', 'x = 1\n', None)
        h = m.read_model(self.models, 'one')['hash']
        other = Path(self.tmp.name) / 'other'
        def unrelated():
            m.create_model(other, 'one', 'x = 9\n', None)
            m.create_model(self.models, 'another', 'x = 4\n', None)
        results = self.overlap(
            lambda: m.save_model(self.models, self.hist, 'one', 'x = 2\n', h),
            lambda: m.save_model(self.models / '.', self.hist, 'one', 'x = 3\n', h),
            (m, '_write_atomic'), lambda p, *a, **k: p.parent == self.models,
            during=unrelated)
        self.assertIsInstance(results['first'], dict)
        self.assert_conflict(results['second'], 409)
        self.assertEqual(results['second'].extra['current_hash'], results['first']['hash'])
        self.assertEqual(m.read_model(self.models, 'one')['source'], 'x = 2\n')
        versions = m.list_versions(self.hist, 'one')
        self.assertEqual(len(versions), 1)
        self.assertEqual(m.read_version(self.hist, 'one', versions[0]['version'])['source'], 'x = 1\n')
        self.assertEqual(m.read_model(other, 'one')['source'], 'x = 9\n')
        self.assertEqual(m.read_model(self.models, 'another')['source'], 'x = 4\n')

    def design(self):
        m.create_design(self.models, 'one', template_design('patch', 'one', 'Original'))
        rec = m.read_design_file(self.models, 'one')
        changed = copy.deepcopy(rec['design'])
        changed['model']['name'] = 'Changed'
        return rec, changed

    def test_same_hash_design_saves_have_one_winner(self):
        rec, changed = self.design()
        second = copy.deepcopy(changed)
        second['model']['name'] = 'Second'
        results = self.overlap(
            lambda: m.save_design(self.models, self.hist, 'one', changed, rec['hash']),
            lambda: m.save_design(self.models, self.hist, 'one', second, rec['hash']),
            (m, '_write_atomic'), lambda p, *a, **k: p.parent == self.models)
        self.assertIsInstance(results['first'], dict)
        self.assert_conflict(results['second'], 409)
        self.assertEqual(m.read_design_file(self.models, 'one')['design']['model']['name'], 'Changed')
        versions = list((self.hist / 'one').glob('*.design.json'))
        self.assertEqual(len(versions), 1)
        self.assertEqual(json.loads(versions[0].read_text())['model']['name'], 'Original')

    def test_python_and_design_creation_share_one_id_space(self):
        for first_design in (False, True):
            with self.subTest(first_design=first_design):
                model_id = 'design_first' if first_design else 'python_first'
                py = lambda: m.create_model(self.models, model_id, 'x = 1\n', None)
                design = lambda: m.create_design(self.models, model_id, template_design('patch', model_id, 'New'))
                first, second = (design, py) if first_design else (py, design)
                result = self.overlap(first, second, (m, '_write_atomic'))
                self.assertIsInstance(result['first'], Path)
                self.assert_conflict(result['second'], 409)
                self.assertEqual(m.model_path(self.models, model_id).exists(), not first_design)
                self.assertEqual(m.design_path(self.models, model_id).exists(), first_design)

    def test_delete_before_save_does_not_resurrect_design(self):
        rec, changed = self.design()
        results = self.overlap(
            lambda: m.delete_design(self.models, self.hist, 'one'),
            lambda: m.save_design(self.models, self.hist, 'one', changed, rec['hash']),
            (m.shutil, 'move'))
        self.assertIsInstance(results['first'], dict)
        self.assert_conflict(results['second'], 404)
        self.assertFalse(m.design_path(self.models, 'one').exists())
        self.assertEqual(json.loads(Path(results['first']['moved_to']).read_text())['model']['name'], 'Original')

    def test_save_before_delete_archives_committed_version(self):
        rec, changed = self.design()
        results = self.overlap(
            lambda: m.save_design(self.models, self.hist, 'one', changed, rec['hash']),
            lambda: m.delete_design(self.models, self.hist, 'one'),
            (m, '_write_atomic'), lambda p, *a, **k: p.parent == self.models)
        self.assertIsInstance(results['first'], dict)
        self.assertIsInstance(results['second'], dict)
        self.assertFalse(m.design_path(self.models, 'one').exists())
        self.assertEqual(json.loads(Path(results['second']['moved_to']).read_text())['model']['name'], 'Changed')

    def test_read_waits_for_creation(self):
        results = self.overlap(
            lambda: m.create_model(self.models, 'one', 'x = 1\n', None),
            lambda: m.read_model(self.models, 'one'), (m, '_write_atomic'))
        self.assertEqual(results['second']['source'], 'x = 1\n')

    def test_direct_history_writes_do_not_reuse_version_names(self):
        with mock.patch.object(m.time, 'strftime', return_value='20261011-120000'):
            results = self.overlap(
                lambda: m.backup_version(self.hist, 'one', 'x = 1\n'),
                lambda: m.backup_version(self.hist, 'one', 'x = 2\n'), (m, '_write_atomic'))
        self.assertNotEqual(results['first'], results['second'])
        self.assertEqual({p.read_text() for p in (self.hist / 'one').glob('*.py')}, {'x = 1\n', 'x = 2\n'})

    def test_history_reader_waits_for_writer(self):
        results = self.overlap(
            lambda: m.backup_version(self.hist, 'one', 'x = 1\n'),
            lambda: m.list_versions(self.hist, 'one'), (m, '_write_atomic'))
        self.assertEqual(len(results['second']), 1)
        self.assertEqual(results['second'][0]['hash'], m.source_hash('x = 1\n'))

    def test_atomic_writes_use_unique_temps_even_without_model_lock(self):
        # Other callers (e.g. user materials) also use the low-level writer directly.
        target = self.models / 'shared.json'
        barrier = threading.Barrier(2)
        paths, errors = [], []
        original = m._replace
        def replace(src, dst):
            paths.append(src)
            barrier.wait(5)
            original(src, dst)
        def worker(text):
            try:
                m._write_atomic(target, text)
            except Exception as exc:
                errors.append(exc)
        with mock.patch.object(m, '_replace', replace):
            threads = [threading.Thread(target=worker, args=(text,), daemon=True) for text in ('first\n', 'second\n')]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(6)
            self.assertFalse(any(t.is_alive() for t in threads))
        self.assertEqual(errors, [])
        self.assertEqual(len(set(paths)), 2)
        self.assertIn(target.read_text(), ('first\n', 'second\n'))
        self.assertEqual(list(self.models.glob('.*.tmp')), [])

    def test_failed_transactions_release_registry_and_clean_temps(self):
        m.create_model(self.models, 'one', 'x = 1\n', None)
        h = m.read_model(self.models, 'one')['hash']
        original = m._replace
        with self.assertRaises(m.ModelFileError) as invalid:
            m.save_model(self.models, self.hist, 'one', None, h)
        self.assertEqual(invalid.exception.status, 422)
        self.assertEqual(m._transactions, {})
        def fail_model_write(src, dst):
            if dst == self.models / 'one.py':
                raise OSError('failed write')
            return original(src, dst)
        with mock.patch.object(m, '_replace', side_effect=fail_model_write):
            with self.assertRaises(OSError):
                m.save_model(self.models, self.hist, 'one', 'x = 2\n', h)
        self.assertEqual(m._transactions, {})

        self.assertEqual(list(Path(self.tmp.name).rglob('.*.tmp')), [])
        self.assertEqual(m.read_model(self.models, 'one')['source'], 'x = 1\n')
        result = m.save_model(self.models, self.hist, 'one', 'x = 2\n', h)
        self.assertEqual(result['hash'], m.source_hash('x = 2\n'))
        with self.assertRaises(m.ModelFileError):
            m.save_model(self.models, self.hist, 'one', 'x = 3\n', h)
        self.assertEqual(m._transactions, {})
        # Distinct IDs do not accumulate idle locks.
        for index in range(100):
            with m._transaction(self.models, f'id_{index}'):
                with m._transaction(self.models, f'id_{index}'):
                    pass
        self.assertEqual(m._transactions, {})

    def test_atomic_replacement_preserves_existing_permissions(self):
        target = self.models / 'permissions.py'
        target.write_text('old\n')
        target.chmod(0o640)
        before = stat.S_IMODE(target.stat().st_mode)
        if os.name != 'nt':
            self.assertEqual(before, 0o640)
        m._write_atomic(target, 'new\n')
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), before)
        self.assertEqual(target.read_text(), 'new\n')


if __name__ == '__main__':
    unittest.main()
