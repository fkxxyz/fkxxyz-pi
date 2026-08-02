import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import type { AgentCatalog, AgentDefinition } from "./agent-catalog.ts";
import { loadAgentCatalog, resolveAgentSystemPrompt } from "./agent-catalog.ts";

const WORKSPACE_AGENT_AUTHORING_SKILL_PATH = fileURLToPath(new URL("./skills/workspace-agent-authoring", import.meta.url));
const ACTIVE_AGENT_ENTRY_TYPE = "active-agent";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getCwd(ctx: unknown) {
  return isPlainObject(ctx) && typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();
}

function buildAgentSystemPrompt(base: string, agent: AgentDefinition, prompt: string, role: "main" | "active") {
  return `${base}\n\nYou are ${agent.name}. You are currently running as the ${role} workspace agent, interacting directly with the user. The following block defines your identity and behavior instructions.\n\n<agent_instructions agent="${agent.name}" role="${role}" source="${agent.configPath}">\n${prompt}\n</agent_instructions>`;
}

function getActiveAgentName(ctx: unknown): string | null | undefined {
  if (!isPlainObject(ctx) || !isPlainObject(ctx.sessionManager) || typeof ctx.sessionManager.getEntries !== "function") {
    return undefined;
  }

  const entries = ctx.sessionManager.getEntries();
  if (!Array.isArray(entries)) return undefined;

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!isPlainObject(entry) || entry.type !== "custom" || entry.customType !== ACTIVE_AGENT_ENTRY_TYPE) continue;
    const data = entry.data;
    if (!isPlainObject(data)) return null;
    if (data.name === null) return null;
    return typeof data.name === "string" && data.name.trim() ? data.name.trim() : null;
  }

  return undefined;
}

function getSwitchableAgents(catalog: AgentCatalog) {
  return [...catalog.agents.values()].filter((agent) => !agent.workspace);
}

function notify(ctx: unknown, message: string, level: "info" | "warning" | "error" = "info") {
  if (isPlainObject(ctx) && isPlainObject(ctx.ui) && typeof ctx.ui.notify === "function") {
    ctx.ui.notify(message, level);
  }
}

export default function agentRuntimeExtension(pi: ExtensionAPI) {
  pi.on("resources_discover", async () => ({
    skillPaths: [WORKSPACE_AGENT_AUTHORING_SKILL_PATH],
  }));

  pi.on("before_agent_start", async (event, ctx) => {
    const catalog = await loadAgentCatalog(getCwd(ctx));
    const activeAgentName = getActiveAgentName(ctx);
    const agentName = activeAgentName ?? catalog.mainAgent;
    if (!agentName) return;

    const agent = catalog.agents.get(agentName);
    if (!agent) {
      if (activeAgentName) notify(ctx, `Active agent "${activeAgentName}" is not defined; no agent prompt injected.`, "warning");
      return;
    }
    if (agent.workspace) {
      notify(ctx, `Active agent "${agent.name}" is a workspace agent and cannot be injected into the current session.`, "warning");
      return;
    }

    const prompt = await resolveAgentSystemPrompt(agent);
    if (prompt === null) return;

    return {
      systemPrompt: buildAgentSystemPrompt(event.systemPrompt, agent, prompt, activeAgentName ? "active" : "main"),
    };
  });

  pi.registerCommand("agent", {
    description: "Switch the active agent prompt for the current session",
    getArgumentCompletions: (prefix: string) => {
      const items = ["status", "list", "default", "off"];
      const matches = items.filter((item) => item.startsWith(prefix));
      return matches.length ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const catalog = await loadAgentCatalog(getCwd(ctx));
      const arg = args.trim();
      const switchableAgents = getSwitchableAgents(catalog);

      if (arg === "status") {
        const activeAgentName = getActiveAgentName(ctx);
        const agentName = activeAgentName ?? catalog.mainAgent;
        notify(ctx, agentName ? `Active agent: ${agentName}${activeAgentName ? "" : " (default)"}` : "Active agent: none", "info");
        return;
      }

      if (arg === "list") {
        const names = switchableAgents.map((agent) => agent.name).join(", ");
        notify(ctx, names ? `Switchable agents: ${names}` : "No switchable agents found", "info");
        return;
      }

      if (arg === "default" || arg === "off") {
        pi.appendEntry(ACTIVE_AGENT_ENTRY_TYPE, { name: null });
        notify(ctx, catalog.mainAgent ? `Active agent reset to default: ${catalog.mainAgent}` : "Active agent reset to default", "info");
        return;
      }

      let selectedName = arg;
      if (!selectedName) {
        if (!isPlainObject(ctx.ui) || typeof ctx.ui.select !== "function") {
          notify(ctx, "Usage: /agent <name|status|list|default|off>", "info");
          return;
        }
        const choices = ["default", ...switchableAgents.map((agent) => agent.name)];
        const choice = await ctx.ui.select("Select active agent for this session", choices);
        if (!choice) return;
        selectedName = choice;
      }

      if (selectedName === "default") {
        pi.appendEntry(ACTIVE_AGENT_ENTRY_TYPE, { name: null });
        notify(ctx, catalog.mainAgent ? `Active agent reset to default: ${catalog.mainAgent}` : "Active agent reset to default", "info");
        return;
      }

      const selectedAgent = catalog.agents.get(selectedName);
      if (!selectedAgent) {
        notify(ctx, `Agent "${selectedName}" is not defined. Use /agent list to see available agents.`, "error");
        return;
      }
      if (selectedAgent.workspace) {
        notify(ctx, `Agent "${selectedName}" is a workspace agent and cannot be activated inside the current session.`, "error");
        return;
      }

      pi.appendEntry(ACTIVE_AGENT_ENTRY_TYPE, { name: selectedName });
      notify(ctx, `Active agent switched to: ${selectedName}`, "info");
    },
  });
}
