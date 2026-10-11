"""Real OS advisory locks, using only the stdlib (no fairbeam/native imports).

Workers are fresh isolated interpreters, not fork-in-place children. Every lock
and handshake lives under this test's temporary directory, never the user's home.
"""
import errno
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest


def load_lock_module():
    source = Path(__file__).resolve().parents[1] / "fairbeam" / "_filelocks.py"
    spec = importlib.util.spec_from_file_location("standalone_filelocks", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def wait_file(path, process=None, timeout=10):
    deadline = time.monotonic() + timeout
    while not path.exists():
        if process is not None and process.poll() is not None:
            raise AssertionError(f"worker exited before {path.name}")
        if time.monotonic() >= deadline:
            raise TimeoutError(f"worker did not reach {path.name}")
        time.sleep(0.01)


def worker(spec):
    locks = load_lock_module()
    locks._lock_directory = lambda: Path(spec["locks"])
    original_try_lock = locks._try_lock
    descriptors = set()

    def observed_try_lock(fd):
        # Observe the real descriptor/attempt; do not replace OS locking.
        descriptors.add(fd)
        Path(spec["attempt"]).touch()
        return original_try_lock(fd)

    locks._try_lock = observed_try_lock
    try:
        with locks.model_lock(tuple(spec["key"]), timeout=spec["timeout"]):
            Path(spec["acquired"]).touch()
            if spec["action"] == "hold":
                wait_file(Path(spec["release"]))
            elif spec["action"] == "body-error":
                raise ValueError("test body failure")
        status = "acquired"
    except locks.LockTimeout:
        status = "timeout"
    except ValueError as exc:
        if str(exc) != "test body failure":
            raise
        status = "body-error"
    # Check cleanup before opening the report (which could reuse a closed fd).
    closed = []
    for fd in descriptors:
        try:
            os.fstat(fd)
        except OSError as exc:
            closed.append(exc.errno == errno.EBADF)
        else:
            closed.append(False)
    Path(spec["result"]).write_text(json.dumps({
        "status": status, "descriptors_closed": bool(closed) and all(closed),
    }), encoding="utf-8")


class NativeFileLocks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.children = []
        self.addCleanup(self.stop_children)

    def stop_children(self):
        for process, _ in self.children:
            if process.poll() is None:
                process.terminate()
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate(timeout=5)

    def start(self, action="acquire", timeout=5.0, model="one"):
        name = str(len(self.children))
        spec = {field: str(self.root / f"{name}-{field}")
                for field in ("attempt", "acquired", "release", "result")}
        spec.update(locks=str(self.root / "locks"), key=[str(self.root / "models"), model],
                    action=action, timeout=timeout)
        # -I -S excludes PYTHONPATH, user site and installed native packages.
        process = subprocess.Popen(
            [sys.executable, "-I", "-S", "-B", str(Path(__file__).resolve()), "--worker", json.dumps(spec)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        item = process, spec
        self.children.append(item)
        return item

    def finish(self, item, expected="acquired"):
        process, spec = item
        stdout, stderr = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 0, (stdout, stderr))
        result = json.loads(Path(spec["result"]).read_text(encoding="utf-8"))
        self.assertEqual(result["status"], expected)
        self.assertTrue(result["descriptors_closed"], "OS lock descriptor must be closed")

    def holder(self):
        item = self.start("hold")
        wait_file(Path(item[1]["acquired"]), item[0])
        return item

    def assert_waiting(self, item):
        wait_file(Path(item[1]["attempt"]), item[0])
        time.sleep(0.05)
        self.assertIsNone(item[0].poll())
        self.assertFalse(Path(item[1]["acquired"]).exists())
        self.assertFalse(Path(item[1]["result"]).exists())

    def release(self, item):
        Path(item[1]["release"]).touch()

    def test_two_fresh_processes_serialize_and_keep_lock_file(self):
        owner = self.holder()
        names = set((self.root / "locks").iterdir())
        self.assertEqual(len(names), 1)
        contender = self.start()
        self.assert_waiting(contender)
        self.release(owner)
        self.finish(owner)
        self.finish(contender)
        self.assertEqual(set((self.root / "locks").iterdir()), names)

    def test_killed_process_releases_kernel_lock(self):
        owner = self.holder()
        names = set((self.root / "locks").iterdir())
        contender = self.start()
        self.assert_waiting(contender)
        owner[0].kill()  # Only this test's owned child; no finally runs.
        owner[0].communicate(timeout=5)
        self.finish(contender)
        self.assertEqual(set((self.root / "locks").iterdir()), names)

    def test_timeout_never_enters_body_closes_descriptor_and_recovers(self):
        owner = self.holder()
        contender = self.start(timeout=0.15)
        self.finish(contender, "timeout")
        self.assertFalse(Path(contender[1]["acquired"]).exists())
        self.assertIsNone(owner[0].poll())
        self.release(owner)
        self.finish(owner)
        self.finish(self.start())

    def test_body_exception_releases_and_closes_descriptor(self):
        self.finish(self.start("body-error"), "body-error")
        self.finish(self.start())

    def test_distinct_key_does_not_wait_for_owner(self):
        owner = self.holder()
        self.finish(self.start(model="another"))
        self.assertIsNone(owner[0].poll())
        self.release(owner)
        self.finish(owner)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--worker":
        worker(json.loads(sys.argv[2]))
    else:
        unittest.main()
