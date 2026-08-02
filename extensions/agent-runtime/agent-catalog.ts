import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const GLOBAL_AGENTS_FILE = join(homedir(), "pi", "agents.ts");
const PROJECT_AGENTS_FILE = join(".pi", "agents.ts");
const SYSTEM_PROMPT_SCRIPT_MAX_BUFFER = 10 * 1024 * 1024;
const execFileAsync = promisify(execFile);

export type AgentDefinition = {
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

export type AgentCatalog = {
  agents: Map<string, AgentDefinition>;
  mainAgent?: string;
  diagnostics: string[];
};

type AgentsFileScope = "global" | "project";

type AgentsFileContext = {
  cwd: string;
  configPath: string;
  baseDir: string;
  scope: AgentsFileScope;
};

type LoadAgentCatalogOptions = {
  includeMainAgentInAgents?: boolean;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractHelpfulErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resolveConfigPath(value: string, baseDir: string) {
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

async function resolveRawAgentsModule(moduleExports: any, context: AgentsFileContext, diagnostics: string[]): Promise<unknown> {
  const exported = moduleExports.default ?? moduleExports;
  if (typeof exported !== "function") return exported;

  try {
    return await exported(context);
  } catch (error) {
    diagnostics.push(`Could not load dynamic agents catalog from ${context.configPath}: ${extractHelpfulErrorMessage(error)}`);
    return undefined;
  }
}

async function loadAgentsFile(configPath: string, context: { cwd: string; scope: AgentsFileScope }): Promise<AgentCatalog> {
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

  const rawModule = await resolveRawAgentsModule(moduleExports, {
    cwd: context.cwd,
    configPath,
    baseDir: dirname(configPath),
    scope: context.scope,
  }, diagnostics);
  const rawAgents = isPlainObject(rawModule) && isPlainObject(rawModule.agents) ? rawModule.agents : rawModule;
  const mainAgent = isPlainObject(rawModule) && typeof rawModule.mainAgent === "string" && rawModule.mainAgent
    ? rawModule.mainAgent
    : undefined;

  if (!isPlainObject(rawAgents)) {
    diagnostics.push(`${configPath} must export an agents object as default export or named export "agents", or a function that returns one`);
    return { agents: new Map(), diagnostics };
  }

  const agents = new Map<string, AgentDefinition>();
  for (const [name, raw] of Object.entries(rawAgents)) {
    const definition = normalizeAgentDefinition(name, raw, configPath, diagnostics);
    if (definition) agents.set(name, definition);
  }

  return { agents, mainAgent, diagnostics };
}

export async function loadAgentCatalog(projectPath: string, options: LoadAgentCatalogOptions = {}): Promise<AgentCatalog> {
  const globalCatalog = await loadAgentsFile(GLOBAL_AGENTS_FILE, { cwd: projectPath, scope: "global" });
  const projectCatalog = await loadAgentsFile(resolve(projectPath, PROJECT_AGENTS_FILE), { cwd: projectPath, scope: "project" });
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

  if (mainAgent && options.includeMainAgentInAgents === false) {
    agents.delete(mainAgent);
  }

  return { agents, mainAgent, diagnostics };
}

export async function resolveAgentSystemPrompt(agent: AgentDefinition): Promise<string | null> {
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
