# CLAUDE.md

This file describes the `bc-pkg` TypeScript launcher for AI assistants. Read it before making changes.

## Project Overview

`bc-pkg` is a bootstrap CLI published to npm under the name `bc-pkg`. It creates or reuses a BigConfig CLI in the current directory and forwards arguments to the pinned target package. The target package can be implemented in Clojure, TypeScript, or Python; the language is inferred from the pinned GitHub repo's content.

This Node launcher and the sibling `launcher/python` launcher must produce **equivalent on-disk artifacts** for the same `<owner/repo@ref>` — keep their behaviour in lockstep.

## Tech Stack

- **Language**: plain JavaScript (CommonJS — `package.json` declares `"type": "commonjs"`). No TypeScript, no transpile step.
- **Runtime**: Node.js ≥ 18 (uses the global `fetch`, `Readable.fromWeb`, `stream/promises`).
- **Runtime dependencies**: none — Node built-ins only (`fs`, `os`, `path`, `child_process`, `stream/promises`).
- **No tests**, no CI gating.

## Repository Layout

```
launcher/typescript/
├── bin/bc-pkg.js        # All launcher logic (also the bin entry)
├── package.json         # bin map, engines, license
├── README.md            # User-facing
└── .gitignore
```

All logic lives in `bin/bc-pkg.js`. The file is run directly as `node bin/bc-pkg.js` (or via the `bc-pkg` bin when installed). Module exports at the bottom expose helpers for any future test harness.

## Development Commands

```bash
npm install                                  # nothing to install in practice
node bin/bc-pkg.js <owner/repo@ref> <args>   # run from source
npx --package=. bc-pkg <args>                # exercise as if installed
```

There is no test suite. Behavioural parity with `launcher/python` is verified by hand against `bigconfig-ai/once@{clojure,typescript,python}`.

## Behaviour Contract

0. **Local vs. GitHub targets.** The first argument may be a **local path**
   (`isLocalSpec`: starts with `/`, `./`, `../`, `~`, or is `.`/`..`) instead of
   `owner/repo@ref`. Local targets are for live local dev: no SHA, no GitHub
   round-trip. They resolve to a `{ path, name }` (absolute, realpath'd), read
   manifests/`run` from disk (`readLocalFile`, `detectTargetLocal`), write native
   **local-path** deps (`:local/root` / `file:` / editable `[tool.uv.sources]`),
   record `local = true` + `path` in the metadata block (no `repo`/`ref`/`sha`),
   **symlink** the `run` file (copy fallback, `linkRunFile`), and refuse when the
   resolved path equals cwd. The rest of the contract below is the GitHub path.

1. **Spec parsing** (`parseSpec`): `owner/repo@ref` where `ref` is a branch, tag, or full 40-char SHA. Anything else is treated as forwarded args.
2. **Ref resolution** (`resolveRef`): full SHA passes through (lowercased); otherwise hits `GET /repos/{owner}/{repo}/commits/{ref}` and uses `data.sha`. `GITHUB_TOKEN` is sent as `Bearer` when set.
3. **Target detection** (`detectTarget`): fetches `deps.edn`, `package.json`, `pyproject.toml` from the pinned SHA in parallel. Exactly **one** must exist; otherwise it fails. TS/Python use the package name from the manifest; Clojure synthesises `io.github.{owner}/{repo}`.
4. **Initialisation** (`initialize`): copies the target's root `run` file (required) into cwd and writes the language-native manifest:
   - **Clojure** → `deps.edn` (with `:bigconfig/{repo,ref,sha,language,run}` metadata keys) **and** `bb.edn` (runtime deps only — Babashka reads `bb.edn`, not `deps.edn`).
   - **TypeScript** → `package.json` with `type: "module"`, `scripts.run = "node run"`, the target package as a `github:owner/repo#sha` dependency, and a `bigconfig` block.
   - **Python** → `pyproject.toml` (`name = "bigconfig-cli"`, `requires-python = ">=3.12"`) with the target as a Git PEP 508 dep and a `[tool.bigconfig]` block.
5. **Re-entry**: `readMetadata` parses the manifest's `bigconfig` block (regex-only — there is no TOML parser in core Node, so don't reach for one). Its completeness check branches on the `local` marker (local requires `path` + `language`; GitHub requires `repo`/`ref`/`sha` + `language`). If an `owner/repo@ref` is also passed, `validateExistingMetadata` requires repo/ref/sha to match; if a local path is passed, `validateExistingLocalMetadata` requires the resolved path to match. Switching between local and GitHub (or to a different local path) is a hard error, not an implicit update.
6. **Run** (`runTarget`):
   - TS → `npm install` if `node_modules/` missing, then `node run <args>`.
   - Python → `uv sync` if `.venv/` missing, then `uv run python run <args>`. No `./resources` exposure step is needed: template data ships as a top-level `resources` package (force-included into the wheel, and importable from the editable source tree for local targets), and BigConfig's renderer resolves it through `importlib.resources`.
   - Clojure → resolve platform, download pinned Babashka (`BB_VERSION`, default `1.12.196`) and Temurin JDK (`JDK_VERSION`, default `21`) into `cacheRoot()/bb/<v>` and `cacheRoot()/jdk/<v>`, ensure `git` is on PATH (auto-installs via apt/dnf/yum/zypper/pacman/apk on Linux with `sudo` when needed), then exec `bb run <args>` with `JAVA_HOME` and the JDK + bb dirs prepended to `PATH`.
