"""Portable runtime/package checks: run with the project's Python environment."""
import importlib.util
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("launcher", ROOT / "run_local.py")
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class FreshCopyTests(unittest.TestCase):
    def test_package_and_fresh_copy(self):
        with tempfile.TemporaryDirectory(prefix="air2stay-package-") as directory:
            target = pathlib.Path(directory) / "demo.zip"
            result = subprocess.run([sys.executable, str(ROOT / "run_local.py"), "--package", str(target)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            with zipfile.ZipFile(target) as archive:
                names = archive.namelist()
                self.assertIn("Air2Stay/prototype/data/country_locations.json", names)
                self.assertIn("Air2Stay/.env.example", names)
                self.assertFalse(any(name.endswith("/.env") or "/.venv/" in name or name.endswith(".xlsx") for name in names))
                archive.extractall(directory)
            fresh = pathlib.Path(directory) / "Air2Stay"
            self.assertFalse((fresh / ".venv").exists())
            result = subprocess.run([sys.executable, str(fresh / "run_local.py"), "--check"], cwd=directory, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("PASS:", result.stdout)
            # A malformed copy must fail before a server starts and name its missing file.
            (fresh / "prototype/data/country_locations.json").unlink()
            result = subprocess.run([sys.executable, str(fresh / "run_local.py"), "--check"], cwd=directory, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("prototype/data/country_locations.json", result.stderr)

    def test_new_local_import_is_required(self):
        with tempfile.TemporaryDirectory(prefix="air2stay-import-") as directory:
            root = pathlib.Path(directory)
            for name in launcher.required_assets():
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / name, target)
            with (root / "prototype/app.mjs").open("a", encoding="utf-8") as source:
                source.write('\nimport { example } from "./required_future_helper.mjs";\n')
            with self.assertRaisesRegex(ValueError, "required_future_helper.mjs"):
                launcher.check_assets(root)


if __name__ == "__main__":
    unittest.main()
