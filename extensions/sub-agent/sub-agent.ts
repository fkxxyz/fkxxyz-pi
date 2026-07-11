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
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const GLOBAL_AGENTS_FILE = join(homedir(), "pi", "agents.ts");
const PROJECT_AGENTS_FILE = join(".pi", "agents.ts");
const SUBAGENT_SKILL_PATHS = [
  "../../skills/subagent-delegation-verification",
  "../../skills/subagent-prompt-simplification",
  "../../skills/superpowers/subagent-driven-development",
].map((path) => fileURLToPath(new URL(path, import.meta.url)));
const POLL_INTERVAL_MS = 1000;
const MAX_DEPTH = 8;

type AgentResultStatus = "running" | "completed" | "error" | "not_found" | "stopped";
type WaitMode = "none" | "any" | "all";

type AgentDefinition = {
  name: string;
  description: string;
  configPath: string;
  baseDir: string;
  systemPrompt?: string;
  systemPromptFile?: string;
  workspace?: string;
};

type AgentCatalog = {
  agents: Map<string, AgentDefinition>;
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
  unsubscribe?: () => void;
  promise?: Promise<void>;
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
const depthContext = new AsyncLocalStorage<number>();

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

function shouldReturnResults(results: AgentResultPayload[], waitMode: WaitMode) {
  if (waitMode === "none") return true;

  const terminalStatuses: AgentResultStatus[] = ["completed", "error", "not_found", "stopped"];
  const hasAnyTerminal = results.some((result) => terminalStatuses.includes(result.status));
  const allTerminal = results.every((result) => terminalStatuses.includes(result.status));

  return waitMode === "any" ? hasAnyTerminal : allTerminal;
}

function formatAvailableAgentsForDescription(catalog: AgentCatalog) {
  const names = [...catalog.agents.keys()].sort();
  if (names.length === 0) return "(none found)";
  return names.map((name) => {
    const agent = catalog.agents.get(name)!;
    return `- ${name}: ${agent.description}`;
  }).join("\n");
}

function formatAgentDiagnostics(catalog: AgentCatalog) {
  if (catalog.diagnostics.length === 0) return "";
  return `\n\nAgent catalog diagnostics:\n${catalog.diagnostics.map((d) => `- ${d}`).join("\n")}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveConfigPath(value: string, baseDir: string) {
  return isAbsolute(value) ? value : resolve(baseDir, value);
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

  const sources = ["systemPrompt", "systemPromptFile", "workspace"].filter((key) => typeof raw[key] === "string" && raw[key]);
  if (sources.length > 1) {
    diagnostics.push(`Agent "${name}" in ${configPath} must define at most one of systemPrompt, systemPromptFile, or workspace`);
    return null;
  }

  return {
    name,
    description,
    configPath,
    baseDir: dirname(configPath),
    systemPrompt: typeof raw.systemPrompt === "string" ? raw.systemPrompt : undefined,
    systemPromptFile: typeof raw.systemPromptFile === "string" ? raw.systemPromptFile : undefined,
    workspace: typeof raw.workspace === "string" ? raw.workspace : undefined,
  };
}

function mergeAgentDefinition(base: AgentDefinition, override: AgentDefinition): AgentDefinition {
  const merged: AgentDefinition = {
    ...base,
    name: override.name,
    description: override.description,
  };
  const overrideSources = [override.systemPrompt, override.systemPromptFile, override.workspace].filter((value) => typeof value === "string" && value).length;
  if (overrideSources > 0) {
    merged.configPath = override.configPath;
    merged.baseDir = override.baseDir;
    merged.systemPrompt = override.systemPrompt;
    merged.systemPromptFile = override.systemPromptFile;
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
    moduleExports = await import(`${pathToFileURL(configPath).href}?mtime=${Date.now()}`);
  } catch (error) {
    diagnostics.push(`Could not import ${configPath}: ${extractHelpfulErrorMessage(error)}`);
    return { agents: new Map(), diagnostics };
  }

  const rawAgents = moduleExports.default ?? moduleExports.agents;
  if (!isPlainObject(rawAgents)) {
    diagnostics.push(`${configPath} must export an agents object as default export or named export "agents"`);
    return { agents: new Map(), diagnostics };
  }

  const agents = new Map<string, AgentDefinition>();
  for (const [name, raw] of Object.entries(rawAgents)) {
    const definition = normalizeAgentDefinition(name, raw, configPath, diagnostics);
    if (definition) agents.set(name, definition);
  }

  return { agents, diagnostics };
}

async function loadAgentCatalog(projectPath: string): Promise<AgentCatalog> {
  const globalCatalog = await loadAgentsFile(GLOBAL_AGENTS_FILE);
  const projectCatalog = await loadAgentsFile(resolve(projectPath, PROJECT_AGENTS_FILE));
  const agents = new Map(globalCatalog.agents);
  const diagnostics = [...globalCatalog.diagnostics, ...projectCatalog.diagnostics];

  for (const [name, definition] of projectCatalog.agents) {
    const existing = agents.get(name);
    agents.set(name, existing ? mergeAgentDefinition(existing, definition) : definition);
  }

  for (const [name, definition] of [...agents]) {
    const sources = [definition.systemPrompt, definition.systemPromptFile, definition.workspace].filter((value) => typeof value === "string" && value).length;
    if (sources !== 1) {
      diagnostics.push(`Agent "${name}" must define exactly one of systemPrompt, systemPromptFile, or workspace after global/project merge`);
      agents.delete(name);
    }
  }

  return { agents, diagnostics };
}

async function resolveAgentSystemPrompt(agent: AgentDefinition): Promise<string | null> {
  if (agent.systemPrompt !== undefined) return agent.systemPrompt;
  if (agent.systemPromptFile !== undefined) {
    return readFile(resolveConfigPath(agent.systemPromptFile, agent.baseDir), "utf8");
  }
  return null;
}


async function createForkBranchSessionFile(input: {
  sessionManager: any;
  parentSession: string;
  parentCwd: string;
}) {
  const leafId = typeof input.sessionManager?.getLeafId === "function" ? input.sessionManager.getLeafId() : undefined;
  const branchEntries = leafId && typeof input.sessionManager?.getBranch === "function"
    ? input.sessionManager.getBranch(leafId)
    : undefined;
  const sessionDir = typeof input.sessionManager?.getSessionDir === "function" ? input.sessionManager.getSessionDir() : undefined;

  if (!leafId || !Array.isArray(branchEntries) || branchEntries.length === 0 || !sessionDir) {
    return undefined;
  }

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

  const lines = [header, ...branchEntries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
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
  const startupCatalog = await loadAgentCatalog(process.cwd());
  const runs = new Map<string, SubAgentRun>();

  pi.on("resources_discover", async () => {
    return {
      skillPaths: SUBAGENT_SKILL_PATHS,
    };
  });

  pi.on("session_shutdown", async () => {
    for (const run of runs.values()) {
      run.unsubscribe?.();
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
          return;
        }

        if (anyEvent.assistantMessageEvent?.type === "text_delta") {
          run.partial_content = `${run.partial_content ?? ""}${anyEvent.assistantMessageEvent.delta ?? ""}`;
        }
      }

      if (anyEvent.type === "message_end" && anyEvent.message?.role === "assistant") {
        const text = extractTextContent(anyEvent.message.content);
        if (text) run.partial_content = text;
      }

      if (anyEvent.type === "agent_end") {
        const text = extractLastAssistantText(run.session);
        if (text) run.partial_content = text;
      }
    });
  }

  async function createRun(args: any, ctx: any, projectPath: string, existingRun?: SubAgentRun): Promise<CreateRunResult> {
    const requestedAgent = sanitizeOptionalString(args.agent);
    const forkMode = requestedAgent === "fork";
    const effectiveRequestedAgent = forkMode ? undefined : requestedAgent;
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
    const loader = new DefaultResourceLoader({
      cwd: sessionProjectPath,
      agentDir,
      appendSystemPromptOverride: (base: string[]) => [...base, agentBlock],
    });

    await depthContext.run(nextDepth, async () => {
      await loader.reload();
    });

    const parentSession = typeof ctx.sessionManager?.getSessionFile === "function" ? ctx.sessionManager.getSessionFile() : undefined;
    let childSessionManager: SessionManager;

    if (forkMode) {
      const branchFile = parentSession
        ? await createForkBranchSessionFile({ sessionManager: ctx.sessionManager, parentSession, parentCwd: ctx.cwd })
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

    const subAgentLabel = forkMode ? "sub-agent:fork" : requestedAgent ? `sub-agent:${requestedAgent}` : "sub-agent";
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

    const sessionOptions: any = {
      cwd: sessionProjectPath,
      agentDir,
      model: ctx.model ?? undefined,
      modelRegistry: ctx.modelRegistry,
      thinkingLevel: pi.getThinkingLevel(),
      resourceLoader: loader,
      sessionManager: childSessionManager,
    };
    if (!agent?.workspace) {
      sessionOptions.tools = pi.getActiveTools();
    }

    const { session } = await depthContext.run(nextDepth, async () =>
      createAgentSession(sessionOptions),
    );

    const id = `sub_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const run: SubAgentRun = {
      id,
      agentName: forkMode ? "fork" : requestedAgent ?? "sub-agent",
      projectPath: sessionProjectPath,
      prompt: args.prompt,
      depth: nextDepth,
      createdAt: Date.now(),
      status: "running",
      content: null,
      partial_content: null,
      error: null,
      session,
    };
    subscribeToPartial(run);
    runs.set(id, run);
    return { ok: true, run };
  }

  async function runPrompt(run: SubAgentRun, prompt: string, referenceBlock: string | undefined) {
    run.status = "running";
    run.error = null;
    run.completedAt = undefined;

    const fullPrompt = referenceBlock
      ? `${referenceBlock}\n\n<delegated_task>\n${prompt}\n</delegated_task>`
      : prompt;

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
    }
  }

  const availableAgents = formatAvailableAgentsForDescription(startupCatalog);
  const diagnostics = formatAgentDiagnostics(startupCatalog);

  pi.registerTool({
    name: "sub_agent",
    label: "Sub Agent",
    description: `Use when a task can be delegated as an independently executable unit and the expected benefit outweighs the cost of creating, coordinating, and integrating a child session. Useful payoffs include parallelism, isolation, specialized agent behavior, independent review, context-window preservation, filtering noisy or large tool output into a compact result, or amortizing repeated context transfer.

Delegate independent tasks in parallel when this reduces elapsed time or parent-session complexity: separate research questions, isolated file changes, separate code-review areas, independent investigations, alternative implementations, or extracting a small answer from a large/noisy source. Keep dependent work sequential.

Do not delegate merely because a task exists. Do not use sub-agents for work the parent can complete directly with comparable or lower total cost, for tasks that require continuous parent judgment, or when the next step is simply to wait for an existing result.

Available agents from ${GLOBAL_AGENTS_FILE} and ${PROJECT_AGENTS_FILE}:
${availableAgents}

Named agents are loaded from global ${GLOBAL_AGENTS_FILE} first, then from the target project's ${PROJECT_AGENTS_FILE}; project entries shallow-merge and override global entries.

Agent selection:
- Omit "agent" for a new isolated generic sub-agent with the same workspace configuration. This is the default for most delegated work.
- Use a named agent only when its description matches the delegation need.
- Use agent="fork" sparingly. Fork is not a specialized worker; it is a context-inheritance mode. Use it only when the task is clearly independent yet accurate execution would otherwise require restating substantial parent-session context, such as prior decisions, failed attempts, nuanced constraints, or accumulated findings. This is uncommon because tasks that need extensive shared context are often not truly independent.
- Do not use fork as a convenience for work the parent can complete directly, or for tasks whose required context is short enough to state in the prompt. Fork creates a child session from the parent's current conversation branch and takes precedence over any agent named "fork".

Prompt and context transfer:
- For isolated sub-agents, make the prompt self-contained enough to execute: state the task, key constraints, and expected result.
- For fork, give only the incremental task; inherited conversation history supplies the shared context.
- Use reference_docs when passing document paths is much shorter, faster, or less error-prone than writing the same context into the prompt. Each referenced document should materially reduce prompt length, improve accuracy, or provide exact context the child needs.
- If substantial background will likely be reused across multiple sub-agent calls, consider writing it once to a temporary/reference document and passing that path via reference_docs. This amortizes one documentation cost across repeated delegations.
- reference_docs and fork are independent optimizations: fork transfers conversation history; reference_docs transfers explicit document content. They can be used together when both help.
- Do not attach reference documents by default.

Use existing_session_id only to continue the same live child session when its accumulated private context matters: continuing its investigation, asking it to refine its own prior result, following up, or correcting work it already performed.

When existing_session_id is provided, the tool continues that session with its original project context, agent identity, fork/isolated mode, tools, settings, and system prompt. Do not provide project_path or agent with existing_session_id; those options are only for creating a new sub-agent session. If you need a different project, agent, or mode, create a new sub-agent instead of continuing an existing one.

When continuing an existing session, relative reference_docs paths resolve against that existing session's project path.${diagnostics}`,
    promptSnippet: "Create or continue a recursive delegated sub-agent session for independent work",
    promptGuidelines: [
      "Use sub_agent only when an independently executable child task has clear payoff: parallelism, isolation, specialized behavior, independent review, context preservation, or filtering noisy output.",
      "Prefer isolated sub-agents by default; use fork sparingly when substantial inherited conversation context is necessary for an otherwise independent task.",
      "Use reference_docs to reduce repeated or verbose context transfer when path-based context is cheaper or more accurate than prompt text.",
      "Use sub_agent_result to check background delegated work instead of re-running the same task.",
      "Use sub_agent_stop to halt delegated work that should no longer continue.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Task for the child session. For isolated sessions, include enough context to execute; for fork or existing_session_id, provide the incremental follow-up task." }),
      agent: Type.Optional(Type.String({ description: `Optional mode/name for creating a new sub-agent session. Omit for a new isolated generic sub-agent. Use a named agent only when its description matches the task. Use "fork" sparingly for an independent task that needs substantial inherited parent-session context; fork takes precedence over any agent named "fork". Do not provide agent with existing_session_id; an existing session keeps its original agent identity and fork/isolated mode. Available agents: ${[...startupCatalog.agents.keys()].sort().join(", ")}` })),
      run_in_background: Type.Optional(Type.Boolean({ description: "Whether to run the sub-agent asynchronously in the background. Default to false: if the parent agent needs this sub-agent's result before continuing, or has no other independent work to do in parallel, run synchronously and wait for completion. This avoids an immediate return followed by an unnecessary sub_agent_result wait call. Set true only when the parent agent will do other independent work while the sub-agent runs, or when launching multiple independent sub-agents in parallel. If the next step is simply to wait for this result, use false." })),
      existing_session_id: Type.Optional(Type.String({ description: "Live sub-agent session ID returned by sub_agent. Use only to continue, refine, follow up, or correct work in that same child session. Mutually exclusive with project_path and agent: continuing a session preserves its original project context, agent identity, fork/isolated mode, tools, settings, and system prompt. To use a different project, agent, or mode, omit existing_session_id and create a new session." })),
      project_path: Type.Optional(Type.String({ description: "Project path for creating a new sub-agent session. Defaults to the caller's project path. Do not provide project_path with existing_session_id; an existing session keeps its original project context. When continuing an existing session, relative reference_docs paths resolve against that existing session's project path." })),
      reference_docs: Type.Optional(Type.Array(Type.String(), { description: "File paths to inline as context when paths are much shorter, faster, or more accurate than writing the same context in the prompt. Relative paths resolve against the new session's project_path, or against the existing session's original project path when existing_session_id is used. Useful for exact file snapshots, large specs/logs, or reusable background notes. Do not attach by default." })),
    }),
    async execute(_toolCallId, args, signal, _onUpdate, ctx) {
      let run: SubAgentRun | undefined;
      let referenceBlock = "";

      try {
        if (signal?.aborted) {
          return toolText(makeCreateRunFailurePayload({ ok: false, error: "Cancelled" }));
        }

        if (args.existing_session_id) {
          run = runs.get(args.existing_session_id);
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
        run = activeRun;

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
            signal?.removeEventListener("abort", abort);
          });
          return toolText(makeSubAgentStartedPayload(activeRun));
        }

        await runPrompt(activeRun, args.prompt, referenceBlock);
        signal?.removeEventListener("abort", abort);

        return {
          ...toolText(makeSubAgentCompletedPayload(activeRun)),
          details: buildResultPayload(activeRun),
        };
      } catch (error) {
        return toolText(makeUnknownErrorPayload({
          run,
          error,
          availableAgents: [...startupCatalog.agents.keys()].sort(),
        }));
      }
    },
  });

  pi.registerTool({
    name: "sub_agent_result",
    label: "Sub Agent Result",
    description: "Use after handing work off to one or more sub-agents when you want to check progress, inspect the latest visible result, or wait for either the first finished answer or all finished answers, instead of re-running the same tasks.",
    parameters: Type.Object({
      session_ids: Type.Array(Type.String(), { description: "Delegated sub-agent session IDs" }),
      wait: StringEnum(["none", "any", "all"] as const, { description: "Return immediately, wait until any session finishes, or wait until all sessions finish" }),
    }),
    async execute(_toolCallId, args) {
      while (true) {
        const results = args.session_ids.map((sessionID: string) => {
          const run = runs.get(sessionID);
          if (!run) {
            return makeNotFoundResultPayload(sessionID);
          }
          return buildResultPayload(run);
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