7. **`run` file restoration**: if `meta.run` is missing on re-entry, refetch it from the pinned SHA before forwarding.

## Cache Layout

```
$XDG_CACHE_HOME/bc-pkg/          (macOS/Linux; or ~/.cache/bc-pkg)
%LOCALAPPDATA%/bc-pkg            (Windows)
├── bb/<version>/bb              # Babashka native binary
└── jdk/<feature>/...            # Temurin JDK extracted tree + .javahome marker
```

`installOnce` writes to `<final>.tmp-<pid>-<ts>` and renames atomically — safe against concurrent installs. Don't replace it with naive `mkdir`/`rename` sequences. Archive extraction uses `tar` from PATH on POSIX and falls back to `Expand-Archive` (PowerShell) on Windows `.zip`.

## Code Conventions

- **No runtime dependencies.** Adding a third-party dep breaks `npx bc-pkg ...` cold starts and forces consumers to wait through installs. Load-bearing.
- **CommonJS** (`require` / `module.exports`). Do not switch to ESM; the bin file would need a different shebang strategy and the simplicity is the point.
- **`fail(msg)` for user-facing errors**, caught at the top of `main` and printed as `[bc-pkg] <msg>` on stderr with exit 1. Don't sprinkle bespoke `console.error` + `process.exit`.
- **Signal forwarding** (`runCommand`): forward `SIGINT` / `SIGTERM` to the child so Ctrl-C cleans up the wrapped process.
- **GitHub API access** goes through `ghFetch` / `ghHeaders`; do not call `fetch` directly elsewhere. `Accept: application/vnd.github.raw` for file content, default `application/vnd.github+json` for the commits endpoint.
- **Windows / macOS / Linux** are all supported; do not assume POSIX-only.

## Parity With `launcher/python`

These two launchers must stay equivalent. When changing one, mirror the other in the same change set:

| Concern | Source of truth |
|---|---|
| Spec / SHA regex | `FULL_SHA_RE`, `SPEC_RE` in both |
| Local-path detection | `isLocalSpec` / `is_local_spec` in both |
| Manifest shapes (deps.edn / package.json / pyproject.toml) | Both `write*Manifest` (GitHub) and `write*ManifestLocal` (local) |
| Cache root layout | `cacheRoot` in both |
| Default `BB_VERSION`, `JDK_VERSION` | Constants at top of `bc-pkg.js` / `cli.py` |
| Git auto-install matrix (Linux only) | `ensureGit` in both |
| Re-init error semantics | `validateExistingMetadata` + `validateExistingLocalMetadata` in both |
| Python template data resolution | None — the renderer resolves the `resources` package via `importlib.resources`, so neither launcher exposes a `./resources` directory (drop `exposePythonResources` in `launcher/typescript` for parity) |

If you find a behavioural divergence, treat it as a bug.

## What to Avoid

- Do not add runtime dependencies. Node built-ins only.
- Do not import from `big-config` / `once` / `selmer` — the launcher is independent of the BigConfig library chain.
- Do not change the on-disk artifact shape without also updating `launcher/python`.
- Do not silently auto-upgrade an initialised directory; mismatched repo/ref/sha (or local path, or local↔GitHub switch) is a hard error.
- Do not let a local target overwrite the package's own manifest: refuse when the resolved local path equals cwd. Local `run` files are symlinked, not copied.
- Do not assume the cache root is writable atomically — go through `installOnce`.

## Git

The launcher leaves are independent repos. Stay on the working branch (see `git status`) and commit only when explicitly asked. Commit messages follow Conventional Commits (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `deps:`).
