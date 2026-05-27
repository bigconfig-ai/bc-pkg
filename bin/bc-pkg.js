#!/usr/bin/env node
'use strict';

// bc-pkg — creates/reuses a BigConfig CLI in the current directory and runs it.
// The target package can be implemented in Clojure, TypeScript, or Python. The
// target language is inferred from the package's pinned GitHub content.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const DEFAULT_BB_VERSION = process.env.BB_VERSION || '1.12.196';
const DEFAULT_JDK_VERSION = process.env.JDK_VERSION || '21';
const TAG = '[bc-pkg]';
const FULL_SHA_RE = /^[0-9a-fA-F]{40}$/;
const SPEC_RE = /^([^/\s@]+)\/([^/\s@]+)@([^\s]+)$/;

function log(msg) {
  process.stderr.write(`${TAG} ${msg}\n`);
}

function fail(msg) {
  throw new Error(msg);
}

function usage() {
  return `Usage:\n  bc-pkg <owner/repo@ref> <args...>\n  bc-pkg <args...>\n\nExamples:\n  npx bc-pkg bigconfig-ai/once@typescript package validate\n  npx bc-pkg package validate`;
}

// --- generic process helpers -------------------------------------------

function commandWorks(cmd, args = ['--version']) {
  const r = spawnSync(cmd, args, { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

function binExists(cmd) {
  return !spawnSync(cmd, ['--version'], { stdio: 'ignore' }).error;
}

function runCommand(cmd, args, options = {}) {
  const child = spawn(cmd, args, {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env,
    ...options,
  });

  const forward = (sig) => {
    try {
      child.kill(sig);
    } catch {
      // child already gone
    }
  };
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);

  return new Promise((resolve) => {
    child.on('error', (err) => {
      log(`failed to start ${cmd}: ${err.message}`);
      resolve(127);
    });
    child.on('exit', (code, signal) => {
      resolve(signal ? 1 : code == null ? 1 : code);
    });
  });
}

function whichPython() {
  if (commandWorks('python3')) return 'python3';
  if (commandWorks('python')) return 'python';
  return null;
}

function requireCommand(cmd, installHint) {
  if (!commandWorks(cmd)) {
    fail(`${cmd} is required but was not found on PATH.${installHint ? `\n  ${installHint}` : ''}`);
  }
}

// --- GitHub --------------------------------------------------------------

function parseSpec(arg) {
  const m = arg && arg.match(SPEC_RE);
  if (!m) return null;
  return { owner: m[1], repo: m[2], ref: m[3], slug: `${m[1]}/${m[2]}` };
}

function ghHeaders(accept) {
  const headers = {
    'user-agent': 'bc-pkg',
    accept: accept || 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

async function ghFetch(url, accept) {
  return fetch(url, { headers: ghHeaders(accept), redirect: 'follow' });
}

async function resolveRef(spec) {
  if (FULL_SHA_RE.test(spec.ref)) {
    return spec.ref.toLowerCase();
  }
  const url = `https://api.github.com/repos/${spec.owner}/${spec.repo}/commits/${encodeURIComponent(spec.ref)}`;
  const res = await ghFetch(url);
  if (res.status === 404) {
    fail(`${spec.slug}@${spec.ref} not found or not accessible (set GITHUB_TOKEN for private repos)`);
  }
  if (!res.ok) {
    fail(`GitHub API error ${res.status} resolving ${spec.slug}@${spec.ref}`);
  }
  const data = await res.json();
  if (!data || !data.sha) fail(`${spec.slug}@${spec.ref} did not resolve to a commit`);
  return String(data.sha).toLowerCase();
}

async function fetchFile(spec, sha, filePath, { required = false } = {}) {
  const url = `https://api.github.com/repos/${spec.owner}/${spec.repo}/contents/${filePath}?ref=${sha}`;
  const res = await ghFetch(url, 'application/vnd.github.raw');
  if (res.status === 404) {
    if (required) fail(`${spec.slug}@${sha.slice(0, 7)} has no ${filePath}`);
    return null;
  }
  if (!res.ok) {
    fail(`GitHub API error ${res.status} fetching ${filePath} from ${spec.slug}@${sha.slice(0, 7)}`);
  }
  return await res.text();
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (err) {
    fail(`Invalid JSON in ${label}: ${err.message}`);
  }
}

function parsePyProjectName(text) {
  const project = sectionText(text, 'project');
  const m = project && project.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
  return m ? m[1] : null;
}

function sectionText(text, name) {
  const re = new RegExp(`^\\s*\\[${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\s*$`, 'm');
  const m = re.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = text.slice(start);
  const next = /^\s*\[[^\]]+\]\s*$/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

async function detectTarget(spec, sha) {
  const [depsEdn, packageJsonText, pyprojectText] = await Promise.all([
    fetchFile(spec, sha, 'deps.edn'),
    fetchFile(spec, sha, 'package.json'),
    fetchFile(spec, sha, 'pyproject.toml'),
  ]);

  const found = [];
  if (depsEdn != null) found.push('clojure');
  if (packageJsonText != null) found.push('typescript');
  if (pyprojectText != null) found.push('python');
  if (found.length === 0) {
    fail(`${spec.slug}@${sha.slice(0, 7)} has no deps.edn, package.json, or pyproject.toml`);
  }
  if (found.length > 1) {
    fail(`${spec.slug}@${sha.slice(0, 7)} is ambiguous; found ${found.join(', ')} manifests`);
  }

  if (found[0] === 'typescript') {
    const pkg = parseJson(packageJsonText, 'package.json');
    if (!pkg.name) fail(`${spec.slug}@${sha.slice(0, 7)} package.json has no name`);
    return { language: 'typescript', packageName: pkg.name };
  }
  if (found[0] === 'python') {
    const packageName = parsePyProjectName(pyprojectText);
    if (!packageName) fail(`${spec.slug}@${sha.slice(0, 7)} pyproject.toml has no [project].name`);
    return { language: 'python', packageName };
  }
  return { language: 'clojure', packageName: `io.github.${spec.owner}/${spec.repo}` };
}

// --- native metadata -----------------------------------------------------

function metadataFromPackageJson(file) {
  if (!fs.existsSync(file)) return null;
  const pkg = parseJson(fs.readFileSync(file, 'utf8'), file);
  if (!pkg.bigconfig) return null;
  return { ...pkg.bigconfig, language: pkg.bigconfig.language || 'typescript', manifest: file };
}

function metadataFromPyproject(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const sec = sectionText(text, 'tool.bigconfig');
  if (!sec) return null;
  const get = (key) => {
    const m = sec.match(new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*["']([^"']+)["']`, 'm'));
    return m ? m[1] : undefined;
  };
  return {
    repo: get('repo'),
    ref: get('ref'),
    sha: get('sha'),
    language: get('language') || 'python',
    run: get('run') || 'run',
    packageName: get('package-name'),
    manifest: file,
  };
}

function metadataFromDepsEdn(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(':bigconfig/repo')) return null;
  const get = (key) => {
    const m = text.match(new RegExp(`:${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+"([^"]+)"`));
    return m ? m[1] : undefined;
  };
  return {
    repo: get('bigconfig/repo'),
    ref: get('bigconfig/ref'),
    sha: get('bigconfig/sha'),
    language: get('bigconfig/language') || 'clojure',
    run: get('bigconfig/run') || 'run',
    manifest: file,
  };
}

function readMetadata(cwd = process.cwd()) {
  const metas = [
    metadataFromDepsEdn(path.join(cwd, 'deps.edn')),
    metadataFromPackageJson(path.join(cwd, 'package.json')),
    metadataFromPyproject(path.join(cwd, 'pyproject.toml')),
  ].filter(Boolean);
  if (metas.length > 1) {
    fail('Multiple BigConfig metadata files found; keep only one of deps.edn, package.json, or pyproject.toml initialized for bc-pkg.');
  }
  if (metas.length === 0) return null;
  const meta = metas[0];
  if (!meta.repo || !meta.ref || !meta.sha || !meta.language) {
    fail(`Incomplete BigConfig metadata in ${meta.manifest}`);
  }
  return meta;
}

function validateExistingMetadata(meta, spec, sha) {
  const expectedRepo = spec.slug;
  const problems = [];
  if (meta.repo !== expectedRepo) problems.push(`repo ${JSON.stringify(meta.repo)} != ${JSON.stringify(expectedRepo)}`);
  if (meta.ref !== spec.ref) problems.push(`ref ${JSON.stringify(meta.ref)} != ${JSON.stringify(spec.ref)}`);
  if (String(meta.sha).toLowerCase() !== sha.toLowerCase()) problems.push(`sha ${meta.sha} != ${sha}`);
  if (problems.length) {
    fail(`Current directory is already initialized for a different BigConfig package:\n  ${problems.join('\n  ')}`);
  }
}

function quoteToml(s) {
  return JSON.stringify(String(s));
}

function writeRunFile(text) {
  const target = path.join(process.cwd(), 'run');
  fs.writeFileSync(target, text);
  if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
}

function clojureCoord(spec) {
  return `io.github.${spec.owner}/${spec.repo}`;
}

function writeClojureManifest(spec, sha, target) {
  const coord = clojureCoord(spec);
  const gitUrl = `https://github.com/${spec.owner}/${spec.repo}.git`;
  const deps = `{:deps {${coord} {:git/url "${gitUrl}"\n                           :git/sha "${sha}"}}\n :bigconfig/repo "${spec.slug}"\n :bigconfig/ref "${spec.ref}"\n :bigconfig/sha "${sha}"\n :bigconfig/language "clojure"\n :bigconfig/run "run"}\n`;
  fs.writeFileSync(path.join(process.cwd(), 'deps.edn'), deps);

  // Babashka script execution reads bb.edn, not deps.edn. Metadata remains in
  // deps.edn per the launcher contract; bb.edn is the runtime dependency file.
  const bb = `{:deps {${coord} {:git/url "${gitUrl}"\n                           :git/sha "${sha}"}}}\n`;
  fs.writeFileSync(path.join(process.cwd(), 'bb.edn'), bb);
}

function writeTypeScriptManifest(spec, sha, target) {
  const file = path.join(process.cwd(), 'package.json');
  let pkg = {};
  if (fs.existsSync(file)) {
    pkg = parseJson(fs.readFileSync(file, 'utf8'), file);
    if (pkg.bigconfig) validateExistingMetadata(pkg.bigconfig, spec, sha);
  }
  pkg.type = pkg.type || 'module';
  pkg.scripts = { ...(pkg.scripts || {}), run: 'node run' };
  pkg.dependencies = { ...(pkg.dependencies || {}) };
  pkg.dependencies[target.packageName] = `github:${spec.owner}/${spec.repo}#${sha}`;
  pkg.bigconfig = {
    repo: spec.slug,
    ref: spec.ref,
    sha,
    language: 'typescript',
    run: 'run',
    packageName: target.packageName,
  };
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

function writePythonManifest(spec, sha, target) {
  const file = path.join(process.cwd(), 'pyproject.toml');
  if (fs.existsSync(file)) {
    const existing = metadataFromPyproject(file);
    if (!existing) {
      fail('pyproject.toml already exists and is not initialized for bc-pkg; refusing to rewrite it.');
    }
    validateExistingMetadata(existing, spec, sha);
  }
  const dep = `${target.packageName} @ git+https://github.com/${spec.owner}/${spec.repo}.git@${sha}`;
  const text = `[project]\nname = "bigconfig-cli"\nversion = "0.1.0"\nrequires-python = ">=3.12"\ndependencies = [\n  ${quoteToml(dep)},\n]\n\n[tool.bigconfig]\nrepo = ${quoteToml(spec.slug)}\nref = ${quoteToml(spec.ref)}\nsha = ${quoteToml(sha)}\nlanguage = "python"\nrun = "run"\npackage-name = ${quoteToml(target.packageName)}\n`;
  fs.writeFileSync(file, text);
}

function writeNativeManifest(spec, sha, target) {
  if (target.language === 'clojure') return writeClojureManifest(spec, sha, target);
  if (target.language === 'typescript') return writeTypeScriptManifest(spec, sha, target);
  if (target.language === 'python') return writePythonManifest(spec, sha, target);
  fail(`Unsupported language: ${target.language}`);
}

// --- target dependency setup and execution -------------------------------

async function ensureTargetDeps(meta) {
  if (meta.language === 'typescript') {
    requireCommand('node', 'Install Node.js and try again.');
    requireCommand('npm', 'Install npm and try again.');
    if (!fs.existsSync(path.join(process.cwd(), 'node_modules'))) {
      log('Installing TypeScript target dependencies with npm install...');
      const code = await runCommand('npm', ['install']);
      if (code !== 0) process.exit(code);
    }
    return;
  }
  if (meta.language === 'python') {
    const py = whichPython();
    if (!py) fail('python3 or python is required but was not found on PATH.');
    requireCommand('uv', 'Install uv and try again.');
    if (!fs.existsSync(path.join(process.cwd(), '.venv'))) {
      log('Installing Python target dependencies with uv sync...');
      const code = await runCommand('uv', ['sync']);
      if (code !== 0) process.exit(code);
    }
    return;
  }
}

async function runTarget(meta, args) {
  if (meta.language === 'typescript') {
    await ensureTargetDeps(meta);
    return await runCommand('node', ['run', ...args]);
  }
  if (meta.language === 'python') {
    await ensureTargetDeps(meta);
    return await runCommand('uv', ['run', 'python', meta.run || 'run', ...args]);
  }
  if (meta.language === 'clojure') {
    const p = resolvePlatform();
    const bbPath = await ensureBabashka(p);
    const javaHome = await ensureJdk(p);
    ensureGit();
    return await runBb(bbPath, ['run', ...args], javaHome);
  }
  fail(`Unsupported language: ${meta.language}`);
}

async function initialize(spec, sha) {
  const target = await detectTarget(spec, sha);
  const runText = await fetchFile(spec, sha, 'run', { required: true });
  writeRunFile(runText);
  writeNativeManifest(spec, sha, target);
  return {
    repo: spec.slug,
    ref: spec.ref,
    sha,
    language: target.language,
    run: 'run',
    packageName: target.packageName,
  };
}

async function restoreRunIfMissing(meta) {
  const runPath = path.join(process.cwd(), meta.run || 'run');
  if (fs.existsSync(runPath)) return;
  const [owner, repo] = meta.repo.split('/');
  const spec = { owner, repo, slug: meta.repo, ref: meta.ref };
  const runText = await fetchFile(spec, meta.sha, 'run', { required: true });
  writeRunFile(runText);
}

// --- Babashka/JDK bootstrap for Clojure targets --------------------------

function resolvePlatform() {
  const plat = process.platform;
  const arch = process.arch;
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
    fail(`Unsupported OS: ${plat}`);
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
    fail(`Unsupported CPU architecture: ${arch}`);
  }

  const bbArchToken = plat === 'linux' && arch === 'arm64' ? 'aarch64-static' : bbArch;
  if (plat === 'win32' && arch === 'arm64') fail('babashka has no prebuilt Windows arm64 binary');

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
  const base = process.platform === 'win32'
    ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    : process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'bc-pkg');
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

async function installOnce(finalDir, install) {
  if (fs.existsSync(finalDir)) return;
  const tmp = `${finalDir}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(tmp, { recursive: true });
  try {
    await install(tmp);
    if (fs.existsSync(finalDir)) {
      rmrf(tmp);
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
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'bc-pkg' } });
  if (!res.ok || !res.body) {
    fail(`Download failed (HTTP ${res.status} ${res.statusText})\n  ${url}`);
  }
  await fs.promises.mkdir(path.dirname(destFile), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destFile));
}

function extract(archive, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  let r = spawnSync('tar', ['-xf', archive, '-C', destDir], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.error && r.error.code === 'ENOENT') {
    if (process.platform === 'win32' && archive.endsWith('.zip')) {
      r = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destDir}' -Force`], { stdio: ['ignore', 'inherit', 'inherit'] });
      if (r.status !== 0) fail(`Failed to extract ${archive} (PowerShell fallback)`);
      return;
    }
    fail(`'tar' not found on PATH; cannot extract ${archive}`);
  }
  if (r.status !== 0) fail(`Failed to extract ${archive} (tar exit ${r.status})`);
}

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
    for (const e of entries) if (e.isDirectory()) stack.push(path.join(dir, e.name));
  }
  return null;
}

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
    if (!fs.existsSync(exe)) fail('babashka binary not found after extraction');
    if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
  });

  if (!fs.existsSync(bbPath)) fail(`babashka cache looks corrupt; remove ${finalDir} and retry`);
  if (process.platform !== 'win32') {
    try { fs.chmodSync(bbPath, 0o755); } catch {}
  }
  return bbPath;
}

