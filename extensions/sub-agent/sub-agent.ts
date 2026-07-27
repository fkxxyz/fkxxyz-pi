import type { AgentSession, AgentSessionEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  initTheme,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const GLOBAL_AGENTS_FILE = join(homedir(), "pi", "agents.ts");
const PROJECT_AGENTS_FILE = join(".pi", "agents.ts");
const AGENT_RUNTIME_EXTENSION_SUFFIX = "/extensions/agent-runtime/agent-runtime.ts";
const ACTIVE_AGENT_ENTRY_TYPE = "active-agent";
const POLL_INTERVAL_MS = 1000;
const MAX_DEPTH = 8;
const SYSTEM_PROMPT_SCRIPT_MAX_BUFFER = 10 * 1024 * 1024;
const SUB_AGENT_ID_EPOCH_MS = Date.UTC(2000, 0, 1);
const SHORT_SESSION_ID_PATTERN = /^[0-9a-z]{1,9}_[0-9a-f]{8}$/;
const SESSION_FILE_TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/;
const SESSION_FILE_HASH_PATTERN = /([0-9a-f]{8})(?:\.jsonl)$/i;
const FORKED_SUBAGENT_CONTEXT = `<forked_subagent_context>
You are a forked sub-agent.

All conversation history and tool results that existed before this fork request are inherited context. Treat them as background reference only, even if they appear to be your own prior messages, plans, approvals, or unfinished work.

Your active task is exactly the fork request prompt that follows this context block, not any broader task, momentum, or intent found in the inherited context.

Do not inherit task ownership, execution authority, prior approvals, or obligation to continue work from the inherited context. Tool use, edits, side effects, or completing the broader task require explicit authorization in the fork request prompt itself.

If inherited context conflicts with the fork request prompt, the fork request prompt wins. If scope is unclear, stop and report the ambiguity instead of acting beyond the fork request.
</forked_subagent_context>`;

type AgentResultStatus = "running" | "completed" | "error" | "not_found" | "stopped";
type WaitMode = "none" | "any" | "all";

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

type AgentResultPayload = {
  session_id: string;
  session_file: string | null;
  status: AgentResultStatus;
  content: string | null;
  partial_content: string | null;
  error: string | null;
  duration_ms: number;
};

type SubAgentRun = {
  id: string;
  agentName: string;
  projectPath: string;
  prompt: string;
  depth: number;
  createdAt: number;
  completedAt?: number;
  status: AgentResultStatus;
  content: string | null;
  partial_content: string | null;
  error: string | null;
  session: AgentSession;
  mode: "fork" | "isolated";
  forkContextSent?: boolean;
  unsubscribe?: () => void;
  promise?: Promise<void>;
  updateCallback?: (partialResult: { content: Array<{ type: "text"; text: string }>; details: AgentResultPayload }) => void;
  piWebLive?: PiWebLiveSessionRegistration;
};

type PiWebLiveSessionRegistration = {
  setPromptRunning(running: boolean): void;
  unregister(): void;
};

type PiWebLiveSessionWrapper = {
  sessionId: string;
  sessionFile: string;
  isAlive(): boolean;
  isRunning(): boolean;
  onEvent(listener: (event: AgentSessionEvent | Record<string, unknown>) => void): () => void;
  send(command: Record<string, unknown>): Promise<unknown>;
  destroy(): void;
};

type PiWebGlobalState = typeof globalThis & {
  __piSessions?: Map<string, PiWebLiveSessionWrapper>;
  __piRunningListeners?: Set<(ids: string[]) => void>;
};

type CreateRunSuccess = {
  ok: true;
  run: SubAgentRun;
};

type CreateRunFailure = {
  ok: false;
  error: string;
  session_id?: string;
};

type CreateRunResult = CreateRunSuccess | CreateRunFailure;

type SubAgentStartedPayload = {
  session_id: string;
  session_file: string | null;
};

type SubAgentCompletedPayload = {
  session_id: string;
  response: string;
};

type SubAgentCreateFailurePayload = {
  session_id?: string;
  error: string;
};

type SubAgentUnknownErrorPayload = {
  session_id?: string;
  error: string;
  message: string;
  possible_causes: string[];
  available_agents: string[];
};

type SubAgentStopPayload = {
  session_id: string;
  status: "stopped" | "not_found" | "error";
  error: string | null;
};

type SubAgentToolPayload =
  | SubAgentStartedPayload
  | SubAgentCompletedPayload
  | SubAgentCreateFailurePayload
  | SubAgentUnknownErrorPayload
  | AgentResultPayload
  | AgentResultPayload[]
  | SubAgentStopPayload;

// Used only to pass recursion depth into auto-loaded nested extension instances.
// The run registry itself intentionally stays inside each extension instance.
const execFileAsync = promisify(execFile);
const depthContext = new AsyncLocalStorage<number>();

function notifyPiWebRunningChange() {
  const state = globalThis as PiWebGlobalState;
  const registry = state.__piSessions;
  if (!(registry instanceof Map)) return;

  const ids = new Set<string>();
  for (const [sessionId, session] of registry) {
    try {
      if (typeof session?.isRunning === "function" && session.isRunning()) ids.add(session.sessionId || sessionId);
    } catch {
      // A broken foreign wrapper must not break sub-agent cleanup or pi-web routes.
    }
  }

  for (const listener of state.__piRunningListeners ?? []) {
    try {
      listener([...ids]);
    } catch {
      // Match pi-web's listener isolation: one failed SSE client must not affect others.
    }
  }
}

function registerPiWebLiveSession(run: SubAgentRun): PiWebLiveSessionRegistration | undefined {
  const state = globalThis as PiWebGlobalState;
  if (state.__piSessions !== undefined && !(state.__piSessions instanceof Map)) {
    console.warn("[sub-agent] pi-web live-session adapter disabled: globalThis.__piSessions is not a Map");
    return undefined;
  }

  const sessionId = run.session.sessionId;
  if (!sessionId) return undefined;

  const listeners = new Set<(event: AgentSessionEvent | Record<string, unknown>) => void>();
  let alive = true;
  let promptRunning = run.status === "running";
  let unsubscribe: (() => void) | undefined;

  const wrapper: PiWebLiveSessionWrapper = {
    get sessionId() {
      return run.session.sessionId;
    },
    get sessionFile() {
      return run.session.sessionFile ?? run.session.sessionManager?.getSessionFile?.() ?? "";
    },
    isAlive() {
      return alive;
    },
    isRunning() {
      return alive && (promptRunning || !!run.session.isStreaming || !!(run.session as any).isCompacting || !!(run.session as any).isBashRunning);
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async send(command) {
      const type = command.type;
      if (type === "get_state") {
        const contextUsage = typeof (run.session as any).getContextUsage === "function" ? (run.session as any).getContextUsage() : null;
        return {
          sessionId: run.session.sessionId,
          sessionFile: run.session.sessionFile ?? run.session.sessionManager?.getSessionFile?.() ?? "",
          isStreaming: !!run.session.isStreaming,
          isPromptRunning: promptRunning,
          isBashRunning: !!(run.session as any).isBashRunning,
          isCompacting: !!(run.session as any).isCompacting,
          autoCompactionEnabled: !!(run.session as any).autoCompactionEnabled,
          autoRetryEnabled: !!(run.session as any).autoRetryEnabled,
          model: run.session.model ? { id: run.session.model.id, provider: run.session.model.provider } : undefined,
          messageCount: 0,
          pendingMessageCount: (run.session as any).pendingMessageCount ?? 0,
          queuedMessages: {
            steering: typeof (run.session as any).getSteeringMessages === "function" ? [...(run.session as any).getSteeringMessages()] : [],
            followUp: typeof (run.session as any).getFollowUpMessages === "function" ? [...(run.session as any).getFollowUpMessages()] : [],
          },
          contextUsage: contextUsage
            ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow, tokens: contextUsage.tokens }
            : null,
          systemPrompt: (run.session as any).agent?.state?.systemPrompt ?? "",
          thinkingLevel: (run.session as any).agent?.state?.thinkingLevel ?? run.session.thinkingLevel ?? "off",
          extensionStatuses: [],
          extensionWidgets: [],
        };
      }
      if (type === "abort") {
        await run.session.abort();
        return null;
      }
      throw new Error(`Unsupported sub-agent pi-web live adapter command: ${String(type)}`);
    },
    destroy() {
      registration.unregister();
    },
  };

  const registration: PiWebLiveSessionRegistration = {
    setPromptRunning(running: boolean) {
      if (!alive) return;
      promptRunning = running;
      notifyPiWebRunningChange();
    },
    unregister() {
      if (!alive) return;
      alive = false;
      unsubscribe?.();
      listeners.clear();
      const registry = state.__piSessions;
      if (registry?.get(sessionId) === wrapper) registry.delete(sessionId);
      notifyPiWebRunningChange();
    },
  };

  unsubscribe = run.session.subscribe((event: AgentSessionEvent) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Preserve pi-web behavior: client listener failures are isolated.
      }
    }
    notifyPiWebRunningChange();
  });

  if (!state.__piSessions) state.__piSessions = new Map();
  const existing = state.__piSessions.get(sessionId);
  if (existing && existing !== wrapper && typeof existing.isAlive === "function" && existing.isAlive()) {
    console.warn(`[sub-agent] pi-web live-session adapter skipped: session ${sessionId} is already registered`);
    unsubscribe?.();
    return undefined;
  }

  state.__piSessions.set(sessionId, wrapper);
  notifyPiWebRunningChange();
  return registration;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function sanitizeNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function sanitizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const AGENT_RESULT_STATUSES = new Set<AgentResultStatus>(["running", "completed", "error", "not_found", "stopped"]);

