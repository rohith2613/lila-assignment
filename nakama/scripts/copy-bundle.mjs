// ---------------------------------------------------------------------------
// Copy the rollup output (build/index.js) into data/modules/index.js so the
// Nakama container can load it. Nakama looks for runtime modules under the
// directory configured by `runtime.path` in local.yml — by default this is
// `/nakama/data/modules`. We bind-mount `nakama/data` from the host into
// the container so the same path is used in dev and in CI.
//
// We do this with a tiny Node script (instead of a shell command in npm
// scripts) so the build works the same on Windows, macOS and Linux without
// needing cp or robocopy.
// ---------------------------------------------------------------------------
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const src = resolve(repoRoot, "build", "index.js");
const destDir = resolve(repoRoot, "data", "modules");
const dest = resolve(destDir, "index.js");

if (!existsSync(src)) {
  console.error(`[copy-bundle] source not found: ${src}`);
  console.error(`[copy-bundle] did rollup run successfully?`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`[copy-bundle] ${src} -> ${dest}`);
