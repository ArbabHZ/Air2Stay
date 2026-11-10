"""Portable runtime/package checks: run with the project's Python environment."""
import importlib.util
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
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
                self.assertIn("Air2Stay/run_local.mjs", names)
                self.assertIn("Air2Stay/prototype/vendor/pdf.worker.min.mjs", names)
                self.assertIn("Air2Stay/prototype/vendor/JSZIP-LICENSE.txt", names)
                self.assertIn("Air2Stay/prototype/vendor/PDFJS-LICENSE.txt", names)
                for image in (
                    "event-adibf.jpg", "event-adipec.jpg", "event-f1.jpg", "event-idex.jpg",
                    "news-events.jpg", "news-flights.jpg", "news-tourism.jpg", "README.md",
                ):
                    self.assertIn("Air2Stay/prototype/images/news-events/" + image, names)
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

    def test_setup_preserves_existing_environment(self):
        with tempfile.TemporaryDirectory(prefix="air2stay-setup-") as directory:
            root = pathlib.Path(directory)
            python = launcher.project_python(root)
            python.parent.mkdir(parents=True)
            python.touch()
            marker = root / ".venv" / "keep-existing-file.txt"
            marker.write_text("Keep this environment", encoding="utf-8")
            with mock.patch.object(launcher.venv, "EnvBuilder") as builder, \
                 mock.patch.object(launcher.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as install, \
                 mock.patch.object(launcher, "check_runtime", return_value=True):
                self.assertEqual(launcher.setup_environment(root), str(python))
            builder.assert_not_called()
            self.assertEqual(marker.read_text(encoding="utf-8"), "Keep this environment")
            self.assertEqual(install.call_args.args[0][0], str(python))
            self.assertIn(str(root / "requirements.txt"), install.call_args.args[0])

    def test_news_image_missing_or_outside_supported_size_fails(self):
        with tempfile.TemporaryDirectory(prefix="air2stay-news-image-") as directory:
            root = pathlib.Path(directory)
            for name in launcher.required_assets():
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / name, target)
            picture = root / "prototype/images/news-events/event-f1.jpg"
            for size in (0, 3 * 1024 * 1024 + 1):
                with self.subTest(size=size):
                    picture.write_bytes(b"x" * size)
                    with self.assertRaisesRegex(ValueError, "News image.*event-f1.jpg"):
                        launcher.check_assets(root)
            picture.unlink()
            with self.assertRaisesRegex(ValueError, "prototype/images/news-events/event-f1.jpg"):
                launcher.check_assets(root)

    def test_failed_setup_reports_failure(self):
        with tempfile.TemporaryDirectory(prefix="air2stay-setup-failure-") as directory:
            root = pathlib.Path(directory)
            python = launcher.project_python(root)
            python.parent.mkdir(parents=True)
            python.touch()
            with mock.patch.object(launcher.subprocess, "run", return_value=subprocess.CompletedProcess([], 1)):
                with self.assertRaisesRegex(ValueError, "Dependency installation failed"):
                    launcher.setup_environment(root)

    def test_startup_preserves_arguments_with_spaces(self):
        with tempfile.TemporaryDirectory(prefix="air2stay launcher ") as directory:
            root = pathlib.Path(directory) / "Air2Stay with spaces"
            for name in launcher.required_assets():
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / name, target)
            # A tiny stand-in avoids starting a real server while exercising
            # the launcher's actual subprocess invocation and argument quoting.
            (root / "streamlit.py").write_text(
                'import json, sys\nif __name__ == "__main__":\n print("LAUNCH_ARGS=" + json.dumps(sys.argv[1:]))\n',
                encoding="utf-8",
            )
            result = subprocess.run(
                [sys.executable, str(root / "run_local.py"), "--port", "8768"],
                cwd=root, capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            marker = next(line for line in result.stdout.splitlines() if line.startswith("LAUNCH_ARGS="))
            self.assertEqual(json.loads(marker.split("=", 1)[1]), [
                "run", "app.py", "--server.address", "127.0.0.1", "--server.port", "8768",
                "--server.headless", "true",
            ])


if __name__ == "__main__":
    unittest.main()
