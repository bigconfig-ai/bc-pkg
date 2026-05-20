#!/usr/bin/env node
'use strict';

// bc-pkg — bootstraps babashka + a Temurin JDK on first use, then
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
const REWRITE_EDN_VERSION = process.env.REWRITE_EDN_VERSION || '0.5.9';

const TAG = '[bc-pkg]';

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
  return path.join(base, 'bc-pkg');
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
    headers: { 'user-agent': 'bc-pkg' },
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

// --- bb.edn bootstrap ----------------------------------------------------

// Env augmented so spawned processes find the cached JDK and bb; nothing system-wide.
function bbEnv(javaHome, bbPath, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  const pathEntries = [];
  if (javaHome) {
    env.JAVA_HOME = javaHome;
    pathEntries.push(path.join(javaHome, 'bin'));
  }
  if (bbPath) {
    pathEntries.push(path.dirname(bbPath));
  }
  if (pathEntries.length) {
    env.PATH = pathEntries.join(path.delimiter) + path.delimiter + (env.PATH || '');
  }
  return env;
}

function ghFetch(url, accept) {
  const headers = {
    'user-agent': 'bc-pkg',
    accept: accept || 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return fetch(url, { headers, redirect: 'follow' });
}

// Reads/edits the EDN with borkdude/rewrite-edn so comments & formatting of
// untouched nodes survive. Params are passed via env to avoid quoting issues.
const REWRITE_SCRIPT = `(require '[babashka.deps :as deps])
(deps/add-deps {:deps {'borkdude/rewrite-edn {:mvn/version (System/getenv "BBEDN_REWRITE_VERSION")}}})
(require '[borkdude.rewrite-edn :as r])

(defn fail! [msg]
  (binding [*out* *err*]
    (println msg))
  (System/exit 1))

(defn local-root? [coord]
  (and (map? coord) (contains? coord :local/root)))

;; Drop every entry whose effective coord (sexpr respects #_ discard) is a
;; map containing :local/root. Returns the (possibly unchanged) map node.
(defn strip-local-root [m-node]
  (if (nil? m-node)
    m-node
    (let [m (r/sexpr m-node)]
      (reduce (fn [acc k]
                (if (local-root? (get m k)) (r/dissoc acc k) acc))
              m-node
              (keys m)))))

(let [in    (System/getenv "BBEDN_IN")
      out   (System/getenv "BBEDN_OUT")
      owner (System/getenv "BBEDN_OWNER")
      proj  (System/getenv "BBEDN_PROJECT")
      sha   (System/getenv "BBEDN_SHA")
      repo  (System/getenv "BBEDN_REPO")
      dep   (symbol (str "io.github." owner) proj)
      nodes (r/parse-string (slurp in))
      data  (r/sexpr nodes)
      existing-repo (if (and (map? data) (contains? data :repo))
                      (:repo data)
                      ::missing)
      _validate-map (when-not (map? data)
                      (fail! "Downloaded bb.edn must contain a top-level EDN map"))
      _validate-repo (when (and (not= ::missing existing-repo)
                                (not= existing-repo repo))
                       (fail! (str "Downloaded bb.edn :repo " (pr-str existing-repo)
                                   " does not match CLI repo " (pr-str repo))))
      nodes (if (= ::missing existing-repo) (r/assoc nodes :repo repo) nodes)
      ;; 1. strip :local/root from top-level :deps
      nodes (if (r/get nodes :deps)
              (r/update nodes :deps strip-local-root)
              nodes)
      ;; 2. strip :local/root from each task's :extra-deps
      tasks (some-> (r/get nodes :tasks) r/sexpr)
      nodes (reduce (fn [acc tk]
                      (let [tv (get tasks tk)]
                        (if (and (map? tv) (map? (:extra-deps tv)))
                          (r/update-in acc [:tasks tk :extra-deps] strip-local-root)
                          acc)))
                    nodes
                    (keys tasks))
      ;; 3. ensure :deps exists, then inject the repo as a git dep
      nodes (if (nil? (r/get nodes :deps)) (r/assoc nodes :deps {}) nodes)
      nodes (r/assoc-in nodes [:deps dep] {:git/sha sha})]
  (spit out (str nodes)))
`;

const VALIDATE_REPO_SCRIPT = `(require '[clojure.edn :as edn])

(defn fail! [msg]
  (binding [*out* *err*]
    (println msg))
  (System/exit 1))

(let [target    (System/getenv "BBEDN_TARGET")
      cli-repo  (System/getenv "BBEDN_REPO")
      data      (try
                  (edn/read-string (slurp target))
                  (catch Exception e
                    (fail! (str "Invalid bb.edn: " (.getMessage e)))))
      has-repo? (and (map? data) (contains? data :repo))
      file-repo (when has-repo? (:repo data))]
  (when-not (map? data)
    (fail! "Invalid bb.edn: expected top-level EDN map"))
  (when-not has-repo?
    (fail! (str "bb.edn exists but does not contain :repo; omit the CLI repo or add :repo "
                (pr-str cli-repo))))
  (when-not (= file-repo cli-repo)
    (fail! (str "bb.edn :repo " (pr-str file-repo)
                " does not match CLI repo " (pr-str cli-repo)))))
`;

// Regex for the "owner/project" slug shape. Anchored, no slashes/spaces/@
// inside either segment. When present as the first argument, it is consumed as
// repo identity and never forwarded to bb.
const REPO_SLUG_RE = /^([^/\s@]+)\/([^/\s@]+)$/;

function validateBbEdnRepo(bbPath, javaHome, target, repo) {
  const targetPath = path.resolve(target);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-edn-validate-'));
  try {
    const script = path.join(tmp, 'validate-repo.clj');
    fs.writeFileSync(script, VALIDATE_REPO_SCRIPT);
    const r = spawnSync(bbPath, [script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      cwd: tmp,
      env: bbEnv(javaHome, bbPath, {
        BBEDN_TARGET: targetPath,
        BBEDN_REPO: repo,
      }),
    });
    if (r.error || r.status !== 0) {
      const details = [r.stderr, r.stdout]
        .filter(Boolean)
        .map((s) => s.trim())
        .filter(Boolean)
        .join('\n');
      const why = r.error ? r.error.message : `exit ${r.status}`;
      throw new Error(details || `bb.edn repo validation failed (${why})`);
    }
  } finally {
    rmrf(tmp);
  }
}

// If bb.edn exists and a CLI repo was provided, validate its top-level :repo.
// Otherwise, when cwd has no bb.edn and `repo` is "owner/project", fetch that
// repo's bb.edn (pinned to its default-branch HEAD), inject top-level :repo,
// and add the repo itself as an io.github git dep.
async function ensureBbEdn(bbPath, javaHome, repo) {
  let owner = null;
  let project = null;
  let slug = null;
  if (repo) {
    const m = repo.match(REPO_SLUG_RE);
    if (!m) {
      throw new Error(`repo must be "owner/project" (got "${repo}")`);
    }
    owner = m[1];
    project = m[2];
    slug = `${owner}/${project}`;
  }

  const target = path.join(process.cwd(), 'bb.edn');
  if (fs.existsSync(target)) {
    if (repo) validateBbEdnRepo(bbPath, javaHome, target, slug);
    return null;
  }
  if (!repo) return null; // step disabled — proceed straight to bb

  const api = `https://api.github.com/repos/${owner}/${project}`;

  const cr = await ghFetch(`${api}/commits?per_page=1`);
  if (cr.status === 404) {
    throw new Error(
      `${slug} not found or not accessible ` +
        `(set GITHUB_TOKEN for private repos)`
    );
  }
  if (!cr.ok) {
    throw new Error(`GitHub API error ${cr.status} resolving ${slug}`);
  }
  const commits = await cr.json();
  const sha = Array.isArray(commits) && commits[0] && commits[0].sha;
  if (!sha) throw new Error(`${slug} has no commits`);

  const fr = await ghFetch(
    `${api}/contents/bb.edn?ref=${sha}`,
    'application/vnd.github.raw'
  );
  if (fr.status === 404) {
    throw new Error(`${slug} (at ${sha.slice(0, 7)}) has no bb.edn`);
  }
  if (!fr.ok) {
    throw new Error(`GitHub API error ${fr.status} fetching bb.edn from ${slug}`);
  }
  const ednText = await fr.text();

  log(`Bootstrapping bb.edn from ${slug}@${sha.slice(0, 7)}...`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-edn-'));
  try {
    const inFile = path.join(tmp, 'in.edn');
    const script = path.join(tmp, 'rewrite.clj');
    fs.writeFileSync(inFile, ednText);
    fs.writeFileSync(script, REWRITE_SCRIPT);
    const env = bbEnv(javaHome, bbPath);
    Object.assign(env, {
      BBEDN_IN: inFile,
      BBEDN_OUT: target,
      BBEDN_OWNER: owner,
      BBEDN_PROJECT: project,
      BBEDN_REPO: slug,
      BBEDN_SHA: sha,
      BBEDN_REWRITE_VERSION: REWRITE_EDN_VERSION,
    });
    const r = spawnSync(bbPath, [script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      cwd: tmp,
      env,
    });
    if (r.error || r.status !== 0) {
      const details = [r.stderr, r.stdout]
        .filter(Boolean)
        .map((s) => s.trim())
        .filter(Boolean)
        .join('\n');
      const why = r.error ? r.error.message : `exit ${r.status}`;
      throw new Error(
        details || `failed to write bb.edn via rewrite-edn (${why})`
      );
    }
    if (!fs.existsSync(target)) {
      throw new Error('rewrite-edn step did not produce a bb.edn');
    }
    return { owner, project, sha };
  } finally {
    rmrf(tmp);
  }
}

// --- Run bb --------------------------------------------------------------

function runBb(bbPath, args, javaHome, extraEnv = {}) {
  const env = bbEnv(javaHome, bbPath, extraEnv);

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
  // Consume the first positional argument as repo identity whenever it has
  // the shape "owner/project". It is never forwarded to bb: with no bb.edn it
  // bootstraps one, and with an existing bb.edn it validates top-level :repo.
  let repo = null;
  if (args.length && REPO_SLUG_RE.test(args[0])) {
    repo = args[0];
    args = args.slice(1);
  }
  const bbPath = await ensureBabashka(p);
  const javaHome = await ensureJdk(p);
  ensureGit();
  const bootstrapped = await ensureBbEdn(bbPath, javaHome, repo);
  const extraEnv = bootstrapped ? { BB_BOOTSTRAP_SHA: bootstrapped.sha } : {};
  const code = await runBb(bbPath, args, javaHome, extraEnv);
  process.exit(code);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    log(err && err.message ? err.message : String(err));
    process.exit(1);
  });
}

// Exported for tests / inspection.
module.exports = {
  resolvePlatform,
  cacheRoot,
  findJavaHome,
  ensureGit,
  validateBbEdnRepo,
  ensureBbEdn,
};
