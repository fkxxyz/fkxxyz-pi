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
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const AGENTS_DIR = join(homedir(), "pi", "agents");
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
  path: string;
  realPath: string;
  content: string;
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
  return names.map((name) => `- ${name}`).join("\n");
}

function formatAgentDiagnostics(catalog: AgentCatalog) {
  if (catalog.diagnostics.length === 0) return "";
  return `\n\nAgent catalog diagnostics:\n${catalog.diagnostics.map((d) => `- ${d}`).join("\n")}`;
}

async function scanAgentsDirectory(root: string): Promise<AgentCatalog> {
  const found = new Map<string, AgentDefinition[]>();
  const diagnostics: string[] = [];
  const visitedDirs = new Set<string>();
  const visitedFiles = new Set<string>();

  async function addFile(filePath: string) {
    if (extname(filePath).toLowerCase() !== ".md") return;

    let fileRealPath: string;
    try {
      fileRealPath = await realpath(filePath);
    } catch (error) {
      diagnostics.push(`Could not resolve agent file ${filePath}: ${extractHelpfulErrorMessage(error)}`);
      return;
    }

    if (visitedFiles.has(fileRealPath)) return;
    visitedFiles.add(fileRealPath);

    const name = basename(filePath, extname(filePath));
    if (!name) return;

    try {
      const content = await readFile(filePath, "utf8");
      const current = found.get(name) ?? [];
      current.push({ name, path: filePath, realPath: fileRealPath, content });
      found.set(name, current);
    } catch (error) {
      diagnostics.push(`Could not read agent file ${filePath}: ${extractHelpfulErrorMessage(error)}`);
    }
  }

  async function walk(path: string) {
    let lst;
    try {
      lst = await lstat(path);
    } catch (error) {
      diagnostics.push(`Could not access ${path}: ${extractHelpfulErrorMessage(error)}`);
      return;
    }

    let targetStat = lst;
    if (lst.isSymbolicLink()) {
      try {
        targetStat = await stat(path);
      } catch (error) {
        diagnostics.push(`Broken symlink or inaccessible target ${path}: ${extractHelpfulErrorMessage(error)}`);
        return;
      }
    }

    if (targetStat.isDirectory()) {
      let dirRealPath: string;
      try {
        dirRealPath = await realpath(path);
      } catch (error) {
        diagnostics.push(`Could not resolve directory ${path}: ${extractHelpfulErrorMessage(error)}`);
        return;
      }

      if (visitedDirs.has(dirRealPath)) return;
      visitedDirs.add(dirRealPath);

      let entries;
      try {
        entries = await readdir(path, { withFileTypes: true });
      } catch (error) {
        diagnostics.push(`Could not read directory ${path}: ${extractHelpfulErrorMessage(error)}`);
        return;
      }

      for (const entry of entries) {
        await walk(join(path, entry.name));
      }
      return;
    }

    if (targetStat.isFile()) {
      await addFile(path);
    }
  }

  if (!existsSync(root)) {
    diagnostics.push(`Agents directory does not exist: ${root}`);
    return { agents: new Map(), diagnostics };
  }

  await walk(root);

  const agents = new Map<string, AgentDefinition>();
  const duplicates: string[] = [];
  for (const [name, defs] of found.entries()) {
    if (defs.length > 1) {
      duplicates.push(`Duplicate agent name "${name}": ${defs.map((d) => d.path).join(", ")}`);
      continue;
    }
    agents.set(name, defs[0]!);
  }

  if (duplicates.length > 0) {
    throw new Error(`Duplicate sub-agent names found in ${root}:\n${duplicates.join("\n")}`);
  }

  return { agents, diagnostics };
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
}) {
  const name = input.agent?.name ?? "sub-agent";
  const runtimeBlock = `<sub_agent_runtime>
You are running as delegated recursive sub-agent "${name}".
Recursion depth: ${input.depth}/${MAX_DEPTH}.
Complete only the delegated task. Return a concise, useful result to the parent agent.
You may create further sub-agents with sub_agent when the task can be cleanly split, but never exceed the recursion depth limit.
</sub_agent_runtime>`;

  if (!input.agent) return runtimeBlock;

  return `${runtimeBlock}

<sub_agent_instructions agent="${input.agent.name}" path="${input.agent.path}">
${input.agent.content}
</sub_agent_instructions>`;
}