function sanitizeStatus(value: unknown): AgentResultStatus {
  return AGENT_RESULT_STATUSES.has(value as AgentResultStatus) ? (value as AgentResultStatus) : "error";
}

function sanitizeDurationMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function sanitizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function getDefaultSessionDirForCwd(cwd: string, agentDir = getAgentDir()) {
  const resolvedCwd = resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[\\/]/, "").replace(/[\\/:]/g, "-")}--`;
  return join(resolve(agentDir), "sessions", safePath);
}

function parseSessionFileTimestampMs(fileName: string): number | null {
  const match = fileName.match(SESSION_FILE_TIMESTAMP_PATTERN);
  if (!match) return null;

  const [, date, hour, minute, second, millisecond] = match;
  const iso = `${date}T${hour}:${minute}:${second}.${millisecond}Z`;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : null;
}

function shortSessionIdFromFileName(fileName: string): string | null {
  const timestampMs = parseSessionFileTimestampMs(fileName);
  const hashMatch = fileName.match(SESSION_FILE_HASH_PATTERN);
  if (timestampMs === null || !hashMatch) return null;

  const sinceEpoch = timestampMs - SUB_AGENT_ID_EPOCH_MS;
  if (!Number.isSafeInteger(sinceEpoch) || sinceEpoch < 0) return null;

  return `${sinceEpoch.toString(36)}_${hashMatch[1]!.toLowerCase()}`;
}

function shortSessionIdFromSessionFile(sessionFile: string | undefined): string | null {
  if (!sessionFile) return null;
  return shortSessionIdFromFileName(basename(sessionFile));
}

async function walkSessionFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkSessionFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(path);
    }
  }
  return files;
}

function isShortSessionId(value: unknown): value is string {
  return typeof value === "string" && SHORT_SESSION_ID_PATTERN.test(value);
}

function makeLegacyRunID() {
  return `sub_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

function extractHelpfulErrorMessage(error: unknown): string {
  const anyErr = error as any;
  const candidates = [
    anyErr?.data?.message,
    anyErr?.data?.error?.message,
    anyErr?.error?.data?.message,
    anyErr?.error?.message,
    anyErr?.message,
  ].filter(Boolean);

  if (candidates.length > 0) return String(candidates[0]);
  return error instanceof Error ? error.message : String(error);
}

