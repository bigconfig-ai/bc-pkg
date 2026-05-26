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

## What is created

The launcher copies the target package's root `run` file into the current
directory and writes language-native metadata:

| Target language | Manifest | Runtime command |
| --- | --- | --- |
| Clojure | `deps.edn` | `bb run ...` |
| TypeScript | `package.json` | `node run ...` |
| Python | `pyproject.toml` | `python run ...` |

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
