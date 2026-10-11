"""Runtime provenance for the opt-in TE10 study; never starts a solver.

The v2 identity deliberately rejects records from the earlier, native-only
identity. Preserve those records and their original source epoch unchanged;
this fingerprint upgrade does not validate or relabel any old campaign.
"""
import os
from pathlib import Path
import sys

import CSXCAD
import numpy as np
import openEMS

from tests.coax_resonator_fixture import runtime_identity as native_identity, sha


def package_identity(module):
    """Hash installed Python helpers and extension bindings, excluding caches."""
    entry = Path(module.__file__).resolve()
    if not entry.is_file():
        raise ValueError(f"{module.__name__} package source is unavailable")
    root = entry.parent
    files = sorted({path for pattern in ("*.py", "*.pyd", "*.so", "*.so.*")
                    for path in root.rglob(pattern) if path.is_file()},
                   key=lambda path: path.relative_to(root).as_posix())
    return dict(root=str(root), files={path.relative_to(root).as_posix(): sha(path) for path in files})


def runtime_identity():
    value = dict(native_identity())
    prefix = os.environ.get("OPENEMS_INSTALL_PATH")
    # These companion DLLs may not exist in a Unix installation or in a layout
    # without this optional environment setting. Absence is explicit, not omitted.
    companions = {}
    for name in ("fparser.dll", "nf2ff.dll"):
        path = Path(prefix)/name if prefix else None
        companions[name] = sha(path) if path is not None and path.is_file() else None
    value.update(protocol="uniform-te10-runtime-v2", python=sys.version,
                 executable=str(Path(sys.executable).resolve()), numpy=np.__version__,
                 csxcad_version=getattr(CSXCAD, "__version__", None),
                 python_packages={"CSXCAD": package_identity(CSXCAD),
                                  "openEMS": package_identity(openEMS)},
                 optional_native_prefix=str(Path(prefix).resolve()) if prefix else None,
                 optional_native_companions=companions)
    return value
