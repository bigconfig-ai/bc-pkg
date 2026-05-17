#!/usr/bin/env node
'use strict';

// @bigconfig/bb — bootstraps babashka + a Temurin JDK on first use, then
// forwards all arguments to `bb`. Single-file launcher, no build step.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

// Pinned, known-good versions. Overridable via env.
const DEFAULT_BB_VERSION = process.env.BB_VERSION || '1.12.196';
const DEFAULT_JDK_VERSION = process.env.JDK_VERSION || '21';

const TAG = '[@bigconfig/bb]';

function log(msg) {
  // stderr so stdout stays clean for bb's own output.
  process.stderr.write(`${TAG} ${msg}\n`);
}

// --- Platform resolution -------------------------------------------------

// Maps the host OS/arch to babashka release asset + Adoptium API parameters.
function resolvePlatform() {
  const plat = process.platform; // 'darwin' | 'linux' | 'win32'
  const arch = process.arch; // 'arm64' | 'x64'
  const exeSuffix = plat === 'win32' ? '.exe' : '';

  let bbOs;
  let jdkOs;
  let archiveExt;
  if (plat === 'darwin') {
    bbOs = 'macos';
    jdkOs = 'mac';
    archiveExt = 'tar.gz';
  } else if (plat === 'linux') {
    bbOs = 'linux';
    jdkOs = 'linux';
    archiveExt = 'tar.gz';
  } else if (plat === 'win32') {
    bbOs = 'windows';
    jdkOs = 'windows';
    archiveExt = 'zip';
  } else {
    throw new Error(`Unsupported OS: ${plat}`);
  }

  let bbArch;
  let jdkArch;
  if (arch === 'arm64') {
    bbArch = 'aarch64';
    jdkArch = 'aarch64';
  } else if (arch === 'x64') {
    bbArch = 'amd64';
    jdkArch = 'x64';
  } else {
    throw new Error(`Unsupported CPU architecture: ${arch}`);
  }

  // babashka ships only a *static* (musl) build for Linux arm64 — there is no
  // dynamic linux-aarch64 asset. The static build also runs on glibc.
  const bbArchToken =
    plat === 'linux' && arch === 'arm64' ? 'aarch64-static' : bbArch;

  if (plat === 'win32' && arch === 'arm64') {
    throw new Error('babashka has no prebuilt Windows arm64 binary');
  }

  return {
    exeSuffix,
    archiveExt,
    jdkOs,
    jdkArch,
    bbAssetName(version) {
      return `babashka-${version}-${bbOs}-${bbArchToken}.${archiveExt}`;
    },
    jdkArchiveName: `jdk.${archiveExt}`,
  };
}

function cacheRoot() {
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'bigconfig-bb');
}

// --- Filesystem helpers --------------------------------------------------

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

// Runs `install(tmpDir)` into a private temp dir, then atomically renames it
// into place. Concurrent first-runs race on the rename; the loser is discarded
// so the final dir is never left half-written.
async function installOnce(finalDir, install) {
  if (fs.existsSync(finalDir)) return;
  const tmp = `${finalDir}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(tmp, { recursive: true });
  try {
    await install(tmp);
    if (fs.existsSync(finalDir)) {
      rmrf(tmp); // another process won the race
      return;
    }
    fs.mkdirSync(path.dirname(finalDir), { recursive: true });
    try {
      fs.renameSync(tmp, finalDir);
    } catch (err) {
      if (fs.existsSync(finalDir)) {
        rmrf(tmp);
        return;
      }
      throw err;
    }
  } catch (err) {
    rmrf(tmp);
    throw err;
  }
}

async function download(url, destFile) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': '@bigconfig/bb' },
  });
  if (!res.ok || !res.body) {
    throw new Error(
      `Download failed (HTTP ${res.status} ${res.statusText})\n  ${url}`
    );
  }
  await fs.promises.mkdir(path.dirname(destFile), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destFile));
}

// Extracts .tar.gz / .zip. System `tar` (GNU on Linux, bsdtar on macOS &
// Windows 10+) auto-detects gzip and handles zip; PowerShell is a Windows
// fallback when `tar` is absent.
function extract(archive, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  let r = spawnSync('tar', ['-xf', archive, '-C', destDir], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (r.error && r.error.code === 'ENOENT') {
    if (process.platform === 'win32' && archive.endsWith('.zip')) {
      r = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destDir}' -Force`,
        ],
        { stdio: ['ignore', 'inherit', 'inherit'] }
      );
      if (r.status !== 0) {
        throw new Error(`Failed to extract ${archive} (PowerShell fallback)`);
      }
      return;
    }
    throw new Error(`'tar' not found on PATH; cannot extract ${archive}`);
  }
  if (r.status !== 0) {
    throw new Error(`Failed to extract ${archive} (tar exit ${r.status})`);
  }
}

