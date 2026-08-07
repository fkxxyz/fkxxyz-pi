---
name: workspace-agent-authoring
description: Use when creating, editing, or explaining a workspace-level pi agent or sub-agent for the current project, including .pi/agents.ts, mainAgent, systemPromptFile, systemPrompt, workspace agents, or agent-runtime/sub-agent setup.
---

# Workspace Agent Authoring

Use this skill when the user wants to create or change a pi agent for the current project/workspace.

Goal: produce a small, maintainable `.pi/agents.ts` plus any prompt files needed. Prefer Markdown prompt files over large inline strings so prompts stay easy to review.

## Agent Types

- Main agent: named by `mainAgent`; injected into normal parent sessions by `agent-runtime`.
- Named sub-agent: listed in `agents`; selected through the `sub_agent` tool.
- Workspace agent: uses `workspace`; starts a child session with that workspace as cwd and loads that workspace's own settings, extensions, skills, and prompts. It does not get an extra agent-specific prompt block.

## agents.ts Shapes

Use structured form when the workspace needs a main agent:

```ts
export default {
  mainAgent: "main",
  agents: {
    main: {
      description: "Primary project agent",
      systemPromptFile: "./agents/main.md",
    },
    helper: {
      description: "Focused helper for delegated project work",
      systemPromptFile: "./agents/helper.md",
    },
  },
};
```

Use flat form when only sub-agents are needed:

```ts
export default {
  helper: {
    description: "Focused helper for delegated project work",
    systemPromptFile: "./agents/helper.md",
  },
};
```

Workspace agent example:

```ts
export default {
  roleplay: {
    description: "Roleplay chat workspace agent",
    workspace: "../roleplay-chat",
  },
};
```

## Rules

- Put project-local catalog at `<project>/.pi/agents.ts`.
- Global `~/pi/agents.ts` loads first; project `.pi/agents.ts` loads second and can override/merge entries.
- `.pi/agents.ts` may export a catalog object directly or export a sync/async function that returns one. Use a function only when agents or `mainAgent` need local-state-derived generation. The function receives `{ cwd, configPath, baseDir, scope }` and should use `ctx.cwd` or `ctx.baseDir` instead of `process.cwd()` for workspace-local discovery.
- Every agent needs a non-empty `description` and exactly one source: `systemPrompt`, `systemPromptFile`, `systemPromptFiles`, `systemPromptScript`, or `workspace`.
- Relative `systemPromptFile`, `systemPromptFiles`, `systemPromptScript`, and `workspace` paths resolve from the directory containing the defining `agents.ts`.
- `systemPromptFiles` must be a non-empty array of strings. Files are read in array order and joined with a blank line.
- `systemPromptScript` must be a non-empty string. Pi runs the TypeScript script with `bun` from the defining `agents.ts` directory and uses stdout exactly as the prompt. Use it only for trusted local scripts.
- `mainAgent` must name an existing agent, but main agents are not offered as sub-agents.
- Main agents need `agent-runtime`; named sub-agents need `sub-agent`, directly or through a preset.

## Validation

After editing, verify `.pi/agents.ts` parses, referenced prompt files, prompt scripts, or workspace paths exist, `mainAgent` points to an existing entry, and no agent defines multiple sources.
