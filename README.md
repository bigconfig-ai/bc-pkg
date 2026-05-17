# @bigconfig/bb

Run [babashka](https://babashka.org) (`bb`) without installing anything first.
On its first invocation this package downloads a pinned babashka binary **and**
an Eclipse Temurin JDK into a shared user cache, then forwards every argument
to `bb`.

## Usage

```sh
npx @bigconfig/bb tasks        # -> bb tasks
npx @bigconfig/bb <args...>    # -> bb <args...>
```

All arguments (including flags) are passed through verbatim, and `bb` runs in
your current working directory, so it picks up the local `bb.edn`.

## What happens on first run

1. The host OS/CPU are resolved to the matching babashka release asset and
   Adoptium API parameters.
2. babashka is downloaded from its GitHub releases and cached.
3. A Temurin JDK is downloaded from the Adoptium API and cached.
4. `bb` is launched with `JAVA_HOME` / `PATH` pointing at the cached JDK — the
   environment change applies **only** to the `bb` subprocess, nothing
   system-wide.

Subsequent runs reuse the cache and start immediately.

## git (Linux only)

On Linux, if `git` is not on `PATH`, it is installed via the system package
manager (`apt-get`, `dnf`, `yum`, `zypper`, `pacman`, or `apk`), using `sudo`
when not running as root. This is **skipped** when git is already present, and
is a **no-op on macOS/Windows**. Unlike babashka/JDK, this modifies the system
and may prompt for a sudo password; in non-interactive environments without
passwordless sudo it will fail with an actionable message — pre-install git to
avoid this entirely.

## bb.edn bootstrap (optional)

If the current directory has **no `bb.edn`** and `BB_EDN_REPO=owner/project`
is set, that repo's `bb.edn` is downloaded (pinned to its default branch's
latest commit) and the repo itself is added to `:deps` as
`io.github.<owner>/<project> {:git/sha "<sha>"}`. The edit is done with
`borkdude/rewrite-edn`, so existing comments and formatting are preserved.

Any dependency using `:local/root` (in `:deps` or a task's `:extra-deps`) is
removed first, since those paths don't exist once the file is downloaded.
Valid Maven/git deps are kept.

- Skipped entirely if `BB_EDN_REPO` is unset or a `bb.edn` already exists.
- Fatal error if the repo is missing/inaccessible or has no `bb.edn`.
- Set `GITHUB_TOKEN` for private repos or to avoid GitHub's unauthenticated
  API rate limit.

```sh
BB_EDN_REPO=my-org/shared-tasks npx @bigconfig/bb tasks
```

## Cache location

A single shared directory, reused across all projects:

| Platform      | Path                                         |
| ------------- | -------------------------------------------- |
| macOS / Linux | `$XDG_CACHE_HOME` or `~/.cache` → `bigconfig-bb/` |
| Windows       | `%LOCALAPPDATA%` → `bigconfig-bb/`           |

Delete that directory to force a clean reinstall.

## Configuration

| Env var               | Default    | Effect                                          |
| --------------------- | ---------- | ----------------------------------------------- |
| `BB_VERSION`          | `1.12.196` | babashka release version to install             |
| `JDK_VERSION`         | `21`       | Temurin feature version (e.g. `17`, `21`, `25`) |
| `BB_EDN_REPO`         | _(unset)_  | `owner/project` to bootstrap a `bb.edn` from (see below) |
| `GITHUB_TOKEN`        | _(unset)_  | Used for `BB_EDN_REPO` (private repos / higher API rate limit) |
| `REWRITE_EDN_VERSION` | `0.5.9`    | `borkdude/rewrite-edn` version used to edit the `bb.edn` |

## Supported platforms

macOS arm64, macOS x64, Linux x64, Linux arm64, Windows x64.

Notes:

- Linux x64 uses babashka's glibc build (may not run on musl distros such as
  Alpine). Linux arm64 uses babashka's static build, which runs on both glibc
  and musl.
- Extraction uses the system `tar` (present on macOS, Linux, and Windows
  10+); Windows falls back to PowerShell `Expand-Archive` for `.zip` if `tar`
  is unavailable.

## Requirements

Node.js >= 18.