async function ensureJdk(p) {
  const feature = DEFAULT_JDK_VERSION;
  const finalDir = path.join(cacheRoot(), 'jdk', feature);
  const marker = path.join(finalDir, '.javahome');

  await installOnce(finalDir, async (tmp) => {
    const archive = path.join(tmp, p.jdkArchiveName);
    const url = `https://api.adoptium.net/v3/binary/latest/${feature}/ga/${p.jdkOs}/${p.jdkArch}/jdk/hotspot/normal/eclipse`;
    log(`Installing Temurin JDK ${feature} (set JDK_VERSION to override)...`);
    try {
      await download(url, archive);
    } catch (err) {
      throw new Error(`${err.message}\n  (override with JDK_VERSION=<feature>)`);
    }
    extract(archive, tmp);
    fs.unlinkSync(archive);
    const home = findJavaHome(tmp, p.exeSuffix);
    if (!home) fail('could not locate java in extracted JDK');
    fs.writeFileSync(path.join(tmp, '.javahome'), path.relative(tmp, home));
  });

  let javaHome = null;
  try {
    javaHome = path.join(finalDir, fs.readFileSync(marker, 'utf8').trim());
  } catch {
    javaHome = null;
  }
  if (!javaHome || !fs.existsSync(path.join(javaHome, 'bin', `java${p.exeSuffix}`))) {
    javaHome = findJavaHome(finalDir, p.exeSuffix);
  }
  if (!javaHome) fail(`JDK cache looks corrupt; remove ${finalDir} and retry`);
  return javaHome;
}

