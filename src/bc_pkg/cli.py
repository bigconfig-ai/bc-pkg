"""bc-pkg launcher.

Creates/reuses a BigConfig CLI in the current directory and runs it. The target
package can be implemented in Clojure, TypeScript, or Python; the target
language is inferred from the package's pinned GitHub content.
"""
from __future__ import annotations

import json
import os
import platform as py_platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python < 3.11 is unsupported.
    tomllib = None  # type: ignore[assignment]

DEFAULT_BB_VERSION = os.environ.get("BB_VERSION", "1.12.196")
DEFAULT_JDK_VERSION = os.environ.get("JDK_VERSION", "21")
TAG = "[bc-pkg]"
FULL_SHA_RE = re.compile(r"^[0-9a-fA-F]{40}$")
SPEC_RE = re.compile(r"^([^/\s@]+)/([^/\s@]+)@([^\s]+)$")


@dataclass(frozen=True)
class Spec:
    owner: str
    repo: str
    ref: str

    @property
    def slug(self) -> str:
        return f"{self.owner}/{self.repo}"


@dataclass(frozen=True)
class Target:
    language: str
    package_name: str | None = None


@dataclass(frozen=True)
class Metadata:
    repo: str
    ref: str
    sha: str
    language: str
    run: str = "run"
    package_name: str | None = None
    manifest: Path | None = None


def log(msg: str) -> None:
    print(f"{TAG} {msg}", file=sys.stderr)


def die(msg: str) -> None:
    raise RuntimeError(msg)


def usage() -> str:
    return (
        "Usage:\n"
        "  bc-pkg <owner/repo@ref> <args...>\n"
        "  bc-pkg <args...>\n\n"
        "Examples:\n"
        "  uvx bc-pkg bigconfig-ai/once@python package validate\n"
        "  uvx bc-pkg package validate"
    )


# --- process helpers -----------------------------------------------------


