"""Real subprocess transactions; no server, desktop app or solver is started."""
import copy
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fairbeam import _filelocks as locks, modelfiles as m
from fairbeam.design import template_design


def wait_file(path, timeout=10):
    deadline = time.monotonic() + timeout
    while not path.exists():
        if time.monotonic() >= deadline:
            raise TimeoutError(f"test gate not reached: {path.name}")
        time.sleep(0.01)


def worker(spec):
    root, history = Path(spec['root']), Path(spec['history'])
    locks._lock_directory = lambda: Path(spec['locks'])
    result_path = Path(spec['result'])
    original_write, original_lock = m._write_atomic, locks._try_lock

    def write(path, *args, **kwargs):
        if spec.get('pause') and path.parent == root.resolve():
            Path(spec['held']).touch()
            wait_file(Path(spec['release']))
        return original_write(path, *args, **kwargs)

    def try_lock(fd):
        Path(spec['attempt']).touch()
        return original_lock(fd)

    m._write_atomic, locks._try_lock = write, try_lock
    if spec.get('timeout'):
        m.model_lock = lambda key: locks.model_lock(key, timeout=0.15)
    try:
        action, model_id = spec['action'], spec.get('id', 'one')
        if action == 'hold':
            # Nested acquisition must reuse the descriptor, not deadlock.
            with m._transaction(root, model_id), m._transaction(root, model_id):
                Path(spec['held']).touch()
                wait_file(Path(spec['release']))
            value = None
        elif action == 'design-save':
            value = m.save_design(root, history, model_id, spec['design'], spec['hash'])
        elif action == 'model-save':
            value = m.save_model(root, history, model_id, spec['source'], spec['hash'])
        elif action == 'design-create':
            value = str(m.create_design(root, model_id, template_design('patch', model_id, 'New')))
        elif action == 'model-create':
            value = str(m.create_model(root, model_id, 'x = 1\n', None))
        elif action == 'delete':
            value = m.delete_design(root, history, model_id)
        elif action == 'history':
            m.time.strftime = lambda *_: '20261011-120000'
            value = str(m.backup_version(history, model_id, spec['source']))
        else:
            raise AssertionError(action)
        result = {'status': 200, 'value': value}
    except m.ModelFileError as exc:
        result = {'status': exc.status, 'extra': exc.extra}
    except Exception as exc:
        result = {'status': 'error', 'error': repr(exc)}
    result_path.write_text(json.dumps(result), encoding='utf-8')