// Locates JAVA_HOME inside an extracted JDK. Layout differs per OS
// (linux: <root>/bin/java, macOS: <root>/Contents/Home/bin/java).
function findJavaHome(root, exeSuffix) {
  const javaRel = path.join('bin', `java${exeSuffix}`);
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    if (fs.existsSync(path.join(dir, javaRel))) return dir;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) stack.push(path.join(dir, e.name));
    }
  }
  return null;
}

// --- Bootstrap steps -----------------------------------------------------

async function ensureBabashka(p) {
  const version = DEFAULT_BB_VERSION;
  const finalDir = path.join(cacheRoot(), 'bb', version);
  const bbPath = path.join(finalDir, `bb${p.exeSuffix}`);
  const asset = p.bbAssetName(version);

  await installOnce(finalDir, async (tmp) => {
    const archive = path.join(tmp, asset);
    const url = `https://github.com/babashka/babashka/releases/download/v${version}/${asset}`;
    log(`Installing babashka ${version} (set BB_VERSION to override)...`);
    try {
      await download(url, archive);
    } catch (err) {
      throw new Error(`${err.message}\n  (override with BB_VERSION=<version>)`);
    }
    extract(archive, tmp);
    fs.unlinkSync(archive);
    const exe = path.join(tmp, `bb${p.exeSuffix}`);
    if (!fs.existsSync(exe)) {
      throw new Error('babashka binary not found after extraction');
    }
    if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
  });

  if (!fs.existsSync(bbPath)) {
    throw new Error(
      `babashka cache looks corrupt; remove ${finalDir} and retry`
    );
  }
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(bbPath, 0o755);
    } catch {
      /* already executable */
    }
  }
  return bbPath;
}

async function ensureJdk(p) {
  const feature = DEFAULT_JDK_VERSION;
  const finalDir = path.join(cacheRoot(), 'jdk', feature);
  const marker = path.join(finalDir, '.javahome');

  await installOnce(finalDir, async (tmp) => {
    const archive = path.join(tmp, p.jdkArchiveName);
    const url =
      `https://api.adoptium.net/v3/binary/latest/${feature}/ga/` +
      `${p.jdkOs}/${p.jdkArch}/jdk/hotspot/normal/eclipse`;
    log(`Installing Temurin JDK ${feature} (set JDK_VERSION to override)...`);
    try {
      await download(url, archive);
    } catch (err) {
      throw new Error(`${err.message}\n  (override with JDK_VERSION=<feature>)`);
    }
    extract(archive, tmp);
    fs.unlinkSync(archive);
    const home = findJavaHome(tmp, p.exeSuffix);
    if (!home) throw new Error('could not locate java in extracted JDK');
    // Path relative to tmp stays valid after tmp is renamed to finalDir.
    fs.writeFileSync(path.join(tmp, '.javahome'), path.relative(tmp, home));
  });

  let javaHome = null;
  try {
    javaHome = path.join(finalDir, fs.readFileSync(marker, 'utf8').trim());
  } catch {
    javaHome = null;
  }
  if (
    !javaHome ||
    !fs.existsSync(path.join(javaHome, 'bin', `java${p.exeSuffix}`))
  ) {
    javaHome = findJavaHome(finalDir, p.exeSuffix);
  }
  if (!javaHome) {
    throw new Error(`JDK cache looks corrupt; remove ${finalDir} and retry`);
  }
  return javaHome;
}

