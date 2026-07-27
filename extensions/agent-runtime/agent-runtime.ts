import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const GLOBAL_AGENTS_FILE = join(homedir(), "pi", "agents.ts");
const PROJECT_AGENTS_FILE = join(".pi", "agents.ts");
const WORKSPACE_AGENT_AUTHORING_SKILL_PATH = fileURLToPath(new URL("./skills/workspace-agent-authoring", import.meta.url));
const ACTIVE_AGENT_ENTRY_TYPE = "active-agent";
const SYSTEM_PROMPT_SCRIPT_MAX_BUFFER = 10 * 1024 * 1024;
const execFileAsync = promisify(execFile);

type AgentDefinition = {
  name: string;
  description: string;
  configPath: string;
  baseDir: string;
  systemPrompt?: string;
  systemPromptFile?: string;
  systemPromptFiles?: string[];
  systemPromptScript?: string;
  workspace?: string;
};

type AgentCatalog = {
  agents: Map<string, AgentDefinition>;
  mainAgent?: string;
  diagnostics: string[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractHelpfulErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveConfigPath(value: string, baseDir: string) {
  return isAbsolute(value) ? value : resolve(baseDir, value);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item);
}

function countAgentSources(definition: { systemPrompt?: unknown; systemPromptFile?: unknown; systemPromptFiles?: unknown; systemPromptScript?: unknown; workspace?: unknown }) {
  return [
    typeof definition.systemPrompt === "string" && definition.systemPrompt,
    typeof definition.systemPromptFile === "string" && definition.systemPromptFile,
    isNonEmptyStringArray(definition.systemPromptFiles),
    typeof definition.systemPromptScript === "string" && definition.systemPromptScript,
    typeof definition.workspace === "string" && definition.workspace,
  ].filter(Boolean).length;
}

function normalizeAgentDefinition(name: string, raw: unknown, configPath: string, diagnostics: string[]): AgentDefinition | null {
  if (!isPlainObject(raw)) {
    diagnostics.push(`Agent "${name}" in ${configPath} must be an object`);
    return null;
  }

  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  if (!description) {
    diagnostics.push(`Agent "${name}" in ${configPath} must define a non-empty description`);
    return null;
  }

  if (raw.systemPromptFiles !== undefined && !isNonEmptyStringArray(raw.systemPromptFiles)) {
    diagnostics.push(`Agent "${name}" in ${configPath} must define systemPromptFiles as a non-empty string array`);
    return null;
  }

  if (raw.systemPromptScript !== undefined && (typeof raw.systemPromptScript !== "string" || !raw.systemPromptScript)) {
    diagnostics.push(`Agent "${name}" in ${configPath} must define systemPromptScript as a non-empty string`);
    return null;
  }

  if (countAgentSources(raw) > 1) {
    diagnostics.push(`Agent "${name}" in ${configPath} must define at most one of systemPrompt, systemPromptFile, systemPromptFiles, systemPromptScript, or workspace`);
    return null;
  }

  return {
    name,
    description,
    configPath,
    baseDir: dirname(configPath),
    systemPrompt: typeof raw.systemPrompt === "string" ? raw.systemPrompt : undefined,
    systemPromptFile: typeof raw.systemPromptFile === "string" ? raw.systemPromptFile : undefined,
    systemPromptFiles: isNonEmptyStringArray(raw.systemPromptFiles) ? raw.systemPromptFiles : undefined,
    systemPromptScript: typeof raw.systemPromptScript === "string" && raw.systemPromptScript ? raw.systemPromptScript : undefined,
    workspace: typeof raw.workspace === "string" ? raw.workspace : undefined,
  };
}

function mergeAgentDefinition(base: AgentDefinition, override: AgentDefinition): AgentDefinition {
  const merged: AgentDefinition = {
    ...base,
    name: override.name,
    description: override.description,
  };
  const overrideSources = countAgentSources(override);
  if (overrideSources > 0) {
    merged.configPath = override.configPath;
    merged.baseDir = override.baseDir;
    merged.systemPrompt = override.systemPrompt;
    merged.systemPromptFile = override.systemPromptFile;
    merged.systemPromptFiles = override.systemPromptFiles;
    merged.systemPromptScript = override.systemPromptScript;
    merged.workspace = override.workspace;
  }
  return merged;
}

async function loadAgentsFile(configPath: string): Promise<AgentCatalog> {
  const diagnostics: string[] = [];
  if (!existsSync(configPath)) return { agents: new Map(), diagnostics };

  try {
    await stat(configPath);
  } catch (error) {
    diagnostics.push(`Could not access ${configPath}: ${extractHelpfulErrorMessage(error)}`);
    return { agents: new Map(), diagnostics };
  }

  let moduleExports: any;
  try {
    moduleExports = await import(`${pathToFileURL(configPath).href}?cache=${Date.now()}-${randomUUID()}`);
  } catch (error) {
    diagnostics.push(`Could not import ${configPath}: ${extractHelpfulErrorMessage(error)}`);
    return { agents: new Map(), diagnostics };
  }

  const rawModule = moduleExports.default ?? moduleExports;
  const rawAgents = isPlainObject(rawModule) && isPlainObject(rawModule.agents)
    ? rawModule.agents
    : moduleExports.default ?? moduleExports.agents;
  const mainAgent = isPlainObject(rawModule) && typeof rawModule.mainAgent === "string" && rawModule.mainAgent
    ? rawModule.mainAgent
    : typeof moduleExports.mainAgent === "string" && moduleExports.mainAgent
      ? moduleExports.mainAgent
      : undefined;

  if (!isPlainObject(rawAgents)) {
    diagnostics.push(`${configPath} must export an agents object as default export or named export "agents"`);
    return { agents: new Map(), diagnostics };
  }

  const agents = new Map<string, AgentDefinition>();
  for (const [name, raw] of Object.entries(rawAgents)) {
    const definition = normalizeAgentDefinition(name, raw, configPath, diagnostics);
    if (definition) agents.set(name, definition);
  }

  return { agents, mainAgent, diagnostics };
}

async function loadAgentCatalog(projectPath: string): Promise<AgentCatalog> {
  const globalCatalog = await loadAgentsFile(GLOBAL_AGENTS_FILE);
  const projectCatalog = await loadAgentsFile(resolve(projectPath, PROJECT_AGENTS_FILE));
  const agents = new Map(globalCatalog.agents);
  const mainAgent = projectCatalog.mainAgent ?? globalCatalog.mainAgent;
  const diagnostics = [...globalCatalog.diagnostics, ...projectCatalog.diagnostics];

  for (const [name, definition] of projectCatalog.agents) {
    const existing = agents.get(name);
    agents.set(name, existing ? mergeAgentDefinition(existing, definition) : definition);
  }

  for (const [name, definition] of [...agents]) {
    const sources = countAgentSources(definition);
    if (sources !== 1) {
      diagnostics.push(`Agent "${name}" must define exactly one of systemPrompt, systemPromptFile, systemPromptFiles, systemPromptScript, or workspace after global/project merge`);
      agents.delete(name);
    }
  }

  if (mainAgent && !agents.has(mainAgent)) {
    diagnostics.push(`mainAgent "${mainAgent}" is not defined in merged agent catalog`);
  }

  return { agents, mainAgent, diagnostics };
}

async function resolveAgentSystemPrompt(agent: AgentDefinition): Promise<string | null> {
  if (agent.systemPrompt !== undefined) return agent.systemPrompt;
  if (agent.systemPromptFile !== undefined) {
    return readFile(resolveConfigPath(agent.systemPromptFile, agent.baseDir), "utf8");
  }
  if (agent.systemPromptFiles !== undefined) {
    const prompts = await Promise.all(agent.systemPromptFiles.map((file) => readFile(resolveConfigPath(file, agent.baseDir), "utf8")));
    return prompts.join("\n\n");
  }
  if (agent.systemPromptScript !== undefined) {
    return runSystemPromptScript(resolveConfigPath(agent.systemPromptScript, agent.baseDir), agent.baseDir);
  }
  return null;
}

async function runSystemPromptScript(scriptPath: string, cwd: string): Promise<string> {
  try {
    const result = await execFileAsync("bun", [scriptPath], {
      cwd,
      encoding: "utf8",
      maxBuffer: SYSTEM_PROMPT_SCRIPT_MAX_BUFFER,
    });
    return result.stdout;
  } catch (error) {
    if (isPlainObject(error)) {
      const status = typeof error.code === "number" || typeof error.code === "string" ? error.code : "unknown";
      const stderr = typeof error.stderr === "string" && error.stderr ? `\nstderr:\n${error.stderr}` : "";
      const stdout = typeof error.stdout === "string" && error.stdout ? `\nstdout:\n${error.stdout}` : "";
      throw new Error(`systemPromptScript ${scriptPath} failed with exit status ${status}${stderr}${stdout}`);
    }
    throw error;
  }
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
