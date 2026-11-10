// npm entry point: prefer the project's Python environment on every platform.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const local = join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const candidates = existsSync(local)
  ? [[local, []]]
  : process.platform === "win32"
    ? [["py", ["-3"]], ["python", []], ["python3", []]]
    : [["python3", []], ["python", []]];
const runtime = candidates.find(([command, prefix]) => {
  const check = spawnSync(command, [...prefix, "-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)"], { stdio: "ignore", timeout: 5000 });
  return check.status === 0;
});
if (!runtime) {
  console.error("Python 3.12+ was not found. Install Python, then run npm run setup once.");
  process.exit(1);
}
const [python, prefix] = runtime;
const result = spawnSync(python, [...prefix, join(root, "run_local.py"), ...process.argv.slice(2)], { cwd: root, stdio: "inherit" });
if (result.error) console.error("Air2Stay could not start:", result.error.message);
process.exit(result.status ?? 1);