// --- git (Linux only) ----------------------------------------------------

function commandWorks(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

// ENOENT sets r.error; any exit code otherwise means the binary exists.
function binExists(cmd) {
  return !spawnSync(cmd, ['--version'], { stdio: 'ignore' }).error;
}

// On Linux, install git via the system package manager if it is missing.
// Skipped when git is already on PATH; a no-op on macOS/Windows.
function ensureGit() {
  if (process.platform !== 'linux') return;
  if (commandWorks('git', ['--version'])) return;

  const isRoot =
    typeof process.getuid === 'function' && process.getuid() === 0;
  const sudo = isRoot ? [] : binExists('sudo') ? ['sudo'] : null;
  if (sudo === null) {
    throw new Error(
      'git is missing and cannot be installed: not running as root and ' +
        '`sudo` is unavailable.\n' +
        '  Install git manually (e.g. `apt-get install git`) and re-run.'
    );
  }

  // First match wins; `soft` lists step indexes allowed to fail (e.g.
  // `apt-get update`, which is non-fatal if package lists already exist).
  const managers = [
    {
      bin: 'apt-get',
      steps: [
        ['apt-get', 'update', '-y'],
        ['apt-get', 'install', '-y', 'git'],
      ],
      soft: [0],
    },
    { bin: 'dnf', steps: [['dnf', 'install', '-y', 'git']] },
    { bin: 'yum', steps: [['yum', 'install', '-y', 'git']] },
    {
      bin: 'zypper',
      steps: [['zypper', '--non-interactive', 'install', 'git']],
    },
    { bin: 'pacman', steps: [['pacman', '-S', '--noconfirm', 'git']] },
    { bin: 'apk', steps: [['apk', 'add', '--no-cache', 'git']] },
  ];
  const pm = managers.find((m) => binExists(m.bin));
  if (!pm) {
    throw new Error(
      'git is missing and no supported package manager ' +
        '(apt-get/dnf/yum/zypper/pacman/apk) was found.\n' +
        '  Install git manually and re-run.'
    );
  }

  log(`Installing git via ${pm.bin}${sudo.length ? ' (sudo)' : ''}...`);
  const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
  pm.steps.forEach((step, i) => {
    const argv = [...sudo, ...step];
    const r = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit', env });
    const ok = !r.error && r.status === 0;
    if (!ok && !(pm.soft && pm.soft.includes(i))) {
      const why = r.error ? r.error.code : `exit ${r.status}`;
      throw new Error(`git install failed: \`${argv.join(' ')}\` (${why}).`);
    }
  });

  if (!commandWorks('git', ['--version'])) {
    throw new Error('git still not available after the install attempt.');
  }
}

// --- Run bb --------------------------------------------------------------

function runBb(bbPath, args, javaHome) {
  const env = { ...process.env };
  if (javaHome) {
    env.JAVA_HOME = javaHome;
    env.PATH =
      path.join(javaHome, 'bin') +
      path.delimiter +
      (process.env.PATH || '');
  }

  const child = spawn(bbPath, args, {
    stdio: 'inherit',
    cwd: process.cwd(),
    env,
  });

  const forward = (sig) => {
    try {
      child.kill(sig);
    } catch {
      /* child already gone */
    }
  };
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);

  return new Promise((resolve) => {
    child.on('error', (err) => {
      log(`failed to start bb: ${err.message}`);
      resolve(127);
    });
    child.on('exit', (code, signal) => {
      resolve(signal ? 1 : code == null ? 1 : code);
    });
  });
}

async function main(args) {
  const p = resolvePlatform();
  const bbPath = await ensureBabashka(p);
  const javaHome = await ensureJdk(p);
  ensureGit();
  const code = await runBb(bbPath, args, javaHome);
  process.exit(code);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    log(err && err.message ? err.message : String(err));
    process.exit(1);
  });
}

// Exported for tests / inspection.
module.exports = { resolvePlatform, cacheRoot, findJavaHome, ensureGit };
