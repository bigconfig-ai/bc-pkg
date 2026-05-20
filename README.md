# @bigconfig/bb

Run [babashka](https://babashka.org) (`bb`) without installing anything first.
On its first invocation this package downloads a pinned babashka binary **and**
an Eclipse Temurin JDK into a shared user cache, then forwards every argument
to `bb`.

## Usage

```sh
npx @bigconfig/bb@latest tasks                       # -> bb tasks
npx @bigconfig/bb@latest <args...>                   # -> bb <args...>
npx @bigconfig/bb@latest <owner>/<project> <args...> # bootstrap bb.edn, then -> bb <args...>
```

All other arguments (including flags) are passed through verbatim, and `bb`
runs in your current working directory, so it picks up the local `bb.edn`. If
the first argument has the shape `owner/project`, it is consumed as the
bootstrap repo (see [bb.edn bootstrap](#bbedn-bootstrap-optional)) and not
forwarded to `bb`.

## What happens on first run

1. The host OS/CPU are resolved to the matching babashka release asset and
   Adoptium API parameters.
2. babashka is downloaded from its GitHub releases and cached.
3. A Temurin JDK is downloaded from the Adoptium API and cached.
4. On Linux, `git` is installed via the system package manager if it is not on
   `PATH`.
5. If a `<owner>/<project>` slug is the first argument, a `bb.edn` is
   bootstrapped from that repo.
6. `bb` is launched with `JAVA_HOME` / `PATH` pointing at the cached JDK (and
   the cached `bb`, so nested `bb` calls work) — the environment change applies
   **only** to the `bb` subprocess.

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

If the current directory has **no `bb.edn`** and the first argument has the
shape `owner/project`, that repo's `bb.edn` is downloaded (pinned to its
default branch's latest commit) and the repo itself is added to `:deps` as
`io.github.<owner>/<project> {:git/sha "<sha>"}`. The edit is done with
`borkdude/rewrite-edn`, so existing comments and formatting are preserved.
The slug is consumed; remaining arguments are forwarded to `bb`.

Any dependency using `:local/root` (in `:deps` or a task's `:extra-deps`) is
removed first, since those paths don't exist once the file is downloaded.
Valid Maven/git deps are kept.

- Skipped entirely if no slug is given or a `bb.edn` already exists.
- Fatal error if the repo is missing/inaccessible or has no `bb.edn`.
- Set `GITHUB_TOKEN` for private repos or to avoid GitHub's unauthenticated
  API rate limit.

```sh
npx @bigconfig/bb@latest my-org/shared-tasks tasks
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
| `GITHUB_TOKEN`        | _(unset)_  | Used for the bb.edn bootstrap (private repos / higher API rate limit) |
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

## Development Docker image

This repository also includes a `Dockerfile` and `bb.edn` tasks for a
throwaway development shell. The former Makefile workflow now lives in
`bb.edn`. The image is based on Ubuntu 24.04 and installs Node.js, the pi
coding agent, Claude, `ripgrep`, `fd`, and `sudo`. Requires Docker. Commands
below assume `bb` is on `PATH`; use `node bin/bb.js <task>` to exercise the
local launcher instead.

If these tasks are bootstrapped into an empty directory by passing
`bigconfig-ai/npm-bb` as the first argument, the missing `Dockerfile` is
downloaded into that directory from the same pinned GitHub SHA as the
bootstrapped `bb.edn`:

```sh
mkdir empty && cd empty
npx @bigconfig/bb@latest bigconfig-ai/npm-bb shell
```

```sh
bb tasks                 # list repository tasks
bb build                 # build npm-bb:dev
bb build --no-cache      # rebuild without Docker layer cache
bb shell                 # build, create a generated home, then open bash
bb shell --skip-build    # reuse the existing image
```

`bb shell` creates a writable host directory under `homes/<random-name>` and
mounts it at `/home/developer` in the container. Before starting Docker it
copies `~/.pi/agent/auth.json` and `~/.pi/agent/settings.json` into that
generated home when those files exist; missing files are skipped. Use
`--project-subdir PATH` to mount a specific host directory instead, and
`bb homes` / `bb clean --all` to list or remove generated homes.

Common options are available as flags or environment variables:

| Option / env | Default | Effect |
| ------------ | ------- | ------ |
| `--image` / `IMAGE` | `npm-bb` | Docker image name |
| `--tag` / `TAG` | `dev` | Docker image tag |
| `--node-major` / `NODE_MAJOR` | `24` | Node.js major version build arg |
| `--no-cache` | `false` | Pass `--no-cache` to `docker build` |
| `--workdir` / `WORKDIR` | `/home/developer` | Container working directory |
| `--name` / `DOCKER_STYLE_RANDOM_NAME` | random | Container hostname and generated home name |
| `--project-subdir` / `PROJECT_SUBDIR` | `homes/<name>` | Host directory mounted into the container |
| `--docker-run-arg ARG` | _(none)_ | Extra `docker run` argument; repeat as needed |
| `--dry-run` | `false` | Print commands without executing them |

Run `bb options` for the full option list.

## Requirements

Node.js >= 18.