function ensureGit() {
  if (process.platform !== 'linux') return;
  if (commandWorks('git', ['--version'])) return;

  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const sudo = isRoot ? [] : binExists('sudo') ? ['sudo'] : null;
  if (sudo === null) {
    fail('git is missing and cannot be installed: not running as root and `sudo` is unavailable.\n  Install git manually and re-run.');
  }

  const managers = [
    { bin: 'apt-get', steps: [['apt-get', 'update', '-y'], ['apt-get', 'install', '-y', 'git']], soft: [0] },
    { bin: 'dnf', steps: [['dnf', 'install', '-y', 'git']] },
    { bin: 'yum', steps: [['yum', 'install', '-y', 'git']] },
    { bin: 'zypper', steps: [['zypper', '--non-interactive', 'install', 'git']] },
    { bin: 'pacman', steps: [['pacman', '-S', '--noconfirm', 'git']] },
    { bin: 'apk', steps: [['apk', 'add', '--no-cache', 'git']] },
  ];
  const pm = managers.find((m) => binExists(m.bin));
  if (!pm) fail('git is missing and no supported package manager was found. Install git manually and re-run.');

  log(`Installing git via ${pm.bin}${sudo.length ? ' (sudo)' : ''}...`);
  const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
  pm.steps.forEach((step, i) => {
    const argv = [...sudo, ...step];
    const r = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit', env });
    const ok = !r.error && r.status === 0;
    if (!ok && !(pm.soft && pm.soft.includes(i))) {
      const why = r.error ? r.error.code : `exit ${r.status}`;
      fail(`git install failed: \`${argv.join(' ')}\` (${why}).`);
    }
  });
  if (!commandWorks('git', ['--version'])) fail('git still not available after the install attempt.');
}

