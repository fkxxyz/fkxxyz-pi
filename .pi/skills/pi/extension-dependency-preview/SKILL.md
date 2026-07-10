---
name: extension-dependency-preview
description: Preview pi extension dependency trees from entrypoint extensions. Use when asked to list, inspect, summarize, or preview loaded pi extensions and their dependency tree, especially from settings.json entrypoints, conditional presets, or shared extension-loader load() calls.
---

# Extension Dependency Preview

## Context

Pi extensions in this workspace are usually composed through entrypoint extensions and the shared loader at `~/pi/extensions/base/extension-loader.ts`. A dependency preview should help the user understand what is actually loaded without drowning them in absolute paths, package internals, or implementation details.

The user usually wants a compact operational view: which entrypoints are active, which extension categories they pull in, which presets are skipped, and which notable extensions are not loaded. Accuracy matters, but readability is the primary output goal.

## Desired Outcome

Produce a short dependency tree using extension category/name paths, not full absolute paths. Separate actual loaded roots from skipped presets or unloaded known extensions when that distinction is relevant.

A good result looks like:

```text
actual loaded
└── entrypoints/pi-workspace
    ├── interaction/interaction
    │   ├── caveman
    │   └── markdown-preview-links
    └── code/code
        └── reasoning/reasoning
            └── root-cause-analysis
```

Use full paths only when needed for disambiguation, diagnosis, or when the user asks for exact files.

## What To Inspect

Start from configured entrypoints, not from a blind full-library scan.

Relevant root sources commonly include:

- Global settings such as `~/.pi/agent/settings.json`
- Current workspace `.pi/settings.json`
- Explicit extension paths mentioned by the user
- Project-local or auto-discovered extension locations only if they are relevant to the current question

Treat configured extension paths as roots even when they are not under `entrypoints/`. For example, `base/conditional-preset-loader` can be an active root that conditionally references `entrypoints/default`.

When the user asks for “all entrypoint extensions,” default to roots configured in settings plus entrypoints reachable from those roots. Do not scan every file under `entrypoints/` as loaded unless the user explicitly asks for an inventory of all entrypoint files.

When a conditional preset loader is present, inspect whether the current directory or an ancestor contains `.pi/disable-preset`. This decides whether default preset dependencies are actually loaded or should be shown as skipped.

## Dependency Signals

Follow composition mechanisms that actually add extension dependencies:

- `getExtensionLoader(pi).from(...).load(...)`
- `loadMany(...)`
- preset JSON files whose `extensions` array is read by an entrypoint, such as `default-preset.json`

Imports alone are not dependency-tree edges unless the imported module is itself being loaded as an extension factory. Package dependencies, `node_modules`, and helper modules should normally be ignored.

## Efficient Investigation Strategy

A fast dependency preview should start with one compact agent-readable snapshot: settings roots, conditional markers, and extension composition signals. This reduces tool-call token cost while keeping dependency-tree judgment with the agent instead of burying it in a brittle parser.

Run the bundled helper script by resolving it relative to this skill directory, not relative to the current workspace:

```text
scripts/preview.sh
```

Use the resolved absolute path in tool calls. Do not run `./preview.sh` from the workspace cwd.

The script output has three sections:

- `settings roots`: configured extension roots from global and current workspace settings.
- `markers`: `.pi/disable-preset` markers found in the current directory or its ancestors.
- `extension edges`: composition signals from the extension library, including awaited loader calls, preset JSON entries, and constants that point to extension or preset files.

Use the snapshot to identify active roots, skipped conditional presets, and reachable extension edges. Build the final dependency tree from those signals. Avoid broad `find` output that includes `node_modules`, lockfiles, package metadata, or unrelated extension categories.

## Output Style

Prefer concise preview formatting:

- Omit common prefix like `~/pi/extensions/`
- Omit `.ts` where clear
- Collapse obvious category groups when useful, for example:

```text
└── environment/*
    ├── shared-skill-discovery
    ├── arch-package-management
    └── project-directory-rules
```

- Mark skipped branches inline, for example `[skipped: .pi/disable-preset]`
- When first-pass output contains skipped preset edges, show them under a skipped/default preset section or as a skipped child, not as actual loaded extensions.
- Separate sections such as `actual loaded`, `skipped/default preset`, and `not loaded` when helpful. Never mix skipped preset dependencies into the actual-loaded branch just because their edges were visible in the first-pass output.

Do not print long absolute-path trees by default. The preview should be easy to scan in a terminal or browser chat.

## Boundaries

Do not modify extensions or settings while only previewing dependencies.

Do not infer that every file under `~/pi/extensions/` is loaded. Only include files reachable from active roots, plus a clearly labeled `not loaded` section when useful.

Do not treat npm package dependencies as pi extension dependencies.

If a dynamic dependency cannot be resolved statically, say so and show the closest known parent rather than guessing.