export default async function subAgentExtension(pi: ExtensionAPI) {
  // SDK-created nested sessions can execute tool/rendering code paths that expect
  // the shared theme singleton to exist, even outside the interactive TUI.
  // Initializing it here is idempotent enough for our use and avoids
  // "Theme not initialized. Call initTheme() first." in child sessions.
  initTheme(undefined, false);

  const currentDepth = depthContext.getStore() ?? 0;
  const catalog = await scanAgentsDirectory(AGENTS_DIR);
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
    const agent = effectiveRequestedAgent ? catalog.agents.get(effectiveRequestedAgent) : undefined;
    if (effectiveRequestedAgent && !agent) {
      return {
        ok: false,
        error: `Unknown sub-agent: ${effectiveRequestedAgent}. Available agents: ${[...catalog.agents.keys()].sort().join(", ") || "(none)"}`,
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

    const agentDir = getAgentDir();
    const agentBlock = buildSubAgentSystemPrompt({ agent, depth: nextDepth });
    const loader = new DefaultResourceLoader({
      cwd: projectPath,
      agentDir,
      appendSystemPromptOverride: (base) => [...base, agentBlock],
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

      childSessionManager = resolve(projectPath) === resolve(ctx.cwd)
        ? SessionManager.open(branchFile, undefined, projectPath)
        : SessionManager.forkFrom(branchFile, projectPath);
    } else {
      childSessionManager = SessionManager.create(projectPath, undefined, { parentSession });
    }

    const subAgentLabel = forkMode ? "sub-agent:fork" : requestedAgent ? `sub-agent:${requestedAgent}` : "sub-agent";
    childSessionManager.appendSessionInfo(`${subAgentLabel} ${new Date().toISOString()}`);
    childSessionManager.appendCustomEntry("sub-agent-metadata", {
      agent: effectiveRequestedAgent ?? null,
      mode: forkMode ? "fork" : "isolated",
      parentTask: args.prompt,
      parentSession,
      projectPath,
      depth: nextDepth,
      createdAt: new Date().toISOString(),
    });

    const { session } = await depthContext.run(nextDepth, async () =>
      createAgentSession({
        cwd: projectPath,
        agentDir,
        model: ctx.model ?? undefined,
        modelRegistry: ctx.modelRegistry,
        thinkingLevel: pi.getThinkingLevel(),
        tools: pi.getActiveTools(),
        resourceLoader: loader,
        sessionManager: childSessionManager,
      }),
    );

    const id = `sub_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const run: SubAgentRun = {
      id,
      agentName: forkMode ? "fork" : requestedAgent ?? "sub-agent",
      projectPath,
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

  const availableAgents = formatAvailableAgentsForDescription(catalog);
  const diagnostics = formatAgentDiagnostics(catalog);

  pi.registerTool({
    name: "sub_agent",
    label: "Sub Agent",
    description: `Use whenever work can be cleanly separated into an independent task for another agent, even if it is small or simple. Prefer spawning sub-agents aggressively when work can be split into multiple independent tasks that can run in parallel. Pass relevant context through reference_docs whenever possible so the task prompt stays short, focused, and easy to follow. Common examples include researching separate questions, modifying different files, reviewing multiple areas of code, exploring different directions within the same codebase, and comparing alternative implementations in parallel.

Available agents from ${AGENTS_DIR}:
${availableAgents}

Important: the "agent" argument is optional. Omit it to create a generic sub-agent that builds its own system prompt from the same workspace configuration. When provided, "agent" must be a sub-agent name from a Markdown filename under ${AGENTS_DIR}. Special value: agent="fork" forks the parent session's current conversation branch instead of selecting a named agent; this takes precedence over any agent named "fork".${diagnostics}`,
    promptSnippet: "Create or continue a recursive delegated sub-agent session for independent work",
    promptGuidelines: [
      "Use sub_agent to delegate independent subtasks to named recursive sub-agents when work can be parallelized or isolated.",
      "Use sub_agent_result to check background delegated work instead of re-running the same task.",
      "Use sub_agent_stop to halt delegated work that should no longer continue.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Task description to send to the new session" }),
      agent: Type.Optional(Type.String({ description: `Optional sub-agent name to run this task. Omit to use a generic sub-agent with the same workspace configuration. Special value "fork" forks the parent session's current conversation branch and takes precedence over any agent named fork. Available agents: ${[...catalog.agents.keys()].sort().join(", ")}` })),
      run_in_background: Type.Boolean({ description: "Execution mode: true for async, false for sync" }),
      existing_session_id: Type.Optional(Type.String({ description: "Existing delegated sub-agent session ID to continue (must be a real session ID previously returned by sub_agent, e.g. sub_...)" })),
      project_path: Type.Optional(Type.String({ description: "Project path for the new session (defaults to caller's project path)" })),
      reference_docs: Type.Optional(Type.Array(Type.String(), { description: "Array of file paths to inline as reference documents" })),
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
        }

        const projectPath = args.project_path || ctx.cwd;
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
          availableAgents: [...catalog.agents.keys()].sort(),
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
