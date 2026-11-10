"""Set up, check, package or start Air2Stay. Only setup needs internet access."""
import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
import venv
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent
RUNTIME_MODULES = ("streamlit", "certifi", "numpy", "pandas", "openpyxl", "altair")
NEWS_IMAGE_FILES = (
    "event-adibf.jpg", "event-adipec.jpg", "event-f1.jpg", "event-idex.jpg",
    "news-events.jpg", "news-flights.jpg", "news-tourism.jpg",
)
NEWS_IMAGE_DIR = "prototype/images/news-events/"
NEWS_IMAGE_MAX_BYTES = 3 * 1024 * 1024
REQUIRED = (
    "app.py", "run_local.py", "run_local.mjs", "run_prototype.ps1", "package.json",
    "requirements.txt", "README.md", ".streamlit/config.toml", ".env.example",
    "prototype/index.html", "prototype/styles.css", "prototype/app.mjs",
    "prototype/engine.mjs", "prototype/route_planning.mjs",
    "prototype/decision_tools.mjs", "prototype/conversion_evidence.mjs",
    "prototype/data/scenario_data.json", "prototype/data/country_locations.json",
    "prototype/data/admin0-countries.svg",
    "prototype/proposal_workspace.css", "prototype/guided_help.css",
    "prototype/import_workspace.css",
    "prototype/vendor/jszip.min.js", "prototype/vendor/pdf.min.mjs",
    "prototype/vendor/pdf.worker.min.mjs", "prototype/vendor/JSZIP-LICENSE.txt",
    "prototype/vendor/PDFJS-LICENSE.txt", "prototype/vendor/README.txt",
    "prototype/help/data-dictionary.html", "prototype/help/usage-and-data.html",
    "prototype/images/news-events/README.md",
    *(NEWS_IMAGE_DIR + name for name in NEWS_IMAGE_FILES),
)


def required_assets(root=ROOT):
    """Include imported helper modules too, so later helpers cannot be omitted."""
    assets = set(REQUIRED)
    pending = [name for name in assets if name.endswith(".mjs")]
    while pending:
        name = pending.pop()
        source = root / name
        if not source.is_file():
            continue
        for relative in re.findall(r'from\s*["\'](\.[^"\']+\.mjs)["\']', source.read_text(encoding="utf-8")):
            imported = (source.parent / relative).resolve()
            try:
                asset = imported.relative_to(root.resolve()).as_posix()
            except ValueError:
                raise ValueError("A local module points outside the project: " + name)
            if asset not in assets:
                assets.add(asset)
                pending.append(asset)
    return sorted(assets)


def check_assets(root=ROOT):
    assets = required_assets(root)
    missing = [name for name in assets if not (root / name).is_file()]
    if missing:
        raise ValueError("This copy is incomplete. Restore these files from the full project or demo ZIP:\n  " + "\n  ".join(missing))
    for name in NEWS_IMAGE_FILES:
        image = root / (NEWS_IMAGE_DIR + name)
        if not 0 < image.stat().st_size <= NEWS_IMAGE_MAX_BYTES:
            raise ValueError("News image must be non-empty and no larger than 3 MB: " + NEWS_IMAGE_DIR + name)
    scenario = json.loads((root / "prototype/data/scenario_data.json").read_text(encoding="utf-8"))
    locations = json.loads((root / "prototype/data/country_locations.json").read_text(encoding="utf-8"))
    if not scenario.get("routes") or len(scenario.get("months", [])) != 12:
        raise ValueError("The bundled scenario data is empty or incomplete.")
    if not locations.get("countries"):
        raise ValueError("The country-location reference is empty or incomplete.")
    return assets


def project_python(root=ROOT):
    return root / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def selected_python(root=ROOT):
    local = project_python(root)
    return str(local) if local.is_file() else sys.executable


def check_runtime(python):
    probe = subprocess.run(
        [python, "-c", "import importlib; "
         + "; ".join(f"importlib.import_module({name!r})" for name in RUNTIME_MODULES)],
        capture_output=True, text=True,
    )
    return probe.returncode == 0