function extractTextContent(content: unknown): string | null {
  if (typeof content === "string") return content || null;
  if (!Array.isArray(content)) return null;

  const text = content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");

  return text || null;
}

function extractLastAssistantText(session: AgentSession): string | null {
  const assistantMessages = [...session.messages]
    .filter((message: any) => message?.role === "assistant")
    .reverse();

  for (const message of assistantMessages as any[]) {
    const text = extractTextContent(message.content);
    if (text) return text;
  }

  return null;
}

function makeSubAgentStartedPayload(run: SubAgentRun): SubAgentStartedPayload {
  return {
    session_id: sanitizeString(run.id),
    session_file: sanitizeNullableString(run.session.sessionManager.getSessionFile()),
  };
}

function makeSubAgentCompletedPayload(run: SubAgentRun): SubAgentCompletedPayload {
  return {
    session_id: sanitizeString(run.id),
    response: sanitizeString(run.content ?? run.partial_content, "No text response received"),
  };
}

function makeCreateRunFailurePayload(result: CreateRunFailure): SubAgentCreateFailurePayload {
  const payload: SubAgentCreateFailurePayload = {
    error: sanitizeString(result.error, "Failed to create sub-agent session"),
  };

  const sessionID = sanitizeOptionalString(result.session_id);
  if (sessionID) payload.session_id = sessionID;

  return payload;
}

function buildResultPayload(run: SubAgentRun): AgentResultPayload {
  const status = sanitizeStatus(run.status);
  const endTime = typeof run.completedAt === "number" && Number.isFinite(run.completedAt) ? run.completedAt : Date.now();
  const createdAt = typeof run.createdAt === "number" && Number.isFinite(run.createdAt) ? run.createdAt : endTime;

  return {
    session_id: sanitizeString(run.id),
    session_file: sanitizeNullableString(run.session.sessionManager.getSessionFile()),
    status,
    content: status === "completed" ? sanitizeNullableString(run.content) : null,
    partial_content: sanitizeNullableString(run.partial_content),
    error: sanitizeNullableString(run.error),
    duration_ms: sanitizeDurationMs(endTime - createdAt),
  };
}

function makeNotFoundResultPayload(sessionID: unknown): AgentResultPayload {
  return {
    session_id: sanitizeString(sessionID),
    session_file: null,
    status: "not_found",
    content: null,
    partial_content: null,
    error: "Sub-agent session not found in this in-memory extension runtime",
    duration_ms: 0,
  };
}

function makeUnknownErrorPayload(input: {
  run?: SubAgentRun;
  error: unknown;
  availableAgents: string[];
}): SubAgentUnknownErrorPayload {
  const payload: SubAgentUnknownErrorPayload = {
    error: "Unknown error while creating sub-agent session or sending prompt",
    message: sanitizeString(extractHelpfulErrorMessage(input.error), "Unknown error"),
    possible_causes: [
      "Invalid tool arguments (e.g., agent name not recognized)",
      "Invalid session identifier (existing_session_id must refer to a live in-memory sub-agent session)",
      "Backend failed to process the request (transient internal error)",
    ],
    available_agents: sanitizeStringArray(input.availableAgents),
  };

  const sessionID = sanitizeOptionalString(input.run?.id);
  if (sessionID) payload.session_id = sessionID;

  return payload;
}

function makeStopPayload(input: {
  session_id: unknown;
  status: "stopped" | "not_found" | "error";
  error: unknown;
}): SubAgentStopPayload {
  return {
    session_id: sanitizeString(input.session_id),
    status: input.status,
    error: sanitizeNullableString(input.error),
  };
}

/**
 * SECURITY / CONTEXT-SAFETY BOUNDARY:
 *
 * Tool responses are injected into the parent LLM context. Never stringify
 * internal runtime objects such as SubAgentRun, AgentSession, ctx, raw errors,
 * catalogs, tools, model registries, or sessions.
 *
 * Every outbound payload must be constructed by an explicit make*Payload()
 * function and must be listed in SubAgentToolPayload.
 */
function toolText(payload: SubAgentToolPayload) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

function runUpdatePayload(run: SubAgentRun) {
  const details = buildResultPayload(run);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
  };
}

function emitRunUpdate(run: SubAgentRun) {
  run.updateCallback?.(runUpdatePayload(run));
}

