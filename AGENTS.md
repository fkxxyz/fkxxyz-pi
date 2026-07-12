# Pi Personal Presets Directory Standard

## Purpose

`~/pi/` is both the personal home for reusable pi assets and the repository root. It is also a special pi workspace: its own `.pi/settings.json` loads maintenance extensions and workspace-local skills so agents can manage the asset library, all test workspaces, and the repository itself from one place. Skill documents shared across projects are maintained separately under `~/agents/skills/` because they do not belong to any single workspace.

This `AGENTS.md` is loaded as local guidance for the special `~/pi` maintenance workspace, so it should describe the current organization rules clearly enough for future sessions to maintain all pi workspaces and shared assets consistently.

The goal is to keep personal pi customizations portable, easy to combine per project, and safe to test before wider use. When the rules, conventions, or directory model for `~/pi/` change, update this document as part of the same maintenance effort; otherwise this workspace will gradually lose the context it needs to manage the rest of the library reliably.

## Directory Layout

```text
~/pi/
├── .pi/
│   ├── settings.json
│   ├── disable-preset
│   └── skills/
│       └── pi/
│           └── <workspace-local-skill>/
├── AGENTS.md
├── README.md
├── agents.ts
├── extensions/
│   ├── base/
│   │   ├── conditional-preset-loader.ts
│   │   └── extension-loader.ts
│   ├── entrypoints/
│   │   ├── default-preset.json
│   │   └── <entrypoint-name>.ts
│   └── <category>/
│       └── <extension-name>.ts
├── prompts/
│   └── <prompt-name>.md
└── workspaces/
    └── <workspace-name>/
        ├── .pi/
        │   └── settings.json
        ├── README.md
        └── sample or fixture files
```

## Resource Lookup

`~/pi` is a logical asset workspace, not always a plain physical tree. Local asset roots may be symlinks, such as `skills -> ~/agents/skills`, and workspaces or prompt libraries may contain additional symlinked resources.

When locating pi resources such as skills, extensions, prompts, agents, or workspaces, first check whether the candidate roots are symlinks when that affects the search. Use canonical roots or symlink-aware traversal, such as `readlink -f` or `find -L`, before treating a negative search result as evidence that a resource is absent.

Keep resource discovery bounded by the known asset model. For skills, first try the loaded skill metadata and direct canonical paths such as `~/agents/skills/<name>/SKILL.md`, then search only known skill roots, workspace `.pi/skills/`, or relevant pi extension/index files. Do not use `$HOME`-wide recursive `find` or `rg` as a default way to discover pi assets; broad searches are a fallback only after narrower roots fail and the wider scope is justified.

## Conventions

### Extensions

Store reusable extensions under `~/pi/extensions/`, grouped by purpose. Concrete feature extensions belong in descriptive category directories such as `tool-policy/`, `system-prompt/`, or `sub-agent/`.

Entrypoint extensions belong under `~/pi/extensions/entrypoints/`. An entrypoint is a special extension whose primary job is composition: it loads a named set of reusable extensions through the shared loader so projects can enable one stable path instead of listing every feature extension directly. Keeping entrypoints separate from feature categories makes extension presets easier to audit and prevents orchestration code from being confused with the behavior it enables.

Example:

```text
~/pi/extensions/tool-policy/disable-basic-tools.ts
```

Infrastructure that supports extension composition but is not itself a concrete feature, entrypoint, or entrypoint configuration belongs under `~/pi/extensions/base/`. This includes the shared extension loader, the global conditional preset loader, and future shared utilities.

The global default extension set is maintained by:

```text
~/pi/extensions/base/conditional-preset-loader.ts
~/pi/extensions/entrypoints/default.ts
~/pi/extensions/entrypoints/default-preset.json
```

Only the conditional preset loader should be globally enabled. It checks for a `.pi/disable-preset` marker in the current directory or one of its parents. When the marker is absent, it loads `~/pi/extensions/entrypoints/default.ts` directly. That default entrypoint then reads `~/pi/extensions/entrypoints/default-preset.json`, whose `extensions` array lists the concrete feature extensions, such as `../code/code.ts`, that make up the default preset. This keeps conditional loading mechanics in `base/`, preset orchestration in the entrypoint, and the default feature list in a small auditable JSON file.

Extension names should be explicit and action-oriented. Prefer small focused extensions over large mixed-purpose files so projects can compose only what they need.

For flexible composition, use the shared loader when one extension should include other reusable extensions. This pattern is especially appropriate for files under `~/pi/extensions/entrypoints/`:

```ts
import { getExtensionLoader } from "../base/extension-loader.ts";

export default async function root(pi: ExtensionAPI) {
  const load = getExtensionLoader(pi).from(import.meta.url).load;
  await load("../tool-policy/disable-basic-tools.ts");
  await load("../skills/brainstorming.ts");
}
```

The loader identifies extensions by resolved module URL, so the same extension can be included from multiple roots without executing twice. It also reports circular inclusion. Keep dependency relationships explicit in code with `load(...)`; do not add hand-written ids, `defineExtension`, or `dependencies` manifests unless a future change justifies the extra protocol. Do not place concrete feature extensions or entrypoint extensions in `~/pi/extensions/base/`; that directory is reserved for composition infrastructure.

