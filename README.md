# Personal pi Workflow Repository

This repository stores a personal pi workflow library: reusable extensions, preset entrypoints, prompt documents, and test workspaces. It is meant to be portable enough to clone and maintain as code while keeping machine-specific paths, local services, and external personal assets out of git.

## What Belongs Here

- `extensions/` contains reusable pi extensions grouped by purpose.
- `extensions/entrypoints/` contains composition entrypoints that load reusable extensions through the shared loader.
- `extensions/base/` contains shared infrastructure, such as the extension loader and personal config reader.
- `prompts/` contains reusable prompt/context documents.
- `workspaces/` contains small pi projects for testing extension combinations.
- `.env.example.json` documents local configuration keys without exposing real values.

External shared skills and agent prompts are intentionally not vendored into this repository. Local symlinks can expose them to extensions and workspaces during use, while `.gitignore` keeps those symlinks out of git.

## Required Local Configuration

Some extensions depend on machine-specific values such as personal service URLs or preferred project directories. Those values must live in a local ignored file:

```text
.env.json
```

Start from the committed example:

```bash
cp .env.example.json .env.json
```

Then replace placeholder values with local values:

```json
{
  "markdownPreview": {
    "baseUrl": "https://md.example.local"
  },
  "exaMcp": {
    "url": "https://exa.example.local/mcp"
  },
  "projectDirectories": {
    "thirdPartyRepos": "/path/to/src",
    "thirdPartyRepoExample": "/path/to/src/vendor/repo",
    "personalProjects": "/path/to/pro",
    "personalProjectExample": "/path/to/pro/my-project"
  }
}
```

If `.env.json` is missing, invalid, or missing a required field, the affected extension logs a warning and does nothing. This keeps the repository safe to clone without accidentally exposing or depending on private infrastructure.

Current `.env.json` consumers:

- `extensions/interaction/markdown-preview-links.ts` uses `markdownPreview.baseUrl`.
- `extensions/exa/exa-mcp.ts` uses `exaMcp.url`.
- `extensions/environment/project-directory-rules.ts` uses `projectDirectories.*`.

## Local Symlinks

The repository expects optional local symlinks for external personal assets:

```text
skills -> ~/agents/skills
agents/cclover -> <local agent prompt library>
```

These symlinks are ignored by git because their targets are machine-specific. Extensions that need shared skills resolve them through the ignored `skills` symlink using paths relative to the extension file.

Workspaces may contain relative symlinks such as:

```text
workspaces/clover8/.pi/APPEND_SYSTEM.md -> ../../../agents/cclover/clover8.md
```

Those workspace symlinks are safe to commit when their link text is relative and does not expose local absolute paths. They will work on machines where the corresponding ignored `agents/...` symlink exists.

## Default Preset Flow

The globally enabled entrypoint should be:

```text
extensions/base/conditional-preset-loader.ts
```

It checks for a `.pi/disable-preset` marker in the current directory or an ancestor. When no marker is present, it loads:

```text
extensions/entrypoints/default.ts
```

The default entrypoint reads:

```text
extensions/entrypoints/default-preset.json
```

That JSON file lists the concrete feature extensions in the default preset. This keeps global conditional loading, preset orchestration, and preset contents separate and easy to audit.

## Workspaces

Each directory under `workspaces/` is a real pi project with its own `.pi/settings.json`. Resource paths in project settings are relative to `.pi`, so a workspace can load repository extensions without absolute paths:

```json
{
  "extensions": [
    "../../../extensions/tool-policy/disable-basic-tools.ts"
  ]
}
```

Useful workspaces include:

- `workspaces/pi/` for maintaining this repository.
- `workspaces/disable-basic-tools-test/` for testing the tool-blocking policy extension.
- `workspaces/caveman-test/` for testing interaction style extensions.
- `workspaces/chat/` for a minimal chat workspace with tools disabled.

## Important Extensions

- `extensions/code/code.ts` composes the main coding workflow extensions.
- `extensions/interaction/interaction.ts` composes interaction style and progress-message extensions.
- `extensions/reasoning/reasoning.ts` composes reasoning guidance extensions.
- `extensions/sub-agent/sub-agent.ts` adds delegated sub-agent tools.
- `extensions/exa/exa-mcp.ts` bridges Exa MCP tools when `exaMcp.url` is configured.
- `extensions/system-prompt/simplify-system-prompt.ts` simplifies pi's default prompt and blocks image inputs.
- `extensions/tool-policy/disable-basic-tools.ts` removes and hard-blocks the built-in `bash`, `read`, `edit`, and `write` tools.

## Git Hygiene

Do not commit machine-specific state or generated dependencies. `.gitignore` excludes:

- `.env.json`
- `skills`
- `agents/cclover`
- `node_modules/`
- common secret, database, and log files

Before committing, check staged files and scan for known private markers:

```bash
git ls-files | sort
git grep -n -F '/home/<local-user>' || true
git grep -n -F '/run/media/<local-user>' || true
git grep -n -E '<private-domain-pattern>' || true
```

Also run a dedicated secret scanner or a local ad-hoc pattern check for credentials before publishing. The exact scan patterns can be adjusted, but the goal is stable: committed files should not contain private absolute paths, local service domains, credentials, generated dependency directories, or machine-local symlink targets.

## Quick Usage

Run an extension temporarily:

```bash
pi -e ~/pi/extensions/tool-policy/disable-basic-tools.ts
```

Use a test workspace:

```bash
cd ~/pi/workspaces/disable-basic-tools-test
pi
```

Preview configured extension dependencies from the maintenance workspace with the bundled skill helper:

```bash
cd ~/pi/workspaces/pi
skills/pi/extension-dependency-preview/scripts/preview.sh
```
