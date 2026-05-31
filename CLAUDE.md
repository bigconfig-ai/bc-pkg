# CLAUDE.md

This file describes the `bc-pkg` Python launcher for AI assistants. Read it before making changes.

## Project Overview

`bc-pkg` is a bootstrap CLI published to PyPI under the name `bc-pkg`. It creates or reuses a BigConfig CLI in the current directory and forwards arguments to the pinned target package. The target package can be implemented in Clojure, TypeScript, or Python; the language is inferred from the pinned GitHub repo's content.

This Python launcher and the sibling `launcher/typescript` launcher must produce **equivalent on-disk artifacts** for the same `<owner/repo@ref>` — keep their behaviour in lockstep.

## Tech Stack

- **Language**: Python 3.11+ (stdlib only at runtime — `tomllib`, `urllib`, `subprocess`, `tarfile`, `zipfile`, `pathlib`, `shutil`, `json`, `re`)
- **Build backend**: `hatchling`
- **Package manager**: `uv` (dev) / `pip` (consumers via `uvx bc-pkg ...`)
- **No tests**, no CI gating

## Repository Layout

```
launcher/python/
├── src/bc_pkg/
│   ├── __init__.py      # __version__ only
│   └── cli.py           # All launcher logic
├── pyproject.toml       # hatchling build, [project.scripts] bc-pkg = bc_pkg.cli:main
├── README.md            # User-facing
└── .gitignore
```

All logic lives in `cli.py`. Do not split it across modules unless the file genuinely grows a second concern.

## Development Commands

```bash
uv sync                                    # install dev deps (currently none beyond stdlib)
uv run bc-pkg <owner/repo@ref> <args...>   # run from source
uvx --from . bc-pkg <args...>              # exercise as if installed from PyPI
```

There is no test suite. Behavioural parity with `launcher/typescript` is verified by hand against `bigconfig-ai/once@{clojure,typescript,python}`.

## Behaviour Contract

