"""Advisory locks for cooperating model-file writers owned by the same OS user.

Lock files are permanent names, not leases: never unlink one after unlocking.
Replacing/deleting a lock file can give two processes different locked inodes.
The OS releases the actual lock when its descriptor closes or its process exits.
"""
from __future__ import annotations

import errno
import hashlib
import json
import os
import stat
import time
from contextlib import contextmanager
from pathlib import Path

if os.name == "nt":
    import msvcrt
else:
    import fcntl


class LockTimeout(TimeoutError):
    pass


def _lock_directory() -> Path:
    # Independent of workspace write permissions, current directory, and server
    # port. Do not use process-specific temporary directories for shared locks.
    return Path.home() / ".fairbeam" / "model-locks"


def _try_lock(fd: int) -> None:
    if os.name == "nt":
        os.lseek(fd, 0, os.SEEK_SET)
        # Windows permits a byte-range lock beyond EOF (the files stay empty).
        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
    else:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)


def _unlock(fd: int) -> None:
    if os.name == "nt":
        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    else:
        fcntl.flock(fd, fcntl.LOCK_UN)


@contextmanager
def model_lock(key: tuple[str, str], timeout: float = 30.0):
    """Acquire a process lock; caller supplies reentrancy and canonical identity.

    Errors fail closed. Only contention is retried; a missing/unwritable lock
    directory must never silently reduce this to process-local protection.
    """
    directory = _lock_directory()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if directory.is_symlink():
        raise OSError("model lock directory must not be a symbolic link")
    name = hashlib.sha256(json.dumps(key, ensure_ascii=True).encode("utf-8")).hexdigest()
    path = directory / (name + ".lock")
    if path.is_symlink():
        raise OSError("model lock file must not be a symbolic link")
    flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    fd = os.open(path, flags, 0o600)
    locked = False
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise OSError("model lock file must be a regular file")
        deadline = time.monotonic() + timeout
        while True:
            try:
                _try_lock(fd)
                locked = True
                break
            except OSError as exc:
                if exc.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                    raise
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise LockTimeout("another process is using this model; retry shortly") from exc
                time.sleep(min(0.05, remaining))
        yield
    finally:
        try:
            if locked:
                _unlock(fd)
        finally:
            os.close(fd)