class ProcessTransactions(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root, self.history, self.lockdir = (self.base / p for p in ('models', 'history', 'locks'))
        self.root.mkdir()
        self.children = []
        self.addCleanup(self.stop_children)
        patch = mock.patch.object(locks, '_lock_directory', return_value=self.lockdir)
        patch.start()
        self.addCleanup(patch.stop)

    def stop_children(self):
        for proc in self.children:
            if proc.poll() is None:
                proc.terminate()
            try:
                proc.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate(timeout=5)

    def start(self, action, **options):
        number = len(self.children)
        spec = dict(root=str(self.root), history=str(self.history), locks=str(self.lockdir),
                    result=str(self.base / f'result-{number}.json'),
                    held=str(self.base / f'held-{number}'), release=str(self.base / f'release-{number}'),
                    attempt=str(self.base / f'attempt-{number}'), action=action)
        spec.update(options)
        proc = subprocess.Popen([sys.executable, __file__, '--worker', json.dumps(spec)],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        self.children.append(proc)
        return proc, spec

    def finish(self, item):
        proc, spec = item
        stdout, stderr = proc.communicate(timeout=10)
        self.assertEqual(proc.returncode, 0, (stdout, stderr))
        result = json.loads(Path(spec['result']).read_text())
        self.assertNotEqual(result['status'], 'error', result)
        return result

    def blocked(self, item):
        wait_file(Path(item[1]['attempt']))
        time.sleep(0.1)
        self.assertIsNone(item[0].poll(), 'contender must wait for the owner')
        self.assertFalse(Path(item[1]['result']).exists())

    def release(self, item):
        Path(item[1]['release']).touch()

    def design(self):
        m.create_design(self.root, 'one', template_design('patch', 'one', 'Original'))
        return m.read_design_file(self.root, 'one')

    def test_same_hash_saves_one_winner_one_conflict_and_one_original_backup(self):
        for design in (False, True):
            with self.subTest(design=design):
                model_id = 'design_one' if design else 'python_one'
                if design:
                    original = template_design('patch', model_id, 'Original')
                    m.create_design(self.root, model_id, original)
                    rec = m.read_design_file(self.root, model_id)
                    original = rec['design']
                    first = copy.deepcopy(original)
                    second = copy.deepcopy(original)
                    first['model']['name'], second['model']['name'] = 'First', 'Second'
                    args_a, args_b = dict(design=first), dict(design=second)
                else:
                    m.create_model(self.root, model_id, 'x = 1\n', None)
                    rec = m.read_model(self.root, model_id)
                    args_a, args_b = dict(source='x = 2\n'), dict(source='x = 3\n')
                action = 'design-save' if design else 'model-save'
                a = self.start(action, id=model_id, hash=rec['hash'], pause=True, **args_a)
                wait_file(Path(a[1]['held']))
                b = self.start(action, id=model_id, hash=rec['hash'],
                               root=str(self.root / '..' / 'models'), **args_b)
                self.blocked(b)
                self.release(a)
                winner, stale = self.finish(a), self.finish(b)
                self.assertEqual(winner['status'], 200)
                self.assertEqual(stale['status'], 409)
                self.assertEqual(stale['extra']['current_hash'], winner['value']['hash'])
                versions = list((self.history / model_id).glob('*'))
                self.assertEqual(len(versions), 1)
                if design:
                    self.assertEqual(m.read_design_file(self.root, model_id)['design'], first)
                    self.assertEqual(json.loads(versions[0].read_text()), original)
                else:
                    self.assertEqual(m.read_model(self.root, model_id)['source'], 'x = 2\n')
                    self.assertEqual(versions[0].read_text(), 'x = 1\n')

    def test_create_python_and_design_share_id(self):
        a = self.start('model-create', pause=True)
        wait_file(Path(a[1]['held']))
        b = self.start('design-create')
        self.blocked(b)
        self.release(a)
        self.assertEqual(self.finish(a)['status'], 200)
        self.assertEqual(self.finish(b)['status'], 409)
        self.assertFalse((self.root / 'one.design.json').exists())

    def test_delete_waits_and_archives_latest_saved_design(self):
        rec = self.design()
        changed = copy.deepcopy(rec['design'])
        changed['model']['name'] = 'Saved before deletion'
        a = self.start('design-save', design=changed, hash=rec['hash'], pause=True)
        wait_file(Path(a[1]['held']))
        b = self.start('delete')
        self.blocked(b)
        self.release(a)
        self.assertEqual(self.finish(a)['status'], 200)
        removed = self.finish(b)
        self.assertEqual(removed['status'], 200)
        self.assertEqual(json.loads(Path(removed['value']['moved_to']).read_text()), changed)
        self.assertFalse((self.root / 'one.design.json').exists())

    def test_distinct_ids_and_roots_do_not_block(self):
        holder = self.start('hold')
        wait_file(Path(holder[1]['held']))
        self.assertEqual(self.finish(self.start('model-create', id='another'))['status'], 200)
        other_root = self.base / 'other'
        item = self.start('model-create', root=str(other_root))
        self.assertEqual(self.finish(item)['status'], 200)
        self.release(holder)
        self.assertEqual(self.finish(holder)['status'], 200)

    def test_killed_owner_releases_os_lock_without_deleting_file(self):
        holder = self.start('hold')
        wait_file(Path(holder[1]['held']))
        names = set(self.lockdir.iterdir())
        self.assertEqual(len(names), 1)
        contender = self.start('model-create')
        self.blocked(contender)
        holder[0].kill()  # Only this test's owned child; no finally/unlock executes.
        holder[0].communicate(timeout=5)
        self.assertEqual(self.finish(contender)['status'], 200)
        self.assertEqual(set(self.lockdir.iterdir()), names)

    def test_timeout_fails_closed_then_recovers(self):
        holder = self.start('hold')
        wait_file(Path(holder[1]['held']))
        self.assertEqual(self.finish(self.start('model-create', timeout=True))['status'], 503)
        self.assertFalse((self.root / 'one.py').exists())
        self.release(holder)
        self.assertEqual(self.finish(holder)['status'], 200)
        self.assertEqual(self.finish(self.start('model-create'))['status'], 200)

    def test_same_timestamp_history_writes_preserve_both_versions(self):
        holder = self.start('hold', root=str(self.history))
        wait_file(Path(holder[1]['held']))
        a = self.start('history', source='first\n')
        b = self.start('history', source='second\n')
        self.blocked(a)
        self.blocked(b)
        self.release(holder)
        self.assertEqual(self.finish(holder)['status'], 200)
        self.assertEqual(self.finish(a)['status'], 200)
        self.assertEqual(self.finish(b)['status'], 200)
        versions = list((self.history / 'one').glob('*.py'))
        self.assertEqual({p.name for p in versions}, {'20261011-120000.py', '20261011-120000-2.py'})
        self.assertEqual({p.read_text() for p in versions}, {'first\n', 'second\n'})

    def test_invalid_id_no_lock_or_workspace_side_effects(self):
        missing = self.base / 'missing'
        with self.assertRaises(m.ModelFileError) as error:
            with m._transaction(missing, '../escape'):
                self.fail('invalid ID acquired a transaction')
        self.assertEqual(error.exception.status, 422)
        self.assertFalse(missing.exists())
        self.assertFalse(self.lockdir.exists())

    def test_read_does_not_create_missing_history_or_write_models(self):
        rec = self.design()
        original = (self.root / 'one.design.json').read_bytes()
        self.assertEqual(m.list_versions(self.history, 'one'), [])
        self.assertFalse(self.history.exists())
        self.assertEqual(m.read_design_file(self.root, 'one'), rec)
        self.assertEqual((self.root / 'one.design.json').read_bytes(), original)
        self.assertEqual({p.name for p in self.root.iterdir()}, {'one.design.json'})

    def test_non_contention_error_fails_closed_and_closes_descriptor(self):
        opened = []
        real_open = locks.os.open
        def capture(*args):
            fd = real_open(*args)
            opened.append(fd)
            return fd
        with mock.patch.object(locks.os, 'open', side_effect=capture), \
                mock.patch.object(locks, '_try_lock', side_effect=OSError(9, 'bad descriptor')) as attempt:
            with self.assertRaises(OSError):
                m.create_model(self.root, 'one', 'x = 1\n', None)
        self.assertEqual(attempt.call_count, 1)
        self.assertFalse((self.root / 'one.py').exists())
        self.assertEqual(m._transactions, {})
        for fd in opened:
            with self.assertRaises(OSError):
                os.fstat(fd)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--worker':
        worker(json.loads(sys.argv[2]))
    else:
        unittest.main()