def setup_environment(root=ROOT):
    """Install the pinned dependencies into this project's isolated environment."""
    if sys.version_info < (3, 12):
        raise ValueError("Python 3.12 or newer is required to set up Air2Stay.")
    python = project_python(root)
    if not python.is_file():
        print("Creating Air2Stay's isolated .venv environment...", flush=True)
        venv.EnvBuilder(with_pip=True).create(root / ".venv")
    print("Installing the project requirements into .venv...", flush=True)
    result = subprocess.run([
        str(python), "-m", "pip", "install", "--disable-pip-version-check",
        "-r", str(root / "requirements.txt"),
    ])
    if result.returncode:
        raise ValueError("Dependency installation failed. Check the message above and your internet connection, then run --setup again.")
    if not check_runtime(str(python)):
        raise ValueError("The environment was created, but a required package could not be imported. Run --setup again to repair it.")
    return str(python)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--setup", action="store_true", help="Create .venv and install pinned dependencies (requires internet)")
    action.add_argument("--check", action="store_true", help="Check required files and installed runtime without starting a server")
    action.add_argument("--package", metavar="ZIP", help="Create a complete demo ZIP, excluding keys, environments and raw competition workbooks")
    parser.add_argument("--port", type=int, default=8765, help="Local server port (default: 8765)")
    parser.add_argument("--gemini-drafts", action="store_true", help="Enable optional Gemini drafting in the local app")
    parser.add_argument("--gemini-env-file", type=pathlib.Path, help="Use an existing local .env file with --gemini-drafts")
    args = parser.parse_args(argv)
    if args.gemini_env_file and not args.gemini_drafts:
        parser.error("--gemini-env-file requires --gemini-drafts")
    if args.gemini_drafts and (args.check or args.package or args.setup):
        parser.error("--gemini-drafts is only used when starting the local app")
    if args.gemini_env_file and not args.gemini_env_file.expanduser().is_file():
        parser.error("The specified Gemini .env file does not exist")
    if not 1 <= args.port <= 65535:
        parser.error("Choose a port between 1 and 65535.")
    try:
        assets = check_assets()
        if args.setup:
            python = setup_environment()
            print(f'PASS: Air2Stay is ready. Run "{python}" "{ROOT / "run_local.py"}" to start.')
            return 0
        if args.package:
            target = pathlib.Path(args.package).expanduser().resolve()
            if target.suffix.lower() != ".zip":
                raise ValueError("Choose a ZIP filename for the demo package.")
            with zipfile.ZipFile(target, "x", zipfile.ZIP_DEFLATED) as archive:
                for name in assets:
                    archive.write(ROOT / name, "Air2Stay/" + name)
            print(f"Created {target} with {len(assets)} required files. No API key, .venv or raw workbooks included.")
            return 0
        python = selected_python()
        if not check_runtime(python):
            print("Air2Stay's Python packages are not installed in the selected environment.\n"
                  f'Run: "{sys.executable}" "{ROOT / "run_local.py"}" --setup\n'
                  "Then run this launcher again.", file=sys.stderr)
            return 1
        if args.check:
            print(f"PASS: {len(assets)} required files, scenario data, country locations, and Python runtime are ready.")
            return 0
        os.environ.pop("AIR2STAY_LOCAL_GEMINI_PORT", None)
        os.environ.pop("AIR2STAY_LOCAL_GEMINI_ENV_FILE", None)
        if args.gemini_drafts:
            os.environ["AIR2STAY_LOCAL_GEMINI_PORT"] = str(args.port)
            if args.gemini_env_file:
                os.environ["AIR2STAY_LOCAL_GEMINI_ENV_FILE"] = str(args.gemini_env_file.expanduser().resolve())
        os.chdir(ROOT)
        # subprocess applies Windows argument quoting; os.execv can split a
        # virtual-environment path containing spaces, such as this project's.
        return subprocess.run([
            python, "-m", "streamlit", "run", "app.py", "--server.address", "127.0.0.1",
            "--server.port", str(args.port), "--server.headless", "true",
        ]).returncode
    except KeyboardInterrupt:
        return 130
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        print("Air2Stay could not start: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