0. **Local vs. GitHub targets.** The first argument may be a **local path**
   (`is_local_spec`: starts with `/`, `./`, `../`, `~`, or is `.`/`..`) instead
   of `owner/repo@ref`. Local targets are for live local dev: no SHA, no GitHub
   round-trip. They resolve to a `LocalSpec` (absolute, realpath'd), read
   manifests/`run` from disk (`read_local_file`, `detect_target_local`), write
   native **local-path** deps (`:local/root` / `file:` / editable
   `[tool.uv.sources]`), record `local = true` + `path` in the metadata block
   (no `repo`/`ref`/`sha`), **symlink** the `run` file (copy fallback,
   `link_run_file`), and refuse when the resolved path equals cwd. The rest of
   the contract below is the GitHub path.

1. **Spec parsing** (`parse_spec`): `owner/repo@ref` where `ref` is a branch, tag, or full 40-char SHA. Anything else is treated as forwarded args.
2. **Ref resolution** (`resolve_ref`): full SHA passes through (lowercased); otherwise hits `GET /repos/{owner}/{repo}/commits/{ref}` and uses `data.sha`. `GITHUB_TOKEN` is sent as `Bearer` when set.
3. **Target detection** (`detect_target`): fetches `deps.edn`, `package.json`, `pyproject.toml` from the pinned SHA. Exactly **one** must exist; otherwise it fails. The match selects the target language. TS/Python use the package name from the manifest; Clojure synthesises `io.github.{owner}/{repo}`.
4. **Initialisation** (`initialize`): copies the target's root `run` file (required) into cwd and writes the language-native manifest:
   - **Clojure** → `deps.edn` (with `:bigconfig/{repo,ref,sha,language,run}` metadata keys) **and** `bb.edn` (runtime deps only — Babashka reads `bb.edn`, not `deps.edn`).
   - **TypeScript** → `package.json` with `type: "module"`, `scripts.run = "node run"`, the target package as a `github:owner/repo#sha` dependency, and a `bigconfig` block.
   - **Python** → `pyproject.toml` (`name = "bigconfig-cli"`, `requires-python = ">=3.12"`) with the target as a Git PEP 508 dep and a `[tool.bigconfig]` block.
5. **Re-entry**: `read_metadata` parses the manifest's `bigconfig` block (preferring `tomllib` for pyproject; falling back to regex). Its completeness check branches on the `local` marker (local requires `path` + `language`; GitHub requires `repo`/`ref`/`sha` + `language`). If an `owner/repo@ref` is also passed, `validate_existing_metadata` requires repo/ref/sha to match; if a local path is passed, `validate_existing_local_metadata` requires the resolved path to match. Switching between local and GitHub (or to a different local path) is a hard error, not an implicit update.
6. **Run** (`run_target`):
   - TS → `npm install` if `node_modules/` missing, then `node run <args>`.
   - Python → `uv sync` if `.venv/` missing, then `uv run python run <args>`. `_expose_python_resources(meta)` symlinks (or copies) `resources/` to `./resources` so BigConfig's renderer can find template data — from `.venv/.../site-packages/resources` for wheel installs, or from the local source tree (`<path>/src/resources` or `<path>/resources`) for editable local targets.
   - Clojure → resolve platform, download pinned Babashka (`BB_VERSION`, default `1.12.196`) and Temurin JDK (`JDK_VERSION`, default `21`) into `cache_root()/bb/<v>` and `cache_root()/jdk/<v>`, ensure `git` is on PATH (auto-installs via apt/dnf/yum/zypper/pacman/apk on Linux with `sudo` when needed), then exec `bb run <args>` with `JAVA_HOME` and the JDK + bb dirs prepended to `PATH`.
7. **`run` file restoration**: if `meta.run` is missing on re-entry, refetch it from the pinned SHA before forwarding.

## Cache Layout

```
$XDG_CACHE_HOME/bc-pkg/          (macOS/Linux; or ~/.cache/bc-pkg)
%LOCALAPPDATA%/bc-pkg            (Windows)
├── bb/<version>/bb              # Babashka native binary
└── jdk/<feature>/...            # Temurin JDK extracted tree + .javahome marker
```

`install_once` writes to `<final>.tmp-<pid>-<rand>` and renames atomically — safe against concurrent installs. Don't replace it with naive `mkdir`/`rename` sequences.

## Code Conventions

- **Stdlib only at runtime.** Adding a third-party dep breaks `uvx bc-pkg ...` cold starts and forces consumers to wait through resolves. Load-bearing.
- **`die(msg)` for user-facing errors**, surfaced via the `main` exception handler as `[bc-pkg] <msg>` on stderr with exit 1. Don't sprinkle bespoke `print` + `sys.exit`.
- **`main_star` / `main`**: `main_star` returns the exit code (testable); `main` wraps it for the `[project.scripts]` entry point with the exception handler. Mirror the same shape as the TS launcher's `main`.
- **Dataclasses (`Spec`, `Target`, `Metadata`, `PlatformInfo`) are frozen** — treat them as values, not mutable state.
- **GitHub API access** goes through `gh_read` / `gh_headers`; do not call `urlopen` directly elsewhere. `Accept: application/vnd.github.raw` for file content, default `application/vnd.github+json` for the commits endpoint.
- **Windows / macOS / Linux** are all supported; do not assume POSIX-only.

## Parity With `launcher/typescript`

These two launchers must stay equivalent. When changing one, mirror the other in the same change set:

| Concern | Source of truth |
|---|---|
| Spec / SHA regex | `FULL_SHA_RE`, `SPEC_RE` in both |
| Local-path detection | `is_local_spec` / `isLocalSpec` in both |
| Manifest shapes (deps.edn / package.json / pyproject.toml) | Both `write_*_manifest` (GitHub) and `write_*_manifest_local` (local) |
| Cache root layout | `cache_root` in both |
| Default `BB_VERSION`, `JDK_VERSION` | Constants at top of `cli.py` / `bc-pkg.js` |
| Git auto-install matrix (Linux only) | `ensure_git` in both |
| Re-init error semantics | `validate_existing_metadata` + `validate_existing_local_metadata` in both |
| Python `resources/` exposure (incl. editable layout) | `_expose_python_resources` / `exposePythonResources` in both |

If you find a behavioural divergence, treat it as a bug.

## What to Avoid

- Do not add runtime dependencies. Stdlib only.
- Do not import from `big-config` / `once` / `selmer` — the launcher is independent of the BigConfig library chain.
- Do not change the on-disk artifact shape without also updating `launcher/typescript`.
- Do not silently auto-upgrade an initialised directory; mismatched repo/ref/sha (or local path, or local↔GitHub switch) is a hard error.
- Do not let a local target overwrite the package's own manifest: refuse when the resolved local path equals cwd. Local `run` files are symlinked, not copied.
- Do not assume the cache root is writable atomically — go through `install_once`.

## Git

The launcher leaves are independent repos. Stay on the working branch (see `git status`) and commit only when explicitly asked. Commit messages follow Conventional Commits (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `deps:`).
