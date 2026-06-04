# bc-pkg

`bc-pkg` creates or reuses a BigConfig CLI in the current directory, then
forwards your command to that CLI.

The PyPI package and the npm package expose the same behavior. The target
package can be implemented in Clojure, TypeScript, or Python; `bc-pkg` infers
that language from the pinned GitHub content.

## Usage

```sh
uvx bc-pkg <owner/repo@ref> package validate
uvx bc-pkg package validate
```

`ref` can be a branch name or a full 40-character commit SHA:

```sh
uvx bc-pkg bigconfig-ai/once@python package validate
uvx bc-pkg bigconfig-ai/once@2f4e8c0d0b4c4b8f0c3a9f6e2a1b5c7d8e9f0123 package validate
```

On the first run, `bc-pkg` resolves the ref to a full SHA and pins it. Later
runs omit `<owner/repo@ref>` and keep using the pinned SHA.

## Local repositories

For live local development you can point `bc-pkg` at a local checkout of a
target package instead of a GitHub spec. The first argument is treated as a
local path when it starts with `/`, `./`, `../`, `~`, or is `.`/`..`:

```sh
uvx bc-pkg ../once/python package build
uvx bc-pkg /abs/path/to/once/clojure package build
```

Local targets are wired up **live** — your uncommitted edits in the local
package are picked up on the next run, with no SHA pinning and no push:

| Target language | Local dependency |
| --- | --- |
| Clojure | `deps.edn` / `bb.edn` use `:local/root` |
| TypeScript | `package.json` uses a `file:` dependency |
| Python | `pyproject.toml` uses an editable `[tool.uv.sources]` path |

The `run` file is symlinked (not copied) so run-file edits are also live. Run
`bc-pkg` from a **separate** directory; pointing it at the current directory is
refused so it never overwrites the package's own manifest. Switching an
initialized directory between local and GitHub (or to a different local path) is
a hard error, just like a repo/ref/SHA mismatch.

Notes: TypeScript local dev requires the local package to be built (its
`dist/`); Python local dev installs the package editable. Python template data
ships as a top-level `resources` package, which the BigConfig SDK renderer resolves
through `importlib.resources`, so no `./resources` directory is created.

## What is created

The launcher copies the target package's root `run` file into the current
directory and writes language-native metadata:

| Target language | Manifest | Runtime command |
| --- | --- | --- |
| Clojure | `deps.edn` | `bb run ...` |
| TypeScript | `package.json` | `node run ...` |
| Python | `pyproject.toml` | `uv run python run ...` |

For Clojure targets, a small `bb.edn` runtime dependency file is also written so
Babashka can load the pinned Git dependency.

If the directory is already initialized for a different repo/ref/SHA, `bc-pkg`
exits with an error instead of updating it implicitly.

## Requirements

- Python launcher: Python >= 3.11.
- TypeScript target packages: Node.js and npm must already be installed.
- Python target packages: Python and `uv` must already be installed.
- Clojure target packages: `bc-pkg` downloads pinned Babashka and Temurin JDK
  versions into a shared user cache and checks/installs `git` on Linux.

## Environment

| Variable | Effect |
| --- | --- |
| `GITHUB_TOKEN` | Used for private GitHub repos or higher API rate limits. |
| `BB_VERSION` | Override the Babashka version for Clojure targets. |
| `JDK_VERSION` | Override the Temurin JDK feature version for Clojure targets. |

## Cache

Babashka and JDK downloads are shared across projects under:

- macOS/Linux: `$XDG_CACHE_HOME/bc-pkg` or `~/.cache/bc-pkg`
- Windows: `%LOCALAPPDATA%/bc-pkg`
