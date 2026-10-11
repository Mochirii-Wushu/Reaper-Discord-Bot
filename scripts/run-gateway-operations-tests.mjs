import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const python = process.platform === "win32" ? "py" : "python3";
const prefix = process.platform === "win32" ? ["-3"] : [];
const version = spawnSync(python, [...prefix, "-c", "import sys; raise SystemExit(sys.version_info < (3, 12))"], {
  cwd: root,
  stdio: "inherit",
});
if (version.error) throw version.error;
if (version.status !== 0) throw new Error("Gateway operations tests require Python 3.12 or newer.");
const result = spawnSync(python, [...prefix, "-B", "tests/gateway-operations.test.py"], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
