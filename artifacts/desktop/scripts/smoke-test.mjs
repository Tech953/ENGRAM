// Post-package smoke test: confirm the *installed* desktop app actually launches,
// not just that an installer was produced.
//
// The desktop CI pipeline proves an installer can be built on each OS, but a
// green build can still ship a binary that crashes on first run — most notably
// the documented electron-builder gotcha where @electric-sql/pglite's
// pglite.wasm/pglite.data get stripped from extraResources, or a bad
// migrations/seed path. This script closes that gap by:
//
//   1. Asserting the packaged pglite assets (pglite.wasm + pglite.data) are
//      present next to the server bundle in the unpacked output.
//   2. Launching the freshly built, packaged Electron app (the unpacked output
//      under dist/ or release/) via Playwright's Electron driver — the real binary, real
//      bundled server child, real bundled resources.
//   3. Asserting the embedded server reaches /api/healthz and the dashboard
//      actually renders in the app window.
//
// A genuine runtime break (missing wasm, failed migrate/seed) means the embedded
// server never becomes healthy, so the app window never opens / healthz never
// returns 200 and this script exits non-zero, failing the job.

import { _electron as electron } from "playwright-core";
import { existsSync, readdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.join(here, ".."); // artifacts/desktop

// Prefer dist (current electron-builder config), but support legacy release.
const outputDirs = [path.join(desktopDir, "dist"), path.join(desktopDir, "release")];

const LAUNCH_TIMEOUT_MS = 120_000;
const RENDER_TIMEOUT_MS = 60_000;
const WATCHDOG_MS = 180_000;

function log(msg) {
  console.log(`[smoke] ${msg}`);
}

function fail(msg) {
  console.error(`[smoke] FAIL: ${msg}`);
  process.exit(1);
}

// Hard backstop so a hung launch (e.g. a blocking native error dialog on a
// failed startup) can never wedge the CI job indefinitely.
const watchdog = setTimeout(() => {
  fail(`smoke test exceeded ${WATCHDOG_MS}ms without completing`);
}, WATCHDOG_MS);
watchdog.unref();

function findOutputRoot() {
  for (const dir of outputDirs) {
    if (existsSync(dir)) return dir;
  }
  fail(`no packaged output directory found (checked: ${outputDirs.join(", ")})`);
}

// ---------------------------------------------------------------------------
// Locate the unpacked app output for this platform. electron-builder leaves an
// unpacked dir next to the installers; using it needs no extraction.
// ---------------------------------------------------------------------------
function locate() {
  const platform = process.platform;
  const outputRoot = findOutputRoot();

  // Find the actual executable in a dir, falling back to a name scan since the
  // executableName (electron-builder.yml) drives the basename.
  const pickExe = (dir, preferred) => {
    const direct = path.join(dir, preferred);
    if (existsSync(direct)) return direct;
    return null;
  };

  if (platform === "linux") {
    const dir = path.join(outputRoot, "linux-unpacked");
    return { outputRoot, dir, exe: pickExe(dir, "engram"), resources: path.join(dir, "resources") };
  }
  if (platform === "win32") {
    const dir = path.join(outputRoot, "win-unpacked");
    return { outputRoot, dir, exe: pickExe(dir, "engram.exe"), resources: path.join(dir, "resources") };
  }
  if (platform === "darwin") {
    const macDir = readdirSync(outputRoot).find((d) => d.startsWith("mac"));
    if (!macDir) fail(`no mac* output directory under ${outputRoot}`);
    const appDir = path.join(outputRoot, macDir, "ENGRAM.app");
    const macOsDir = path.join(appDir, "Contents", "MacOS");
    let exe = pickExe(macOsDir, "engram");
    if (!exe && existsSync(macOsDir)) {
      const found = readdirSync(macOsDir)[0];
      exe = found ? path.join(macOsDir, found) : null;
    }
    return { outputRoot, dir: appDir, exe, resources: path.join(appDir, "Contents", "Resources") };
  }
  return fail(`unsupported platform: ${platform}`);
}

const { outputRoot, dir, exe, resources } = locate();

if (!exe || !existsSync(exe)) {
  fail(`packaged executable not found (looked under ${dir}, output root: ${outputRoot}). Did packaging run?`);
}
log(`packaged output root: ${outputRoot}`);
log(`packaged app: ${exe}`);

// ---------------------------------------------------------------------------
// 1. PGlite assets must ship next to the server bundle, or the embedded DB
//    can't open and the server crashes on boot.
// ---------------------------------------------------------------------------
const pgliteDist = path.join(
  resources,
  "server",
  "node_modules",
  "@electric-sql",
  "pglite",
  "dist",
);
for (const asset of ["pglite.wasm", "pglite.data"]) {
  const p = path.join(pgliteDist, asset);
  if (!existsSync(p)) {
    fail(
      `packaged pglite asset missing: ${p}\n` +
        "  -> electron-builder likely stripped node_modules from extraResources " +
        "(see the desktop packaging gotcha in replit.md).",
    );
  }
}
log("pglite.wasm + pglite.data present next to the server bundle");

// ---------------------------------------------------------------------------
// 2 + 3. Launch the packaged app and assert it actually comes up.
// ---------------------------------------------------------------------------
async function main() {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), "engram-smoke-"));
  const args = [`--user-data-dir=${userDataDir}`];
  // CI Linux runs under xvfb as a privileged user with no GPU; these switches
  // keep Electron from refusing to start. They are no-ops on the runtime paths
  // this test exercises (embedded server + dashboard render).
  if (process.platform === "linux") {
    args.push("--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage");
  }

  log("launching packaged app…");
  const app = await electron.launch({
    executablePath: exe,
    args,
    timeout: LAUNCH_TIMEOUT_MS,
  });

  try {
    // The main window only opens after the embedded server becomes healthy
    // (startServer awaits waitForHealth before createMainWindow). If migrations,
    // seed, or pglite are broken, the server never goes healthy and no window
    // appears -> firstWindow times out -> this throws -> job fails.
    const window = await app.firstWindow({ timeout: LAUNCH_TIMEOUT_MS });
    await window.waitForLoadState("domcontentloaded");

    const url = window.url();
    if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) {
      throw new Error(`unexpected window URL (expected loopback): ${url}`);
    }
    log(`window loaded: ${url}`);

    // Dashboard actually rendered: React mounted content into #root.
    await window.waitForFunction(
      () => {
        const root = document.querySelector("#root");
        return !!root && root.children.length > 0;
      },
      undefined,
      { timeout: RENDER_TIMEOUT_MS },
    );
    log("dashboard rendered (#root has content)");

    // Embedded server is healthy, checked same-origin from the running app.
    const health = await window.evaluate(async () => {
      const res = await fetch("/api/healthz");
      return { status: res.status, body: await res.text() };
    });
    if (health.status !== 200) {
      throw new Error(
        `/api/healthz returned ${health.status} (body: ${health.body})`,
      );
    }
    log("/api/healthz -> 200 OK");

    log("PASS: packaged app launches, server is healthy, dashboard loads");
  } finally {
    try {
      await app.close();
    } catch {
      const proc = app.process();
      if (proc && !proc.killed) proc.kill("SIGKILL");
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => fail(String(error?.stack ?? error)));