### Sub-agents

Named sub-agents are registered through TypeScript index files, not by automatically scanning Markdown files:

```text
~/pi/agents.ts
<workspace>/.pi/agents.ts
```

The global index loads first. A workspace-local `.pi/agents.ts` loads second for the target project and shallow-merges same-name entries over global entries. Use this when a project needs to override a description or replace one prompt source without redefining every global agent.

Each agent entry should include a `description` for the parent agent and exactly one source after merge:

```ts
export default {
  helper: {
    description: "Focused helper for this workspace",
    systemPromptFile: "./prompts/helper.md",
  },
};
```

Supported sources are:

- `systemPrompt` for inline prompt text.
- `systemPromptFile` for a Markdown prompt file path, absolute or relative to the defining `agents.ts`.
- `workspace` for a pi workspace path whose own settings, extensions, skills, and system prompt rules define the child session. Workspace agents do not receive an additional agent-specific prompt block.

Markdown files under `~/pi/agents/` are prompt assets only when referenced explicitly; they are no longer auto-registered as agents. Keep the global `~/pi/agents.ts` focused on reusable default agents. Prefer project `.pi/agents.ts` for project-specific names and overrides.

### Prompts

Store reusable prompt documents under `~/pi/prompts/` when they are standalone prompt assets, templates, or compatibility pointers. Prompt-writing standards that should be invoked as reusable behavior belong in skills under `~/agents/skills/`.

Before designing, editing, reviewing, or writing any prompt-like artifact, including this `AGENTS.md`, use the `prompt-best-practices` skill and read its full reference document:

```text
~/agents/skills/prompt-best-practices/prompt-best-practices.md
```

Apply that standard when updating this document: explain the maintenance context, desired outcomes, and important boundaries instead of accumulating brittle commands. This matters because `AGENTS.md` is prompt-loaded guidance; unclear or over-prescriptive edits can make future workspace maintenance less reliable.

When prompt-like text is embedded in executable source, such as TypeScript extension template strings, treat the edit as both prompt maintenance and source-code maintenance. First identify the carrier format and its escaping rules. In TS template literals, Markdown backticks and template-sensitive tokens such as `${...}` can break parsing unless escaped or avoided. Validate extension-source prompt edits with a TS-aware or pi-loader-equivalent check; `node --check` alone is not sufficient because it may accept constructs that the TypeScript extension loader rejects.

### Skills

Store reusable skill documents under:

```text
~/agents/skills/
```

This skills directory is intentionally outside `~/pi/workspaces/` and is not owned by any individual workspace. When a workspace, extension, or prompt needs to reference a shared skill, treat `~/agents/skills/` as the canonical source and refer to skills from there rather than copying them into the workspace. This keeps skill maintenance centralized and prevents workspace-specific duplicates from drifting apart.

### Runtime Pi Configuration Boundary

`~/pi` stores reusable pi assets and test workspaces, but it is not the home for all pi runtime user state. Runtime state for the installed agent lives under `~/.pi/agent/`. Keep this boundary clear so maintenance sessions do not search or edit the asset repository when the user is asking for a running pi configuration change.

Use this quick map for runtime configuration tasks:

```text
~/.pi/agent/models.json    custom providers and model metadata
~/.pi/agent/settings.json  defaultProvider, defaultModel, enabledModels, global extensions
~/.pi/agent/auth.json      auth state
~/.pi/agent/sessions/      saved sessions
```

For model, provider, default-model, enabled-model, auth, or session requests, inspect the relevant `~/.pi/agent/` files before searching `~/pi`. For model/provider/default-model changes, `models.json` and `settings.json` are usually the canonical starting point. If a requested model should match an existing model's limits or behavior, clone the closest existing entry and preserve unspecified fields. Keep `defaultProvider`, `defaultModel`, and `enabledModels` consistent when changing defaults.

### Workspaces

The root `~/pi` directory is a special workspace for maintaining this repository and all personal pi workspaces. Its `.pi/settings.json` should load maintenance-only extensions and workspace-local skills. Keep skills that are only useful for repository maintenance under `~/pi/.pi/skills/` so they do not conflict with the ignored `~/pi/skills` symlink to shared external skills.

Store test workspaces under `~/pi/workspaces/`.

Test workspaces should be real pi project directories with their own `.pi/settings.json`. Use them to test extension combinations before applying them to production projects or the root maintenance workspace.

Example from a workspace under `~/pi/workspaces/<name>`:

```json
{
  "extensions": [
    "../../../extensions/tool-policy/disable-basic-tools.ts"
  ]
}
```

Each workspace should include a short `README.md` explaining what is being tested and any sample files needed for manual verification.

## Safety Boundary

Extensions run with full local permissions. Treat every extension as executable code, not as configuration. Test new or risky extensions in `~/pi/workspaces/` before enabling them globally or in important projects.

## Current Reference Example

The first validated flow is:

```text
~/pi/extensions/tool-policy/disable-basic-tools.ts
~/pi/workspaces/disable-basic-tools-test/.pi/settings.json
```

The workspace loads only the `disable-basic-tools` extension and verifies that `bash`, `read`, `edit`, and `write` are unavailable or blocked.
