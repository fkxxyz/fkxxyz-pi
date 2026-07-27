import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const GLOBAL_AGENTS_FILE = join(homedir(), "pi", "agents.ts");
const PROJECT_AGENTS_FILE = join(".pi", "agents.ts");
const WORKSPACE_AGENT_AUTHORING_SKILL_PATH = fileURLToPath(new URL("./skills/workspace-agent-authoring", import.meta.url));

type AgentDefinition = {
  name: string;
  description: string;
  configPath: string;
  baseDir: string;
  systemPrompt?: string;
  systemPromptFile?: string;
  systemPromptFiles?: string[];
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

function countAgentSources(definition: { systemPrompt?: unknown; systemPromptFile?: unknown; systemPromptFiles?: unknown; workspace?: unknown }) {
  return [
    typeof definition.systemPrompt === "string" && definition.systemPrompt,
    typeof definition.systemPromptFile === "string" && definition.systemPromptFile,
    isNonEmptyStringArray(definition.systemPromptFiles),
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

  if (countAgentSources(raw) > 1) {
    diagnostics.push(`Agent "${name}" in ${configPath} must define at most one of systemPrompt, systemPromptFile, systemPromptFiles, or workspace`);
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
      diagnostics.push(`Agent "${name}" must define exactly one of systemPrompt, systemPromptFile, systemPromptFiles, or workspace after global/project merge`);
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
  return null;
}

function getCwd(ctx: unknown) {
  return isPlainObject(ctx) && typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();
}

function buildMainAgentSystemPrompt(base: string, agent: AgentDefinition, prompt: string) {
  return `${base}\n\n<agent_instructions agent="${agent.name}" role="main" source="${agent.configPath}">\n${prompt}\n</agent_instructions>`;
}

export default function agentRuntimeExtension(pi: ExtensionAPI) {
  pi.on("resources_discover", async () => ({
    skillPaths: [WORKSPACE_AGENT_AUTHORING_SKILL_PATH],
  }));

  pi.on("before_agent_start", async (event, ctx) => {
    const catalog = await loadAgentCatalog(getCwd(ctx));
    if (!catalog.mainAgent) return;

    const agent = catalog.agents.get(catalog.mainAgent);
    if (!agent) return;

    const prompt = await resolveAgentSystemPrompt(agent);
    if (prompt === null) return;

    return {
      systemPrompt: buildMainAgentSystemPrompt(event.systemPrompt, agent, prompt),
    };
  });
}
