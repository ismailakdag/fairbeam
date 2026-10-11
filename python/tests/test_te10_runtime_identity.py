"""Mutate disposable runtime fixtures only; no installed libraries or solver calls."""
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from tests import te10_runtime_identity as identity


class RuntimeIdentity(unittest.TestCase):
    def test_processing_and_csxcad_changes_invalidate_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            modules = {}
            for name in ("openEMS", "CSXCAD"):
                folder = root/name
                folder.mkdir()
                (folder/"__init__.py").write_text("# package\n")
                modules[name] = SimpleNamespace(__file__=str(folder/"__init__.py"), __name__=name)
            files = (root/"openEMS/ports.py", root/"openEMS/utilities.py",
                     root/"CSXCAD/CSProperties.pyd", root/"CSXCAD/SmoothMeshLines.py")
            for file in files:
                file.write_bytes(b"original")
            with patch.object(identity, "openEMS", modules["openEMS"]), \
                    patch.object(identity, "CSXCAD", modules["CSXCAD"]), \
                    patch.object(identity, "native_identity", return_value={"binding_version": "fixture", "files": {}}), \
                    patch.dict(identity.os.environ, {"OPENEMS_INSTALL_PATH": str(root)}):
                baseline = identity.runtime_identity()
                self.assertEqual(baseline["protocol"], "uniform-te10-runtime-v2")
                self.assertEqual(baseline["optional_native_companions"], {"fparser.dll": None, "nf2ff.dll": None})
                self.assertIsNone(baseline["csxcad_version"])
                for file in files:
                    with self.subTest(file=file.name):
                        file.write_bytes(b"changed")
                        self.assertNotEqual(identity.runtime_identity(), baseline)
                        file.write_bytes(b"original")
                        self.assertEqual(identity.runtime_identity(), baseline)
                (root/"fparser.dll").write_bytes(b"new companion")
                self.assertNotEqual(identity.runtime_identity(), baseline)
                (root/"fparser.dll").unlink()
                # Generated caches and iteration order must not invalidate a run.
                cache = root/"openEMS/__pycache__"
                cache.mkdir()
                (cache/"ports.pyc").write_bytes(b"cache")
                self.assertEqual(identity.runtime_identity(), baseline)
                self.assertEqual(json.dumps(identity.runtime_identity()), json.dumps(baseline))
                for package in baseline["python_packages"].values():
                    self.assertEqual(list(package["files"]), sorted(package["files"]))
                with patch.object(identity.np, "__version__", "different"):
                    self.assertNotEqual(identity.runtime_identity(), baseline)
                with patch.object(identity.sys, "version", "different"):
                    self.assertNotEqual(identity.runtime_identity(), baseline)
                files[0].unlink()
                self.assertNotEqual(identity.runtime_identity(), baseline)

    def test_missing_required_package_source_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = SimpleNamespace(__file__=str(Path(directory)/"missing.py"), __name__="fixture")
            with self.assertRaisesRegex(ValueError, "source is unavailable"):
                identity.package_identity(missing)

    def test_reader_rejects_legacy_epoch_without_rewriting_it(self):
        from tests import test_uniform_te10_reference as study
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            port = root/"case0/port1"
            port.mkdir(parents=True)
            record = port/"report.json"
            legacy = {"binding_version": "fixture", "files": {}}
            record.write_text(json.dumps({"source_sha256": {}, "runtime": legacy}))
            original = record.read_bytes()
            with patch.object(study, "build", return_value=(None, {})), \
                    patch.object(study, "identity", return_value={}), \
                    patch.object(study, "runtime_identity", return_value={**legacy, "protocol": "uniform-te10-runtime-v2"}):
                with self.assertRaisesRegex(ValueError, "source or runtime"):
                    study.read_case(root, 0)
            self.assertEqual(record.read_bytes(), original)
            self.assertEqual(list(port.iterdir()), [record])


if __name__ == "__main__":
    unittest.main()