function bbEnv(javaHome, bbPath, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  const pathEntries = [];
  if (javaHome) {
    env.JAVA_HOME = javaHome;
    pathEntries.push(path.join(javaHome, 'bin'));
  }
  if (bbPath) pathEntries.push(path.dirname(bbPath));
  if (pathEntries.length) env.PATH = pathEntries.join(path.delimiter) + path.delimiter + (env.PATH || '');
  return env;
}

function runBb(bbPath, args, javaHome, extraEnv = {}) {
  return runCommand(bbPath, args, { env: bbEnv(javaHome, bbPath, extraEnv) });
}

// --- main ----------------------------------------------------------------

async function main(argv) {
  let args = [...argv];
  let spec = args.length ? parseSpec(args[0]) : null;
  if (spec) args = args.slice(1);

  let meta = readMetadata();
  if (spec) {
    const sha = await resolveRef(spec);
    if (meta) {
      validateExistingMetadata(meta, spec, sha);
    } else {
      meta = await initialize(spec, sha);
    }
  } else if (!meta) {
    fail(`No BigConfig CLI is initialized in this directory.\n\n${usage()}`);
  }

  await restoreRunIfMissing(meta);
  const code = await runTarget(meta, args);
  process.exit(code);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    log(err && err.message ? err.message : String(err));
    process.exit(1);
  });
}

module.exports = {
  parseSpec,
  resolveRef,
  detectTarget,
  readMetadata,
  validateExistingMetadata,
  resolvePlatform,
  cacheRoot,
  findJavaHome,
  ensureGit,
};