async function materializeNewSessionFile(sessionManager: SessionManager) {
  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile || existsSync(sessionFile)) return sessionManager;

  const header = typeof (sessionManager as any).getHeader === "function"
    ? (sessionManager as any).getHeader()
    : null;
  const entries = typeof (sessionManager as any).getEntries === "function"
    ? (sessionManager as any).getEntries()
    : [];

  if (!header || !Array.isArray(entries)) return sessionManager;

  await mkdir(dirname(sessionFile), { recursive: true });
  await writeFile(sessionFile, [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx" });
  return SessionManager.open(sessionFile, sessionManager.getSessionDir(), sessionManager.getCwd());
}

function shouldReturnResults(results: AgentResultPayload[], waitMode: WaitMode) {
  if (waitMode === "none") return true;

  const terminalStatuses: AgentResultStatus[] = ["completed", "error", "not_found", "stopped"];
  const hasAnyTerminal = results.some((result) => terminalStatuses.includes(result.status));
  const allTerminal = results.every((result) => terminalStatuses.includes(result.status));

  return waitMode === "any" ? hasAnyTerminal : allTerminal;
}

function formatAvailableAgentsForDescription(catalog: AgentCatalog | undefined) {
  if (!catalog) {
    return "Resolved from the current session cwd at session start, and from project_path/current cwd again at execution time.";
  }
  const names = [...catalog.agents.keys()].sort();
  if (names.length === 0) return "(none found)";
  return names.map((name) => {
    const agent = catalog.agents.get(name)!;
    return `- ${name}: ${agent.description}`;
  }).join("\n");
}

function formatAgentDiagnostics(catalog: AgentCatalog | undefined) {
  if (!catalog) return "";
  if (catalog.diagnostics.length === 0) return "";
  return `\n\nAgent catalog diagnostics:\n${catalog.diagnostics.map((d) => `- ${d}`).join("\n")}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveConfigPath(value: string, baseDir: string) {
  return isAbsolute(value) ? value : resolve(baseDir, value);
}

function normalizePathForComparison(value: string) {
  return value.replace(/\\/g, "/");
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

function isAgentRuntimeExtension(extension: unknown) {
  if (!isPlainObject(extension)) return false;
  const candidates = [extension.resolvedPath, extension.path].filter((value): value is string => typeof value === "string");
  return candidates.some((value) => normalizePathForComparison(value).endsWith(AGENT_RUNTIME_EXTENSION_SUFFIX));
}

function filterAgentRuntimeExtension<T extends { extensions: unknown[] }>(base: T): T {
  return {
    ...base,
    extensions: base.extensions.filter((extension) => !isAgentRuntimeExtension(extension)),
  };
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

  if (mainAgent) {
    agents.delete(mainAgent);
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


const FORK_SNAPSHOT_PRUNE_ERROR = "fork snapshot pruning failed because parent branch did not end with the current sub_agent fork tool call";

function pruneCurrentForkToolCall(branchEntries: any[], forkPrompt: string) {
  const lastEntry = branchEntries[branchEntries.length - 1];
  const content = lastEntry?.message?.content;

  if (lastEntry?.type !== "message" || lastEntry.message?.role !== "assistant" || !Array.isArray(content) || content.length === 0) {
    throw new Error(FORK_SNAPSHOT_PRUNE_ERROR);
  }

  const lastBlock = content[content.length - 1];
  const toolArguments = lastBlock?.arguments;
  if (
    lastBlock?.type !== "toolCall" ||
    lastBlock.name !== "sub_agent" ||
    !toolArguments ||
    typeof toolArguments !== "object" ||
    Array.isArray(toolArguments) ||
    toolArguments.agent !== "fork" ||
    toolArguments.prompt !== forkPrompt
  ) {
    throw new Error(FORK_SNAPSHOT_PRUNE_ERROR);
  }

  const prunedContent = content.slice(0, -1);
  if (prunedContent.length === 0) {
    return branchEntries.slice(0, -1);
  }

  return [
    ...branchEntries.slice(0, -1),
    {
      ...lastEntry,
      message: {
        ...lastEntry.message,
        content: prunedContent,
      },
    },
  ];
}

async function createForkBranchSessionFile(input: {
  sessionManager: any;
  parentSession: string;
  parentCwd: string;
  forkPrompt: string;
}) {
  const leafId = typeof input.sessionManager?.getLeafId === "function" ? input.sessionManager.getLeafId() : undefined;
  const branchEntries = leafId && typeof input.sessionManager?.getBranch === "function"
    ? input.sessionManager.getBranch(leafId)
    : undefined;
  const sessionDir = typeof input.sessionManager?.getSessionDir === "function" ? input.sessionManager.getSessionDir() : undefined;

  if (!leafId || !Array.isArray(branchEntries) || branchEntries.length === 0 || !sessionDir) {
    return undefined;
  }

  const prunedBranchEntries = pruneCurrentForkToolCall(branchEntries, input.forkPrompt);

  await mkdir(sessionDir, { recursive: true });

  const sessionId = `subfork_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const timestamp = new Date().toISOString();
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const branchFile = join(sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp,
    cwd: resolve(input.parentCwd),
    parentSession: input.parentSession,
  };

  const lines = [header, ...prunedBranchEntries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(branchFile, lines, { flag: "wx" });
  return branchFile;
}

async function readReferenceDocs(projectPath: string, referenceDocs: string[] | undefined) {
  if (!referenceDocs || referenceDocs.length === 0) return { ok: true as const, block: "" };

  const blocks: string[] = [];
  for (const docPath of referenceDocs) {
    const absolutePath = isAbsolute(docPath) ? docPath : resolve(projectPath, docPath);

    if (!existsSync(absolutePath)) {
      return {
        ok: false as const,
        error: `Reference document not found: ${docPath}`,
      };
    }

    try {
      const content = await readFile(absolutePath, "utf8");
      blocks.push(`<reference_document path="${absolutePath}">\n${content}\n</reference_document>`);
    } catch (error) {
      return {
        ok: false as const,
        error: `Could not read reference document ${docPath}: ${extractHelpfulErrorMessage(error)}`,
      };
    }
  }

  return {
    ok: true as const,
    block: `<reference_documents>\n${blocks.join("\n\n")}\n</reference_documents>`,
  };
}

function buildSubAgentSystemPrompt(input: {
  agent?: AgentDefinition;
  depth: number;
  systemPrompt?: string | null;
}) {
  const name = input.agent?.name ?? "sub-agent";
  const runtimeBlock = `<sub_agent_runtime>
You are running as delegated recursive sub-agent "${name}".
Recursion depth: ${input.depth}/${MAX_DEPTH}.
Complete only the delegated task. Return a concise, useful result to the parent agent.
You may create further sub-agents with sub_agent when the task can be cleanly split, but never exceed the recursion depth limit.
</sub_agent_runtime>`;

  if (!input.agent || input.systemPrompt === null) return runtimeBlock;

  return `${runtimeBlock}

<sub_agent_instructions agent="${input.agent.name}" source="${input.agent.configPath}">
${input.systemPrompt ?? ""}
</sub_agent_instructions>`;
}

export default async function subAgentExtension(pi: ExtensionAPI) {
  // SDK-created nested sessions can execute tool/rendering code paths that expect
  // the shared theme singleton to exist, even outside the interactive TUI.
  // Initializing it here is idempotent enough for our use and avoids
  // "Theme not initialized. Call initTheme() first." in child sessions.
  initTheme(undefined, false);

  const currentDepth = depthContext.getStore() ?? 0;
  let activeCatalog: AgentCatalog | undefined;
  const runs = new Map<string, SubAgentRun>();
  const shortSessionIndex = new Map<string, string>();
  const scannedSessionDirs = new Set<string>();
  let scannedAllSessions = false;

  async function indexSessionDir(dir: string) {
    const resolvedDir = resolve(dir);
    if (scannedSessionDirs.has(resolvedDir)) return;
    scannedSessionDirs.add(resolvedDir);

    for (const file of await walkSessionFiles(resolvedDir)) {
      const id = shortSessionIdFromSessionFile(file);
      if (id && !shortSessionIndex.has(id)) shortSessionIndex.set(id, file);
    }
  }

  async function resolveShortSessionFile(sessionID: string, preferredProjectPath: string) {
    const cached = shortSessionIndex.get(sessionID);
    if (cached) return cached;

    const preferredDir = getDefaultSessionDirForCwd(preferredProjectPath);
    await indexSessionDir(preferredDir);
    const preferred = shortSessionIndex.get(sessionID);
    if (preferred) return preferred;

    if (!scannedAllSessions) {
      scannedAllSessions = true;
      await indexSessionDir(join(getAgentDir(), "sessions"));
    }
    return shortSessionIndex.get(sessionID);
  }

  pi.on("session_shutdown", async () => {
    for (const run of runs.values()) {
      run.unsubscribe?.();
      run.piWebLive?.unregister();
      if (run.status === "running") {
        run.status = "stopped";
        run.completedAt = Date.now();
        run.error = "Parent pi session shut down";
        await run.session.abort().catch(() => undefined);
      }
      run.session.dispose();
    }
    runs.clear();
  });

  function subscribeToPartial(run: SubAgentRun) {
    run.unsubscribe = run.session.subscribe((event: AgentSessionEvent) => {
      const anyEvent = event as any;

      if (anyEvent.type === "message_update") {
        const messageText = extractTextContent(anyEvent.message?.content);
        if (messageText) {
          run.partial_content = messageText;
          emitRunUpdate(run);
          return;
        }

        if (anyEvent.assistantMessageEvent?.type === "text_delta") {
          run.partial_content = `${run.partial_content ?? ""}${anyEvent.assistantMessageEvent.delta ?? ""}`;
          emitRunUpdate(run);
        }
      }

      if (anyEvent.type === "message_end" && anyEvent.message?.role === "assistant") {
        const text = extractTextContent(anyEvent.message.content);
        if (text) {
          run.partial_content = text;
          emitRunUpdate(run);
        }
      }

      if (anyEvent.type === "agent_end") {
        const text = extractLastAssistantText(run.session);
        if (text) {
          run.partial_content = text;
          emitRunUpdate(run);
        }
      }
    });
  }

  async function reopenRun(sessionID: string, sessionFile: string, projectPath: string, ctx: any): Promise<SubAgentRun> {
    const childSessionManager = SessionManager.open(sessionFile);
    const sessionProjectPath = typeof (childSessionManager as any).getCwd === "function"
      ? (childSessionManager as any).getCwd()
      : projectPath;
    const nextDepth = currentDepth + 1;
    const agentDir = getAgentDir();
    const loader = new DefaultResourceLoader({
      cwd: sessionProjectPath,
      agentDir,
      appendSystemPromptOverride: (base: string[]) => [
        ...base,
        buildSubAgentSystemPrompt({ depth: nextDepth, systemPrompt: null }),
      ],
    });

    await depthContext.run(nextDepth, async () => {
      await loader.reload();
    });

    const { session } = await depthContext.run(nextDepth, async () =>
      createAgentSession({
        cwd: sessionProjectPath,
        agentDir,
        model: ctx.model ?? undefined,
        modelRegistry: ctx.modelRegistry,
        thinkingLevel: pi.getThinkingLevel(),
        resourceLoader: loader,
        sessionManager: childSessionManager,
      }),
    );
    if (typeof (session as any).bindExtensions === "function") {
      await (session as any).bindExtensions({});
    }

    const text = extractLastAssistantText(session);
    const run: SubAgentRun = {
      id: sessionID,
      agentName: "sub-agent",
      projectPath: sessionProjectPath,
      prompt: "",
      depth: nextDepth,
      createdAt: Date.now(),
      status: "completed",
      content: text,
      partial_content: text,
      error: null,
      session,
      mode: "isolated",
    };
    subscribeToPartial(run);
    runs.set(sessionID, run);
    shortSessionIndex.set(sessionID, sessionFile);
    return run;
  }

  async function createRun(args: any, ctx: any, projectPath: string, existingRun?: SubAgentRun): Promise<CreateRunResult> {
    const requestedAgent = sanitizeOptionalString(args.agent);
    const forkMode = requestedAgent === "fork";
    const genericMode = requestedAgent === "generic";
    const effectiveRequestedAgent = forkMode || genericMode ? undefined : requestedAgent;
    const runtimeCatalog = await loadAgentCatalog(projectPath);
    const agent = effectiveRequestedAgent ? runtimeCatalog.agents.get(effectiveRequestedAgent) : undefined;
    if (effectiveRequestedAgent && !agent) {
      return {
        ok: false,
        error: `Unknown sub-agent: ${effectiveRequestedAgent}. Available agents: ${[...runtimeCatalog.agents.keys()].sort().join(", ") || "(none)"}`,
      };
    }

    const nextDepth = existingRun ? existingRun.depth : currentDepth + 1;
    if (nextDepth > MAX_DEPTH) {
      const failure: CreateRunFailure = {
        ok: false,
        error: `sub_agent recursion depth limit exceeded (${nextDepth}/${MAX_DEPTH})`,
      };
      if (existingRun?.id) failure.session_id = existingRun.id;
      return failure;
    }

    if (existingRun) {
      existingRun.prompt = args.prompt;
      return { ok: true, run: existingRun };
    }

    const sessionProjectPath = agent?.workspace ? resolveConfigPath(agent.workspace, agent.baseDir) : projectPath;
    const agentDir = getAgentDir();
    const systemPrompt = agent ? await resolveAgentSystemPrompt(agent) : undefined;
    const agentBlock = buildSubAgentSystemPrompt({ agent, depth: nextDepth, systemPrompt });
    const shouldInheritParentSystemPrompt = !genericMode && !effectiveRequestedAgent;
    const parentSystemPrompt = shouldInheritParentSystemPrompt && typeof ctx.getSystemPrompt === "function"
      ? ctx.getSystemPrompt()
      : undefined;
    const loader = new DefaultResourceLoader({
      cwd: sessionProjectPath,
      agentDir,
      extensionsOverride: filterAgentRuntimeExtension,
      ...(parentSystemPrompt ? { systemPromptOverride: () => parentSystemPrompt } : {}),
      appendSystemPromptOverride: (base: string[]) => [...base, agentBlock],
    });

    await depthContext.run(nextDepth, async () => {
      await loader.reload();
    });

    const parentSession = typeof ctx.sessionManager?.getSessionFile === "function" ? ctx.sessionManager.getSessionFile() : undefined;
    let childSessionManager: SessionManager;

    if (forkMode) {
      const branchFile = parentSession
        ? await createForkBranchSessionFile({ sessionManager: ctx.sessionManager, parentSession, parentCwd: ctx.cwd, forkPrompt: args.prompt })
        : undefined;

      if (!branchFile) {
        return {
          ok: false,
          error: "fork mode requires a persisted parent session with a current leaf",
        };
      }

      childSessionManager = resolve(sessionProjectPath) === resolve(ctx.cwd)
        ? SessionManager.open(branchFile, undefined, projectPath)
        : SessionManager.forkFrom(branchFile, sessionProjectPath);
    } else {
      childSessionManager = SessionManager.create(sessionProjectPath, undefined, { parentSession });
    }

    const subAgentLabel = forkMode ? "sub-agent:fork" : effectiveRequestedAgent ? `sub-agent:${effectiveRequestedAgent}` : "sub-agent";
    childSessionManager.appendSessionInfo(`${subAgentLabel} ${new Date().toISOString()}`);
    childSessionManager.appendCustomEntry("sub-agent-metadata", {
      agent: effectiveRequestedAgent ?? null,
      mode: forkMode ? "fork" : "isolated",
      parentTask: args.prompt,
      parentSession,
      projectPath: sessionProjectPath,
      requestedProjectPath: projectPath,
      depth: nextDepth,
      createdAt: new Date().toISOString(),
    });
    if (effectiveRequestedAgent && agent && !agent.workspace) {
      childSessionManager.appendCustomEntry(ACTIVE_AGENT_ENTRY_TYPE, { name: effectiveRequestedAgent });
    }
    childSessionManager = await materializeNewSessionFile(childSessionManager);

    const sessionOptions: any = {
      cwd: sessionProjectPath,
      agentDir,
      model: ctx.model ?? undefined,
      modelRegistry: ctx.modelRegistry,
      thinkingLevel: pi.getThinkingLevel(),
      resourceLoader: loader,
      sessionManager: childSessionManager,
    };

    const { session } = await depthContext.run(nextDepth, async () =>
      createAgentSession(sessionOptions),
    );
    if (typeof (session as any).bindExtensions === "function") {
      await (session as any).bindExtensions({});
    }

    const id = shortSessionIdFromSessionFile(session.sessionManager.getSessionFile()) ?? makeLegacyRunID();
    const run: SubAgentRun = {
      id,
      agentName: forkMode ? "fork" : effectiveRequestedAgent ?? "sub-agent",
      projectPath: sessionProjectPath,
      prompt: args.prompt,
      depth: nextDepth,
      createdAt: Date.now(),
      status: "running",
      content: null,
      partial_content: null,
      error: null,
      session,
      mode: forkMode ? "fork" : "isolated",
      forkContextSent: false,
    };
    subscribeToPartial(run);
    runs.set(id, run);
    const sessionFile = session.sessionManager.getSessionFile();
    if (sessionFile) shortSessionIndex.set(id, sessionFile);
    return { ok: true, run };
  }

  function modelsAreEqual(a: any, b: any) {
    return !!a && !!b && a.provider === b.provider && a.id === b.id;
  }

  async function syncRunRuntimeWithParent(run: SubAgentRun, ctx: any) {
    const parentModel = ctx.model;
    if (parentModel && !modelsAreEqual(run.session.model, parentModel)) {
      await run.session.setModel(parentModel);
    }

    const parentThinkingLevel = pi.getThinkingLevel();
    if (typeof parentThinkingLevel === "string" && run.session.thinkingLevel !== parentThinkingLevel) {
      run.session.setThinkingLevel(parentThinkingLevel);
    }
  }

  function buildPromptForRun(run: SubAgentRun, prompt: string, referenceBlock: string | undefined) {
    const includeForkContext = run.mode === "fork" && !run.forkContextSent;
    if (includeForkContext) run.forkContextSent = true;

    if (referenceBlock) {
      const delegatedPrompt = includeForkContext
        ? `${FORKED_SUBAGENT_CONTEXT}\n\n<delegated_task>\n${prompt}\n</delegated_task>`
        : `<delegated_task>\n${prompt}\n</delegated_task>`;
      return `${referenceBlock}\n\n${delegatedPrompt}`;
    }

    return includeForkContext ? `${FORKED_SUBAGENT_CONTEXT}\n\n${prompt}` : prompt;
  }

  async function runPrompt(run: SubAgentRun, prompt: string, referenceBlock: string | undefined) {
    run.status = "running";
    run.error = null;
    run.completedAt = undefined;
    run.piWebLive ??= registerPiWebLiveSession(run);
    run.piWebLive?.setPromptRunning(true);

    const fullPrompt = buildPromptForRun(run, prompt, referenceBlock);

    try {
      await depthContext.run(run.depth, async () => {
        await run.session.prompt(fullPrompt, { source: "extension" });
      });
      const text = extractLastAssistantText(run.session) ?? run.partial_content ?? "No text response received";
      run.content = text;
      run.partial_content = text;
      run.status = "completed";
      run.completedAt = Date.now();
    } catch (error) {
      const status = run.status as AgentResultStatus;
      if (status !== "stopped") {
        run.status = "error";
        run.error = extractHelpfulErrorMessage(error);
        run.completedAt = Date.now();
      }
    } finally {
      run.piWebLive?.setPromptRunning(false);
      run.piWebLive?.unregister();
      run.piWebLive = undefined;
    }
  }

  function registerSubAgentTool(catalog?: AgentCatalog) {
    activeCatalog = catalog;
    const availableAgents = formatAvailableAgentsForDescription(catalog);
    const diagnostics = formatAgentDiagnostics(catalog);

    pi.registerTool({
    name: "sub_agent",
    label: "Sub Agent",
    description: `Prefer delegation when a task is independently executable and a child session can reduce parent context load, isolate work, provide independent review, use specialized agent behavior, run in parallel, filter noisy or large tool output into a compact result, or amortize repeated context transfer.

Delegate independent tasks in parallel when this reduces elapsed time or parent-session complexity: separate research questions, isolated file changes, separate code-review areas, independent investigations, alternative implementations, or extracting a small answer from a large/noisy source. Keep dependent work sequential.

Keep work in the parent only when delegation would clearly add coordination cost without benefit, when the task requires continuous parent-level judgment, or when the next step is simply to wait for an already-running sub-agent result.

Agents this tool can start or continue as child sessions:
${availableAgents}

Agent selection:
- Omit "agent" for ordinary isolated delegation. This is the default for most delegated work.
- Use a named agent when its description clearly matches the delegated task.
- Use agent="generic" only when no named agent fits, or when a neutral general-purpose helper is explicitly needed.
- Use agent="fork" when inherited conversation context is materially needed for an independent task. Fork is a context-inheritance mode, not a specialized worker; if the needed context is short, put it in prompt instead.

Prompt and context transfer:
- For inherited isolated sub-agents (agent omitted) and fork, give only the delegated task when the parent prompt already supplies the needed operating context.
- For generic or named isolated sub-agents, make the prompt self-contained enough to execute: state the task, key constraints, and expected result.
- Use reference_docs when passing document paths is much shorter, faster, or less error-prone than writing the same context into the prompt. Each referenced document should materially reduce prompt length, improve accuracy, or provide exact context the child needs.
- If substantial background will likely be reused across multiple sub-agent calls, consider writing it once to a temporary/reference document and passing that path via reference_docs. This amortizes one documentation cost across repeated delegations.
- reference_docs and fork are independent optimizations: fork transfers conversation history; reference_docs transfers explicit document content. They can be used together when both help.
- Do not attach reference documents by default.

Use existing_session_id only to continue the same child session when its accumulated private context matters: continuing its investigation, asking it to refine its own prior result, following up, or correcting work it already performed.

When existing_session_id is provided, the tool continues that child session with its original project context when possible. Do not provide project_path or agent with existing_session_id; those options are only for creating a new sub-agent session. If you need a different project, agent, or mode, create a new sub-agent instead of continuing an existing one.

When continuing an existing session, relative reference_docs paths resolve against that existing session's project path.${diagnostics}`,
    promptSnippet: "Create or continue a recursive delegated sub-agent session for independent work",
    promptGuidelines: [
      "Prefer sub_agent for independently executable work with clear payoff: parallelism, isolation, specialized behavior, independent review, context preservation, or filtering noisy output.",
      "Prefer ordinary isolated delegation by omitting agent; use named agents when descriptions match; use generic as a neutral fallback; use fork only when inherited context is materially needed.",
      "Use reference_docs to reduce repeated or verbose context transfer when path-based context is cheaper or more accurate than prompt text.",
      "Use sub_agent_result to check background delegated work instead of re-running the same task.",
      "Use sub_agent_stop to halt delegated work that should no longer continue.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Task for the child session. For isolated sessions, include enough context to execute; for fork or existing_session_id, provide the incremental follow-up task." }),
      agent: Type.Optional(Type.String({ description: `Role or context mode for a new sub-agent session. Omit for ordinary isolated delegation. Use a named agent when its description clearly matches the task. Use "generic" for a neutral helper when no named agent fits. Use "fork" when inherited conversation context is materially needed. Do not provide with existing_session_id. Available named agents: ${catalog ? ([...catalog.agents.keys()].sort().join(", ") || "(none found in this session cwd)") : "resolved from current session cwd at session start, and from project_path/current cwd again at execution time"}` })),
      run_in_background: Type.Optional(Type.Boolean({ description: "Whether to run the sub-agent asynchronously in the background. Default to false: if the parent agent needs this sub-agent's result before continuing, or has no other independent work to do in parallel, run synchronously and wait for completion. This avoids an immediate return followed by an unnecessary sub_agent_result wait call. Set true only when the parent agent will do other independent work while the sub-agent runs, or when launching multiple independent sub-agents in parallel. If the next step is simply to wait for this result, use false." })),
      existing_session_id: Type.Optional(Type.String({ description: "Existing delegated sub-agent session ID to continue. Use only to continue, refine, follow up, or correct work in that same child session. Mutually exclusive with project_path and agent: to use a different project, agent, or mode, create a new sub-agent instead." })),
      project_path: Type.Optional(Type.String({ description: "Project path for creating a new sub-agent session. Defaults to the caller's project path. Do not provide project_path with existing_session_id; an existing session keeps its original project context. When continuing an existing session, relative reference_docs paths resolve against that existing session's project path." })),
      reference_docs: Type.Optional(Type.Array(Type.String(), { description: "File paths to inline as context when paths are much shorter, faster, or more accurate than writing the same context in the prompt. Relative paths resolve against the new session's project_path, or against the existing session's original project path when existing_session_id is used. Useful for exact file snapshots, large specs/logs, or reusable background notes. Do not attach by default." })),
    }),
    async execute(_toolCallId, args, signal, onUpdate, ctx) {
      let run: SubAgentRun | undefined;
      let referenceBlock = "";

      try {
        if (signal?.aborted) {
          return toolText(makeCreateRunFailurePayload({ ok: false, error: "Cancelled" }));
        }

        if (args.existing_session_id) {
          run = runs.get(args.existing_session_id);
          if (!run && isShortSessionId(args.existing_session_id)) {
            const sessionFile = await resolveShortSessionFile(args.existing_session_id, ctx.cwd);
            if (sessionFile) {
              run = await reopenRun(args.existing_session_id, sessionFile, ctx.cwd, ctx);
            }
          }
          if (!run) {
            return toolText(makeCreateRunFailurePayload({
              ok: false,
              session_id: sanitizeString(args.existing_session_id),
              error: "existing_session_id must be an existing sub-agent session ID returned by a previous sub_agent call",
            }));
          }

          if (args.project_path) {
            return toolText(makeCreateRunFailurePayload({
              ok: false,
              session_id: sanitizeString(args.existing_session_id),
              error: "project_path cannot be used with existing_session_id; continuing an existing sub-agent keeps its original project context. To use a different project, omit existing_session_id and create a new sub-agent session.",
            }));
          }

          if (args.agent) {
            return toolText(makeCreateRunFailurePayload({
              ok: false,
              session_id: sanitizeString(args.existing_session_id),
              error: "agent cannot be used with existing_session_id; continuing an existing sub-agent keeps its original agent identity and fork/isolated mode. To use a different agent or mode, omit existing_session_id and create a new sub-agent session.",
            }));
          }
        }

        const projectPath = run?.projectPath || args.project_path || ctx.cwd;
        const referenceDocs = await readReferenceDocs(projectPath, args.reference_docs);
        if (!referenceDocs.ok) {
          const failure: CreateRunFailure = {
            ok: false,
            error: sanitizeString(referenceDocs.error, "Failed to read reference documents"),
          };
          const sessionID = sanitizeOptionalString(run?.id);
          if (sessionID) failure.session_id = sessionID;
          return toolText(makeCreateRunFailurePayload(failure));
        }
        referenceBlock = referenceDocs.block;

        const created = await createRun(args, ctx, projectPath, run);

        if (!created.ok) {
          return toolText(makeCreateRunFailurePayload(created));
        }
        const activeRun = created.run;
        await syncRunRuntimeWithParent(activeRun, ctx);
        run = activeRun;
        activeRun.updateCallback = onUpdate;

        const abort = async () => {
          run = activeRun;
          activeRun.status = "stopped";
          activeRun.error = "Cancelled";
          activeRun.completedAt = Date.now();
          await activeRun.session.abort().catch(() => undefined);
        };
        signal?.addEventListener("abort", abort, { once: true });

        if (args.run_in_background) {
          activeRun.promise = runPrompt(activeRun, args.prompt, referenceBlock).finally(() => {
            activeRun.piWebLive?.unregister();
            activeRun.piWebLive = undefined;
            signal?.removeEventListener("abort", abort);
            if (activeRun.updateCallback === onUpdate) activeRun.updateCallback = undefined;
          });
          return toolText(makeSubAgentStartedPayload(activeRun));
        }

        try {
          await runPrompt(activeRun, args.prompt, referenceBlock);
        } finally {
          activeRun.piWebLive?.unregister();
          activeRun.piWebLive = undefined;
          signal?.removeEventListener("abort", abort);
          if (activeRun.updateCallback === onUpdate) activeRun.updateCallback = undefined;
        }

        return {
          ...toolText(makeSubAgentCompletedPayload(activeRun)),
          details: buildResultPayload(activeRun),
        };
      } catch (error) {
        return toolText(makeUnknownErrorPayload({
          run,
          error,
          availableAgents: [...(activeCatalog?.agents.keys() ?? [])].sort(),
        }));
      }
    },
  });
  }

  registerSubAgentTool();

  pi.on("session_start", async (_event, ctx) => {
    registerSubAgentTool(await loadAgentCatalog(ctx.cwd));
  });

  pi.registerTool({
    name: "sub_agent_result",
    label: "Sub Agent Result",
    description: "Use after handing work off to one or more sub-agents when you want to check progress, inspect the latest visible result, or wait for either the first finished answer or all finished answers, instead of re-running the same tasks.",
    parameters: Type.Object({
      session_ids: Type.Array(Type.String(), { description: "Delegated sub-agent session IDs" }),
      wait: StringEnum(["none", "any", "all"] as const, { description: "Return immediately, wait until any session finishes, or wait until all sessions finish" }),
    }),
    async execute(_toolCallId, args, _signal, onUpdate, ctx) {
      while (true) {
        const results = await Promise.all(args.session_ids.map(async (sessionID: string) => {
          let run = runs.get(sessionID);
          if (!run && isShortSessionId(sessionID)) {
            const sessionFile = await resolveShortSessionFile(sessionID, ctx.cwd);
            if (sessionFile) {
              run = await reopenRun(sessionID, sessionFile, ctx.cwd, ctx);
            }
          }
          if (!run) {
            return makeNotFoundResultPayload(sessionID);
          }
          return buildResultPayload(run);
        }));

        onUpdate?.({
          content: [{ type: "text" as const, text: JSON.stringify(results) }],
          details: { results },
        });

        if (shouldReturnResults(results, args.wait as WaitMode)) {
          return { ...toolText(results), details: { results } };
        }

        await sleep(POLL_INTERVAL_MS);
      }
    },
  });

  pi.registerTool({
    name: "sub_agent_stop",
    label: "Sub Agent Stop",
    description: "Use when you need to stop a delegated sub-agent session that is still running or should not continue. This is for halting an existing session, not for checking results.",
    parameters: Type.Object({
      session_id: Type.String({ description: "Delegated sub-agent session ID to stop" }),
    }),
    async execute(_toolCallId, args) {
      const run = runs.get(args.session_id);
      if (!run) {
        return toolText(makeStopPayload({
          session_id: args.session_id,
          status: "not_found",
          error: "Sub-agent session not found in this in-memory extension runtime",
        }));
      }

      try {
        run.status = "stopped";
        run.error = null;
        run.completedAt = Date.now();
        await run.session.abort();
        return {
          ...toolText(makeStopPayload({ session_id: args.session_id, status: "stopped", error: null })),
          details: buildResultPayload(run),
        };
      } catch (error) {
        run.status = "error";
        run.error = extractHelpfulErrorMessage(error);
        run.completedAt = Date.now();
        return {
          ...toolText(makeStopPayload({ session_id: args.session_id, status: "error", error: run.error })),
          details: buildResultPayload(run),
        };
      }
    },
  });
}
