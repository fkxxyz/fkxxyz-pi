# Pi Workspace Maintenance Context

## Context

`~/pi` is the personal pi asset library, repository root, and special maintenance workspace. It contains reusable extensions, prompt documents, local packages, and test workspaces. Use this context when maintaining that directory, its repository metadata, or workspaces that help test it.

## Purpose

Maintenance should keep the library organized, composable, and easy to test. A good change makes it clear what asset was added or changed, where it belongs, and how it can be used from a pi workspace.

## Directory Model

Follow the directory standard in:

```text
~/pi/AGENTS.md
```

Main areas:

- `.pi/` configures the special root maintenance workspace.
- `.pi/skills/` stores workspace-local skills used only for repository maintenance.
- `extensions/` stores reusable pi extensions grouped by purpose.
- `agents/` stores reusable sub-agent prompt presets as Markdown files, often reachable through symlinks.
- `prompts/` stores concise reusable prompt/context documents.
- `packages/` stores local pi packages or package experiments.
- `workspaces/` stores isolated test workspaces, not the main maintenance workspace.

## Workspace Model

`~/pi` itself is the special maintenance workspace. It should contain:

```text
.pi/settings.json
AGENTS.md
```

Its `.pi/settings.json` declares the maintenance extensions and any workspace-local skills under `.pi/skills/`.

Ordinary test workspaces live under:

```text
~/pi/workspaces/<workspace-name>
```

A minimal workspace contains:

```text
.pi/settings.json
```

Add only files that have an active purpose. Use `README.md` only when the user asks for documentation or when the workspace has non-obvious manual test expectations. Do not create extra prompt copies or README files by default.

Use `.pi/settings.json` to declare the extensions, packages, prompts, or themes that the workspace should load.

## Workspace Operations

When creating a workspace, prefer a small self-contained directory that can be entered with `cd` and tested with `pi`.

When inspecting workspaces, check the root maintenance workspace `~/pi/.pi/settings.json`, then `~/pi/workspaces/`, each test workspace's `.pi/settings.json`, and its `README.md` when present.

Keep workspaces minimal. If a workspace needs to append an agent prompt, prefer a symlink from `.pi/APPEND_SYSTEM.md` to the source file under `~/pi/agents` instead of copying prompt contents. This keeps prompt edits live and avoids stale duplicates.

When modifying a test workspace, keep the change local to that workspace unless the user explicitly asks for a shared asset or root maintenance workspace change.

When deleting, overwriting, or moving existing assets, inspect first and ask for confirmation unless the user has already requested the exact destructive action.

## Agent Presets

`~/pi/agents` is the personal sub-agent prompt library. Treat it as a first-class reusable asset area alongside `extensions/` and `prompts/`.

Conventions:

- Agent presets are Markdown files discovered recursively under `~/pi/agents`.
- Symlinked directories and files are allowed and should be followed when inspecting agents.
- The sub-agent extension uses the Markdown filename without `.md` as the agent name.
- Avoid duplicate agent filenames because they create ambiguous agent names.
- When a workspace needs one agent prompt as its main identity, link it into `.pi/APPEND_SYSTEM.md`:

```bash
ln -s ~/pi/agents/<path>/<agent>.md ~/pi/workspaces/<workspace>/.pi/APPEND_SYSTEM.md
```

Do not copy agent prompts into workspaces unless the user explicitly wants a frozen snapshot.

## Composition

Test workspace loading a direct extension:

```json
{
  "extensions": [
    "../../../extensions/tool-policy/disable-basic-tools.ts"
  ]
}
```

Root maintenance workspace loading its entrypoint and local skills:

```json
{
  "extensions": [
    "../extensions/entrypoints/pi-workspace.ts"
  ],
  "skills": [
    "skills"
  ]
}
```

Prefer explicit paths for personal local assets so the active composition is easy to audit.

## Safety Boundaries

Extensions are executable code with local permissions. Treat them as code, not passive configuration.

Do not modify global pi configuration such as `~/.pi/agent/extensions` or `~/.pi/agent/settings.json` unless the user specifically asks.

Do not delete or broadly rewrite workspaces, packages, or prompt documents without clear user intent.

Test risky extension combinations in `~/pi/workspaces/` before recommending wider use or loading them in the root maintenance workspace.

## Successful Outcome

A successful maintenance result keeps `~/pi` understandable, modular, and reversible. Documentation should be concise enough to help future work without distracting the model from the current task.
