"""Check, package or start the local Air2Stay demo; no network access required."""
import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent
REQUIRED = (
    "app.py", "run_local.py", "run_prototype.ps1", "package.json",
    "requirements.txt", "README.md", ".streamlit/config.toml", ".env.example",
    "prototype/index.html", "prototype/styles.css", "prototype/app.mjs",
    "prototype/engine.mjs", "prototype/route_planning.mjs",
    "prototype/decision_tools.mjs", "prototype/conversion_evidence.mjs",
    "prototype/data/scenario_data.json", "prototype/data/country_locations.json",
    "prototype/data/admin0-countries.svg",
    "prototype/proposal_workspace.css", "prototype/guided_help.css",
    "prototype/help/data-dictionary.html", "prototype/help/usage-and-data.html",
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
    scenario = json.loads((root / "prototype/data/scenario_data.json").read_text(encoding="utf-8"))
    locations = json.loads((root / "prototype/data/country_locations.json").read_text(encoding="utf-8"))
    if not scenario.get("routes") or len(scenario.get("months", [])) != 12:
        raise ValueError("The bundled scenario data is empty or incomplete.")
    if not locations.get("countries"):
        raise ValueError("The country-location reference is empty or incomplete.")
    return assets


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--check", action="store_true", help="Check required files and installed runtime without starting a server")
    action.add_argument("--package", metavar="ZIP", help="Create a complete demo ZIP, excluding keys, environments and raw competition workbooks")
    parser.add_argument("--port", type=int, default=8765, help="Local server port (default: 8765)")
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("Choose a port between 1 and 65535.")
    try:
        assets = check_assets()
        if args.package:
            target = pathlib.Path(args.package).expanduser().resolve()
            if target.suffix.lower() != ".zip":
                raise ValueError("Choose a ZIP filename for the demo package.")
            with zipfile.ZipFile(target, "x", zipfile.ZIP_DEFLATED) as archive:
                for name in assets:
                    archive.write(ROOT / name, "Air2Stay/" + name)
            print(f"Created {target} with {len(assets)} required files. No API key, .venv or raw workbooks included.")
            return 0
        project_python = ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        python = str(project_python) if project_python.is_file() else sys.executable
        probe = subprocess.run([python, "-c", "import streamlit, certifi"], capture_output=True)
        if probe.returncode:
            print("Air2Stay's Python packages are not installed in the selected environment.\n"
                  f'Run: "{python}" -m pip install -r "{ROOT / "requirements.txt"}"\n'
                  "Then run this launcher again.", file=sys.stderr)
            return 1
        if args.check:
            print(f"PASS: {len(assets)} required files, scenario data, country locations, and Python runtime are ready.")
            return 0
        os.chdir(ROOT)
        os.execv(python, [python, "-m", "streamlit", "run", "app.py", "--server.address", "127.0.0.1", "--server.port", str(args.port), "--server.headless", "true"])
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        print("Air2Stay could not start: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