def command_works(cmd: str, args: list[str] | None = None) -> bool:
    args = ["--version"] if args is None else args
    try:
        r = subprocess.run([cmd, *args], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except FileNotFoundError:
        return False
    return r.returncode == 0


def bin_exists(cmd: str) -> bool:
    try:
        subprocess.run([cmd, "--version"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except FileNotFoundError:
        return False
    return True


def run_command(cmd: str, args: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> int:
    try:
        completed = subprocess.run([cmd, *args], cwd=cwd or Path.cwd(), env=env)
    except FileNotFoundError as exc:
        log(f"failed to start {cmd}: {exc}")
        return 127
    if completed.returncode < 0:
        return 1
    return completed.returncode


def which_python() -> str | None:
    for candidate in ("python3", "python"):
        if command_works(candidate):
            return candidate
    return sys.executable if sys.executable else None


def require_command(cmd: str, hint: str = "") -> None:
    if not command_works(cmd):
        suffix = f"\n  {hint}" if hint else ""
        die(f"{cmd} is required but was not found on PATH.{suffix}")


# --- GitHub ---------------------------------------------------------------


def parse_spec(arg: str | None) -> Spec | None:
    if not arg:
        return None
    m = SPEC_RE.match(arg)
    if not m:
        return None
    return Spec(m.group(1), m.group(2), m.group(3))


def gh_headers(accept: str | None = None) -> dict[str, str]:
    headers = {
        "user-agent": "bc-pkg",
        "accept": accept or "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
    }
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["authorization"] = f"Bearer {token}"
    return headers


def gh_read(url: str, accept: str | None = None) -> bytes:
    request = urllib.request.Request(url, headers=gh_headers(accept))
    with urllib.request.urlopen(request) as response:  # noqa: S310 - user-requested GitHub URL.
        return response.read()


def resolve_ref(spec: Spec) -> str:
    if FULL_SHA_RE.match(spec.ref):
        return spec.ref.lower()
    url = f"https://api.github.com/repos/{spec.owner}/{spec.repo}/commits/{urllib.parse.quote(spec.ref, safe='')}"
    try:
        data = json.loads(gh_read(url).decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            die(f"{spec.slug}@{spec.ref} not found or not accessible (set GITHUB_TOKEN for private repos)")
        die(f"GitHub API error {exc.code} resolving {spec.slug}@{spec.ref}")
    sha = data.get("sha")
    if not sha:
        die(f"{spec.slug}@{spec.ref} did not resolve to a commit")
    return str(sha).lower()


def fetch_file(spec: Spec, sha: str, file_path: str, *, required: bool = False) -> str | None:
    url = f"https://api.github.com/repos/{spec.owner}/{spec.repo}/contents/{file_path}?ref={sha}"
    try:
        return gh_read(url, "application/vnd.github.raw").decode("utf-8")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            if required:
                die(f"{spec.slug}@{sha[:7]} has no {file_path}")
            return None
        die(f"GitHub API error {exc.code} fetching {file_path} from {spec.slug}@{sha[:7]}")


def parse_pyproject_name(text: str) -> str | None:
    if tomllib is not None:
        try:
            data = tomllib.loads(text)
            name = data.get("project", {}).get("name")
            return str(name) if name else None
        except Exception:
            pass
    m = re.search(r"^\s*name\s*=\s*[\"']([^\"']+)[\"']", section_text(text, "project") or "", re.M)
    return m.group(1) if m else None


def section_text(text: str, name: str) -> str | None:
    m = re.search(rf"^\s*\[{re.escape(name)}\]\s*$", text, re.M)
    if not m:
        return None
    rest = text[m.end() :]
    next_section = re.search(r"^\s*\[[^\]]+\]\s*$", rest, re.M)
    return rest[: next_section.start()] if next_section else rest


def detect_target(spec: Spec, sha: str) -> Target:
    deps_edn = fetch_file(spec, sha, "deps.edn")
    package_json_text = fetch_file(spec, sha, "package.json")
    pyproject_text = fetch_file(spec, sha, "pyproject.toml")

    found: list[str] = []
    if deps_edn is not None:
        found.append("clojure")
    if package_json_text is not None:
        found.append("typescript")
    if pyproject_text is not None:
        found.append("python")
    if not found:
        die(f"{spec.slug}@{sha[:7]} has no deps.edn, package.json, or pyproject.toml")
    if len(found) > 1:
        die(f"{spec.slug}@{sha[:7]} is ambiguous; found {', '.join(found)} manifests")

    language = found[0]
    if language == "typescript":
        try:
            pkg = json.loads(package_json_text or "{}")
        except json.JSONDecodeError as exc:
            die(f"Invalid JSON in package.json: {exc}")
        name = pkg.get("name")
        if not name:
            die(f"{spec.slug}@{sha[:7]} package.json has no name")
        return Target("typescript", str(name))
    if language == "python":
        name = parse_pyproject_name(pyproject_text or "")
        if not name:
            die(f"{spec.slug}@{sha[:7]} pyproject.toml has no [project].name")
        return Target("python", name)
    return Target("clojure", f"io.github.{spec.owner}/{spec.repo}")


# --- native metadata ------------------------------------------------------


def metadata_from_package_json(file: Path) -> Metadata | None:
    if not file.exists():
        return None
    try:
        pkg = json.loads(file.read_text())
    except json.JSONDecodeError as exc:
        die(f"Invalid JSON in {file}: {exc}")
    bc = pkg.get("bigconfig")
    if not bc:
        return None
    return Metadata(
        repo=bc.get("repo"),
        ref=bc.get("ref"),
        sha=bc.get("sha"),
        language=bc.get("language", "typescript"),
        run=bc.get("run", "run"),
        package_name=bc.get("packageName"),
        manifest=file,
    )


def metadata_from_pyproject(file: Path) -> Metadata | None:
    if not file.exists():
        return None
    text = file.read_text()
    if tomllib is not None:
        try:
            tool = tomllib.loads(text).get("tool", {}).get("bigconfig")
        except Exception:
            tool = None
        if tool:
            return Metadata(
                repo=tool.get("repo"),
                ref=tool.get("ref"),
                sha=tool.get("sha"),
                language=tool.get("language", "python"),
                run=tool.get("run", "run"),
                package_name=tool.get("package-name"),
                manifest=file,
            )
    sec = section_text(text, "tool.bigconfig")
    if not sec:
        return None

    def get(key: str) -> str | None:
        m = re.search(rf"^\s*{re.escape(key)}\s*=\s*[\"']([^\"']+)[\"']", sec, re.M)
        return m.group(1) if m else None

    return Metadata(
        repo=get("repo"),
        ref=get("ref"),
        sha=get("sha"),
        language=get("language") or "python",
        run=get("run") or "run",
        package_name=get("package-name"),
        manifest=file,
    )


def metadata_from_deps_edn(file: Path) -> Metadata | None:
    if not file.exists():
        return None
    text = file.read_text()
    if ":bigconfig/repo" not in text:
        return None

    def get(key: str) -> str | None:
        m = re.search(rf":{re.escape(key)}\s+\"([^\"]+)\"", text)
        return m.group(1) if m else None

    return Metadata(
        repo=get("bigconfig/repo"),
        ref=get("bigconfig/ref"),
        sha=get("bigconfig/sha"),
        language=get("bigconfig/language") or "clojure",
        run=get("bigconfig/run") or "run",
        manifest=file,
    )


def read_metadata(cwd: Path | None = None) -> Metadata | None:
    cwd = cwd or Path.cwd()
    metas = [
        metadata_from_deps_edn(cwd / "deps.edn"),
        metadata_from_package_json(cwd / "package.json"),
        metadata_from_pyproject(cwd / "pyproject.toml"),
    ]
    metas = [m for m in metas if m is not None]
    if len(metas) > 1:
        die("Multiple BigConfig metadata files found; keep only one of deps.edn, package.json, or pyproject.toml initialized for bc-pkg.")
    if not metas:
        return None
    meta = metas[0]
    if not meta.repo or not meta.ref or not meta.sha or not meta.language:
        die(f"Incomplete BigConfig metadata in {meta.manifest}")
    return meta


def validate_existing_metadata(meta: Metadata, spec: Spec, sha: str) -> None:
    problems: list[str] = []
    if meta.repo != spec.slug:
        problems.append(f"repo {meta.repo!r} != {spec.slug!r}")
    if meta.ref != spec.ref:
        problems.append(f"ref {meta.ref!r} != {spec.ref!r}")
    if meta.sha.lower() != sha.lower():
        problems.append(f"sha {meta.sha} != {sha}")
    if problems:
        die("Current directory is already initialized for a different BigConfig package:\n  " + "\n  ".join(problems))


def write_run_file(text: str) -> None:
    target = Path.cwd() / "run"
    target.write_text(text)
    if os.name != "nt":
        target.chmod(target.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def clojure_coord(spec: Spec) -> str:
    return f"io.github.{spec.owner}/{spec.repo}"


def write_clojure_manifest(spec: Spec, sha: str, target: Target) -> None:
    coord = clojure_coord(spec)
    git_url = f"https://github.com/{spec.owner}/{spec.repo}.git"
    deps = (
        f'{{:deps {{{coord} {{:git/url "{git_url}"\n'
        f'                           :git/sha "{sha}"}}}}\n'
        f' :bigconfig/repo "{spec.slug}"\n'
        f' :bigconfig/ref "{spec.ref}"\n'
        f' :bigconfig/sha "{sha}"\n'
        f' :bigconfig/language "clojure"\n'
        f' :bigconfig/run "run"}}\n'
    )
    (Path.cwd() / "deps.edn").write_text(deps)

    # Babashka script execution reads bb.edn, not deps.edn. Metadata remains in
    # deps.edn per the launcher contract; bb.edn is the runtime dependency file.
    bb = f'{{:deps {{{coord} {{:git/url "{git_url}"\n                           :git/sha "{sha}"}}}}}}\n'
    (Path.cwd() / "bb.edn").write_text(bb)


def write_typescript_manifest(spec: Spec, sha: str, target: Target) -> None:
    file = Path.cwd() / "package.json"
    if file.exists():
        try:
            pkg: dict[str, Any] = json.loads(file.read_text())
        except json.JSONDecodeError as exc:
            die(f"Invalid JSON in {file}: {exc}")
        if pkg.get("bigconfig"):
            validate_existing_metadata(metadata_from_package_json(file), spec, sha)  # type: ignore[arg-type]
    else:
        pkg = {}
    package_name = target.package_name or spec.repo
    pkg.setdefault("type", "module")
    pkg["scripts"] = {**pkg.get("scripts", {}), "run": "node run"}
    pkg["dependencies"] = {**pkg.get("dependencies", {}), package_name: f"github:{spec.owner}/{spec.repo}#{sha}"}
    pkg["bigconfig"] = {
        "repo": spec.slug,
        "ref": spec.ref,
        "sha": sha,
        "language": "typescript",
        "run": "run",
        "packageName": package_name,
    }
    file.write_text(json.dumps(pkg, indent=2) + "\n")


def quote_toml(value: str) -> str:
    return json.dumps(str(value))


def write_python_manifest(spec: Spec, sha: str, target: Target) -> None:
    file = Path.cwd() / "pyproject.toml"
    if file.exists():
        existing = metadata_from_pyproject(file)
        if not existing:
            die("pyproject.toml already exists and is not initialized for bc-pkg; refusing to rewrite it.")
        validate_existing_metadata(existing, spec, sha)
    package_name = target.package_name or spec.repo
    dep = f"{package_name} @ git+https://github.com/{spec.owner}/{spec.repo}.git@{sha}"
    text = (
        "[project]\n"
        "name = \"bigconfig-cli\"\n"
        "version = \"0.1.0\"\n"
        "requires-python = \">=3.12\"\n"
        "dependencies = [\n"
        f"  {quote_toml(dep)},\n"
        "]\n\n"
        "[tool.bigconfig]\n"
        f"repo = {quote_toml(spec.slug)}\n"
        f"ref = {quote_toml(spec.ref)}\n"
        f"sha = {quote_toml(sha)}\n"
        "language = \"python\"\n"
        "run = \"run\"\n"
        f"package-name = {quote_toml(package_name)}\n"
    )
    file.write_text(text)


def write_native_manifest(spec: Spec, sha: str, target: Target) -> None:
    if target.language == "clojure":
        write_clojure_manifest(spec, sha, target)
    elif target.language == "typescript":
        write_typescript_manifest(spec, sha, target)
    elif target.language == "python":
        write_python_manifest(spec, sha, target)
    else:
        die(f"Unsupported language: {target.language}")


# --- target dependency setup and execution --------------------------------


def ensure_target_deps(meta: Metadata) -> None:
    if meta.language == "typescript":
        require_command("node", "Install Node.js and try again.")
        require_command("npm", "Install npm and try again.")
        if not (Path.cwd() / "node_modules").exists():
            log("Installing TypeScript target dependencies with npm install...")
            code = run_command("npm", ["install"])
            if code != 0:
                raise SystemExit(code)
    elif meta.language == "python":
        if which_python() is None:
            die("python3 or python is required but was not found on PATH.")
        require_command("uv", "Install uv and try again.")
        if not (Path.cwd() / ".venv").exists():
            log("Installing Python target dependencies with uv sync...")
            code = run_command("uv", ["sync"])
            if code != 0:
                raise SystemExit(code)


def run_target(meta: Metadata, args: list[str]) -> int:
    if meta.language == "typescript":
        ensure_target_deps(meta)
        return run_command("node", [meta.run, *args])
    if meta.language == "python":
        ensure_target_deps(meta)
        py = which_python()
        if py is None:
            die("python3 or python is required but was not found on PATH.")
        return run_command(py, [meta.run, *args])
    if meta.language == "clojure":
        p = resolve_platform()
        bb_path = ensure_babashka(p)
        java_home = ensure_jdk(p)
        ensure_git()
        return run_bb(bb_path, [meta.run, *args], java_home)
    die(f"Unsupported language: {meta.language}")


def initialize(spec: Spec, sha: str) -> Metadata:
    target = detect_target(spec, sha)
    run_text = fetch_file(spec, sha, "run", required=True)
    assert run_text is not None
    write_run_file(run_text)
    write_native_manifest(spec, sha, target)
    return Metadata(spec.slug, spec.ref, sha, target.language, "run", target.package_name)


def restore_run_if_missing(meta: Metadata) -> None:
    run_path = Path.cwd() / meta.run
    if run_path.exists():
        return
    owner, repo = meta.repo.split("/", 1)
    spec = Spec(owner, repo, meta.ref)
    run_text = fetch_file(spec, meta.sha, "run", required=True)
    assert run_text is not None
    write_run_file(run_text)


# --- Babashka/JDK bootstrap for Clojure targets ---------------------------


@dataclass(frozen=True)
class PlatformInfo:
    exe_suffix: str
    archive_ext: str
    jdk_os: str
    jdk_arch: str
    bb_os: str
    bb_arch_token: str

    def bb_asset_name(self, version: str) -> str:
        return f"babashka-{version}-{self.bb_os}-{self.bb_arch_token}.{self.archive_ext}"

    @property
    def jdk_archive_name(self) -> str:
        return f"jdk.{self.archive_ext}"


def resolve_platform() -> PlatformInfo:
    plat = sys.platform
    machine = py_platform.machine().lower()
    exe_suffix = ".exe" if plat == "win32" else ""

    if plat == "darwin":
        bb_os, jdk_os, archive_ext = "macos", "mac", "tar.gz"
    elif plat.startswith("linux"):
        bb_os, jdk_os, archive_ext = "linux", "linux", "tar.gz"
    elif plat == "win32":
        bb_os, jdk_os, archive_ext = "windows", "windows", "zip"
    else:
        die(f"Unsupported OS: {plat}")

    if machine in {"arm64", "aarch64"}:
        arch = "arm64"
        bb_arch, jdk_arch = "aarch64", "aarch64"
    elif machine in {"x86_64", "amd64", "x64"}:
        arch = "x64"
        bb_arch, jdk_arch = "amd64", "x64"
    else:
        die(f"Unsupported CPU architecture: {machine}")

    if plat == "win32" and arch == "arm64":
        die("babashka has no prebuilt Windows arm64 binary")
    bb_arch_token = "aarch64-static" if plat.startswith("linux") and arch == "arm64" else bb_arch
    return PlatformInfo(exe_suffix, archive_ext, jdk_os, jdk_arch, bb_os, bb_arch_token)


def cache_root() -> Path:
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    else:
        base = os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    return Path(base) / "bc-pkg"


def rmrf(target: Path) -> None:
    shutil.rmtree(target, ignore_errors=True)


def install_once(final_dir: Path, install) -> None:
    if final_dir.exists():
        return
    tmp = Path(f"{final_dir}.tmp-{os.getpid()}-{next(tempfile._get_candidate_names())}")
    tmp.mkdir(parents=True, exist_ok=True)
    try:
        install(tmp)
        if final_dir.exists():
            rmrf(tmp)
            return
        final_dir.parent.mkdir(parents=True, exist_ok=True)
        try:
            tmp.rename(final_dir)
        except FileExistsError:
            rmrf(tmp)
    except Exception:
        rmrf(tmp)
        raise


def download(url: str, dest_file: Path) -> None:
    dest_file.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"user-agent": "bc-pkg"})
    try:
        with urllib.request.urlopen(request) as response, dest_file.open("wb") as out:  # noqa: S310
            shutil.copyfileobj(response, out)
    except urllib.error.HTTPError as exc:
        die(f"Download failed (HTTP {exc.code} {exc.reason})\n  {url}")


def extract(archive: Path, dest_dir: Path) -> None:
    dest_dir.mkdir(parents=True, exist_ok=True)
    if archive.name.endswith(".zip"):
        with zipfile.ZipFile(archive) as zf:
            zf.extractall(dest_dir)
    else:
        with tarfile.open(archive) as tf:
            tf.extractall(dest_dir)


def find_java_home(root: Path, exe_suffix: str) -> Path | None:
    java_rel = Path("bin") / f"java{exe_suffix}"
    for dirpath, dirnames, _filenames in os.walk(root):
        if java_rel.name in _filenames and Path(dirpath).name == "bin":
            return Path(dirpath).parent
        if (Path(dirpath) / java_rel).exists():
            return Path(dirpath)
        # avoid huge hidden dirs if any vendor archive contains them
        dirnames[:] = [d for d in dirnames if d not in {".git"}]
    return None


def ensure_babashka(p: PlatformInfo) -> Path:
    version = DEFAULT_BB_VERSION
    final_dir = cache_root() / "bb" / version
    bb_path = final_dir / f"bb{p.exe_suffix}"
    asset = p.bb_asset_name(version)

    def install(tmp: Path) -> None:
        archive = tmp / asset
        url = f"https://github.com/babashka/babashka/releases/download/v{version}/{asset}"
        log(f"Installing babashka {version} (set BB_VERSION to override)...")
        download(url, archive)
        extract(archive, tmp)
        archive.unlink()
        exe = tmp / f"bb{p.exe_suffix}"
        if not exe.exists():
            die("babashka binary not found after extraction")
        if os.name != "nt":
            exe.chmod(exe.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    install_once(final_dir, install)
    if not bb_path.exists():
        die(f"babashka cache looks corrupt; remove {final_dir} and retry")
    if os.name != "nt":
        bb_path.chmod(bb_path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return bb_path


def ensure_jdk(p: PlatformInfo) -> Path:
    feature = DEFAULT_JDK_VERSION
    final_dir = cache_root() / "jdk" / feature
    marker = final_dir / ".javahome"

    def install(tmp: Path) -> None:
        archive = tmp / p.jdk_archive_name
        url = f"https://api.adoptium.net/v3/binary/latest/{feature}/ga/{p.jdk_os}/{p.jdk_arch}/jdk/hotspot/normal/eclipse"
        log(f"Installing Temurin JDK {feature} (set JDK_VERSION to override)...")
        download(url, archive)
        extract(archive, tmp)
        archive.unlink()
        home = find_java_home(tmp, p.exe_suffix)
        if not home:
            die("could not locate java in extracted JDK")
        (tmp / ".javahome").write_text(os.path.relpath(home, tmp))

    install_once(final_dir, install)
    java_home: Path | None = None
    if marker.exists():
        java_home = final_dir / marker.read_text().strip()
    if not java_home or not (java_home / "bin" / f"java{p.exe_suffix}").exists():
        java_home = find_java_home(final_dir, p.exe_suffix)
    if not java_home:
        die(f"JDK cache looks corrupt; remove {final_dir} and retry")
    return java_home


def ensure_git() -> None:
    if not sys.platform.startswith("linux"):
        return
    if command_works("git", ["--version"]):
        return
    is_root = hasattr(os, "geteuid") and os.geteuid() == 0
    sudo = [] if is_root else ["sudo"] if bin_exists("sudo") else None
    if sudo is None:
        die("git is missing and cannot be installed: not running as root and `sudo` is unavailable.\n  Install git manually and re-run.")

    managers = [
        ("apt-get", [["apt-get", "update", "-y"], ["apt-get", "install", "-y", "git"]], {0}),
        ("dnf", [["dnf", "install", "-y", "git"]], set()),
        ("yum", [["yum", "install", "-y", "git"]], set()),
        ("zypper", [["zypper", "--non-interactive", "install", "git"]], set()),
        ("pacman", [["pacman", "-S", "--noconfirm", "git"]], set()),
        ("apk", [["apk", "add", "--no-cache", "git"]], set()),
    ]
    found = next(((b, steps, soft) for b, steps, soft in managers if bin_exists(b)), None)
    if not found:
        die("git is missing and no supported package manager was found. Install git manually and re-run.")
    pm, steps, soft = found
    log(f"Installing git via {pm}{' (sudo)' if sudo else ''}...")
    env = {**os.environ, "DEBIAN_FRONTEND": "noninteractive"}
    for i, step in enumerate(steps):
        argv = [*sudo, *step]
        completed = subprocess.run(argv, env=env)
        if completed.returncode != 0 and i not in soft:
            die(f"git install failed: `{' '.join(argv)}` (exit {completed.returncode}).")
    if not command_works("git", ["--version"]):
        die("git still not available after the install attempt.")


def bb_env(java_home: Path, bb_path: Path) -> dict[str, str]:
    env = dict(os.environ)
    env["JAVA_HOME"] = str(java_home)
    env["PATH"] = os.pathsep.join([str(java_home / "bin"), str(bb_path.parent), env.get("PATH", "")])
    return env


def run_bb(bb_path: Path, args: list[str], java_home: Path) -> int:
    return run_command(str(bb_path), args, env=bb_env(java_home, bb_path))


# --- main -----------------------------------------------------------------


def main_star(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    spec = parse_spec(args[0]) if args else None
    if spec:
        args = args[1:]

    meta = read_metadata()
    if spec:
        sha = resolve_ref(spec)
        if meta:
            validate_existing_metadata(meta, spec, sha)
        else:
            meta = initialize(spec, sha)
    elif not meta:
        die(f"No BigConfig CLI is initialized in this directory.\n\n{usage()}")

    assert meta is not None
    restore_run_if_missing(meta)
    return run_target(meta, args)


def main(argv: list[str] | None = None) -> None:
    try:
        raise SystemExit(main_star(argv))
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - CLI boundary.
        log(str(exc))
        raise SystemExit(1)


if __name__ == "__main__":  # pragma: no cover
    main()
