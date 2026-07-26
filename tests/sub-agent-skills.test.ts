import { describe, expect, mock, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const sessionManagerCalls: string[] = [];
let createdSessionManager: any;
let toolDefinitions: any[] = [];
let lastSessionManager: any;
let lastResourceLoaderOptions: any;
let lastCreateAgentSessionOptions: any;
let nextChildSessionFile: string | undefined;
let openedSessionFiles: string[] = [];
let sessionStartHandlers: any[] = [];
let promptedTexts: string[] = [];
let setModelCalls: any[] = [];
let setThinkingLevelCalls: any[] = [];
let childSessionEventHandlers: any[] = [];
let nextSessionStreaming = false;
let nextPromptBlocker: Promise<void> | undefined;
let resolveNextPromptBlocker: (() => void) | undefined;

function makeChildSessionManager(kind: string, sessionFile?: string) {
	const header = { type: "session", version: 3, id: "019f5262-95f7-7785-bccc-150b1c6295c0", timestamp: "2026-07-12T00:00:00.000Z", cwd: tmpdir() };
	const fileEntries: any[] = [header];
	let leafId: string | null = null;
	function appendEntry(entry: any) {
		fileEntries.push(entry);
		leafId = entry.id;
		return entry.id;
	}
	return {
		kind,
		appendSessionInfo(name: string) {
			sessionManagerCalls.push(`${kind}:appendSessionInfo`);
			return appendEntry({ type: "session_info", id: `${kind}-session-info`, parentId: leafId, timestamp: "2026-07-12T00:00:01.000Z", name });
		},
		appendCustomEntry(_type: string, data: unknown) {
			sessionManagerCalls.push(`${kind}:appendCustomEntry:${JSON.stringify(data)}`);
			return appendEntry({ type: "custom", customType: _type, data, id: `${kind}-custom`, parentId: leafId, timestamp: "2026-07-12T00:00:02.000Z" });
		},
		getEntries() {
			return fileEntries.filter((entry) => entry.type !== "session");
		},
		getHeader() {
			return header;
		},
		getSessionFile() {
			return sessionFile ?? `/tmp/${kind}/2026-07-12T00-00-00-000Z_019f5262-95f7-7785-bccc-150b1c6295c0.jsonl`;
		},
		getSessionDir() {
			return this.getSessionFile()?.replace(/\/[^/]+$/, "");
		},
		getCwd() {
			return tmpdir();
		},
	};
}

mock.module("@earendil-works/pi-coding-agent", () => ({
	createAgentSession: async (options: any) => {
		lastSessionManager = options.sessionManager;
		lastCreateAgentSessionOptions = options;
		const session: any = {
			model: options.model,
			thinkingLevel: options.thinkingLevel,
			messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
			sessionManager: options.sessionManager,
			get sessionId() {
				return options.sessionManager.getHeader?.()?.id ?? "019f5262-95f7-7785-bccc-150b1c6295c0";
			},
			get sessionFile() {
				return options.sessionManager.getSessionFile?.();
			},
			get isStreaming() {
				return nextSessionStreaming;
			},
			isCompacting: false,
			isBashRunning: false,
			autoCompactionEnabled: false,
			autoRetryEnabled: false,
			pendingMessageCount: 0,
			agent: { state: { systemPrompt: "child system", thinkingLevel: options.thinkingLevel ?? "off" } },
			subscribe(handler: any) {
				childSessionEventHandlers.push(handler);
				return () => undefined;
			},
			async prompt(text: string) {
				promptedTexts.push(text);
				for (const handler of childSessionEventHandlers) {
					handler({
						type: "message_update",
						message: { role: "assistant", content: [{ type: "text", text: "streaming partial" }] },
						assistantMessageEvent: { type: "text_delta", delta: "streaming partial" },
					});
				}
				if (nextPromptBlocker) await nextPromptBlocker;
			},
			async setModel(model: any) {
				setModelCalls.push(model);
				session.model = model;
			},
			setThinkingLevel(level: any) {
				setThinkingLevelCalls.push(level);
				session.thinkingLevel = level;
			},
			async abort() {},
			dispose() {},
			getContextUsage: () => null,
			getSteeringMessages: () => [],
			getFollowUpMessages: () => [],
		};
		return {
			session,
		};
	},
	DefaultResourceLoader: class {
		options: any;
		constructor(options: any) {
			this.options = options;
			lastResourceLoaderOptions = options;
		}
		async reload() {}
	},
	getAgentDir: () => "/tmp/pi-agent-dir",
	initTheme: () => undefined,
	SessionManager: {
		create: () => {
			createdSessionManager = makeChildSessionManager("create", nextChildSessionFile);
			nextChildSessionFile = undefined;
			return createdSessionManager;
		},
		open: (path: string) => {
			openedSessionFiles.push(path);
			sessionManagerCalls.push(`open:${path}`);
			return makeChildSessionManager("open", path);
		},
		forkFrom: (source: string, target: string) => {
			sessionManagerCalls.push(`forkFrom:${source}:${target}`);
			return makeChildSessionManager("forkFrom");
		},
	},
}));

mock.module("@earendil-works/pi-ai", () => ({
	StringEnum: (values: readonly string[]) => values,
}));

mock.module("typebox", () => ({
	Type: {
		Array: (schema: unknown, options?: Record<string, unknown>) => ({ schema, ...options }),
		Boolean: (schema: unknown) => schema,
		Object: (schema: unknown) => schema,
		Optional: (schema: unknown) => ({ ...(schema as Record<string, unknown>), optional: true }),
		String: (schema: unknown) => schema,
	},
}));

async function loadSubAgentExtension() {
	toolDefinitions = [];
	sessionStartHandlers = [];
	openedSessionFiles = [];
	promptedTexts = [];
	setModelCalls = [];
	setThinkingLevelCalls = [];
	childSessionEventHandlers = [];
	nextChildSessionFile = undefined;
	nextSessionStreaming = false;
	nextPromptBlocker = undefined;
	resolveNextPromptBlocker = undefined;
	delete (globalThis as any).__piSessions;
	delete (globalThis as any).__piRunningListeners;
	const { default: subAgentExtension } = await import("../extensions/sub-agent/sub-agent.ts");
	await subAgentExtension({
		on(eventName: string, handler: any) {
			if (eventName === "session_start") sessionStartHandlers.push(handler);
		},
		registerTool(definition: any) {
			toolDefinitions.push(definition);
		},
		getThinkingLevel: () => undefined,
		getActiveTools: () => [],
	} as never);
	return toolDefinitions.find((tool) => tool.name === "sub_agent");
}

function latestSubAgentTool() {
	return [...toolDefinitions].reverse().find((tool) => tool.name === "sub_agent");
}

describe("sub_agent agents.ts project catalog", () => {
	test("refreshes available agent descriptions from session cwd instead of process cwd", async () => {
		const projectDir = join(tmpdir(), `pi-sub-agent-session-cwd-${Date.now()}`);
		await mkdir(join(projectDir, ".pi"), { recursive: true });
		await writeFile(join(projectDir, ".pi", "agents.ts"), `
export default {
  helper: {
    description: "Session cwd helper",
    systemPrompt: "helper prompt"
  }
};
`);

		const originalCwd = process.cwd();
		try {
			process.chdir("/tmp");
			await loadSubAgentExtension();
			expect(latestSubAgentTool().description).not.toContain("helper: Session cwd helper");
			expect(sessionStartHandlers).toHaveLength(1);

			await sessionStartHandlers[0]({ type: "session_start", reason: "new" }, { cwd: projectDir });

			expect(latestSubAgentTool().description).toContain("helper: Session cwd helper");
			expect(latestSubAgentTool().parameters.agent.description).toContain("Available named agents: helper");
		} finally {
			process.chdir(originalCwd);
			await rm(projectDir, { recursive: true, force: true });
		}
	});

	test("omitted agent inherits parent effective system prompt", async () => {
		lastResourceLoaderOptions = undefined;
		const tool = await loadSubAgentExtension();
		await tool.execute(
			"call-default-inherit-parent",
			{ prompt: "do work", run_in_background: false },
			undefined,
			undefined,
			{
				cwd: process.cwd(),
				getSystemPrompt: () => "parent effective system prompt",
				sessionManager: { getSessionFile: () => undefined },
			},
		);

		expect(lastResourceLoaderOptions.systemPromptOverride("child base prompt")).toBe("parent effective system prompt");
		const appended = lastResourceLoaderOptions.appendSystemPromptOverride([]).join("\n");
		expect(appended).toContain('delegated recursive sub-agent "sub-agent"');
		expect(appended).not.toContain("parent effective system prompt");
	});

	test("loads systemPromptFile relative to agents.ts", async () => {
		lastResourceLoaderOptions = undefined;
		const projectDir = join(tmpdir(), `pi-sub-agent-file-${Date.now()}`);
		await mkdir(join(projectDir, ".pi", "prompts"), { recursive: true });
		await writeFile(join(projectDir, ".pi", "prompts", "helper.md"), "file prompt");
		await writeFile(join(projectDir, ".pi", "agents.ts"), `
export default {
  helper: {
    description: "File helper",
    systemPromptFile: "./prompts/helper.md"
  }
};
`);

		try {
			const tool = await loadSubAgentExtension();
			const result = await tool.execute(
				"call-file-agent",
				{ prompt: "do work", agent: "helper", project_path: projectDir, run_in_background: false },
				undefined,
				undefined,
				{ cwd: process.cwd(), sessionManager: { getSessionFile: () => undefined } },
			);

			expect(JSON.parse(result.content[0].text)).toEqual({ session_id: expect.any(String), response: "done" });
			expect(promptedTexts).toEqual(["do work"]);
			const appended = lastResourceLoaderOptions.appendSystemPromptOverride([]).join("\n");
			expect(appended).toContain("file prompt");
		} finally {
			await rm(projectDir, { recursive: true, force: true });
		}
	});

	test("loads nested agents.ts catalog format without treating mainAgent as an agent", async () => {
		lastResourceLoaderOptions = undefined;
		const projectDir = join(tmpdir(), `pi-sub-agent-nested-catalog-${Date.now()}`);
		await mkdir(join(projectDir, ".pi"), { recursive: true });
		await writeFile(join(projectDir, ".pi", "agents.ts"), `
export default {
  mainAgent: "main",
  agents: {
    main: {
      description: "Main coordinator",
      systemPrompt: "main prompt"
    },
    helper: {
      description: "Nested helper",
      systemPrompt: "nested helper prompt"
    }
  }
};
`);

		const originalCwd = process.cwd();
		try {
			process.chdir(projectDir);
			await loadSubAgentExtension();
			await sessionStartHandlers[0]({ type: "session_start", reason: "new" }, { cwd: projectDir });
			const tool = latestSubAgentTool();
			process.chdir(originalCwd);
			expect(tool.description).toContain("helper: Nested helper");
			expect(tool.description).not.toContain("main: Main coordinator");
			expect(tool.description).not.toContain("mainAgent");

			await tool.execute(
				"call-nested-agent",
				{ prompt: "do work", agent: "helper", project_path: projectDir, run_in_background: false },
				undefined,
				undefined,
				{ cwd: process.cwd(), sessionManager: { getSessionFile: () => undefined } },
			);

			const appended = lastResourceLoaderOptions.appendSystemPromptOverride([]).join("\n");
			expect(appended).toContain('agent="helper"');
			expect(appended).toContain("nested helper prompt");
			expect(appended).not.toContain("main prompt");
		} finally {
			process.chdir(originalCwd);
			await rm(projectDir, { recursive: true, force: true });
		}
	});

	test("filters the main agent runtime extension from child resource loaders", async () => {
		lastResourceLoaderOptions = undefined;
		const projectDir = join(tmpdir(), `pi-sub-agent-filter-runtime-${Date.now()}`);
		await mkdir(join(projectDir, ".pi"), { recursive: true });
		await writeFile(join(projectDir, ".pi", "agents.ts"), `
export default {
  helper: {
    description: "Project helper agent",
    systemPrompt: "helper prompt"
  }
};
`);

		try {
			const tool = await loadSubAgentExtension();
			await tool.execute(
				"call-filter-runtime",
				{ prompt: "do work", agent: "helper", project_path: projectDir, run_in_background: false },
				undefined,
				undefined,
				{ cwd: process.cwd(), sessionManager: { getSessionFile: () => undefined } },
			);

			const agentRuntimeExtension = {
				path: "../../../extensions/agent-runtime/agent-runtime.ts",
				resolvedPath: resolve("extensions/agent-runtime/agent-runtime.ts"),
			};
			const otherExtension = {
				path: "../../../extensions/tool-policy/disable-basic-tools.ts",
				resolvedPath: resolve("extensions/tool-policy/disable-basic-tools.ts"),
			};

			const filtered = lastResourceLoaderOptions.extensionsOverride({
				extensions: [agentRuntimeExtension, otherExtension],
				errors: [],
				runtime: {},
			});

			expect(filtered.extensions).toEqual([otherExtension]);
		} finally {
			await rm(projectDir, { recursive: true, force: true });
		}
	});

	test("uses workspace agent cwd without injecting agent-specific prompt", async () => {
		lastResourceLoaderOptions = undefined;
		const projectDir = join(tmpdir(), `pi-sub-agent-workspace-project-${Date.now()}`);
		const workspaceDir = join(tmpdir(), `pi-sub-agent-workspace-target-${Date.now()}`);
		await mkdir(join(projectDir, ".pi"), { recursive: true });
		await mkdir(workspaceDir, { recursive: true });
		await writeFile(join(projectDir, ".pi", "agents.ts"), `
export default {
  helper: {
    description: "Workspace helper",
    workspace: ${JSON.stringify(workspaceDir)}
  }
};
`);

		try {
			const tool = await loadSubAgentExtension();
			await tool.execute(
				"call-workspace-agent",
				{ prompt: "do work", agent: "helper", project_path: projectDir, run_in_background: false },
				undefined,
				undefined,
				{ cwd: process.cwd(), sessionManager: { getSessionFile: () => undefined } },
			);

			expect(lastResourceLoaderOptions.cwd).toBe(workspaceDir);
			expect(lastCreateAgentSessionOptions.tools).toBeUndefined();
			const appended = lastResourceLoaderOptions.appendSystemPromptOverride([]).join("\n");
			expect(appended).toContain('delegated recursive sub-agent "helper"');
			expect(appended).not.toContain("<sub_agent_instructions");
		} finally {
			await rm(projectDir, { recursive: true, force: true });
			await rm(workspaceDir, { recursive: true, force: true });
		}
	});

	test("treats agent=generic as explicit generic isolated sub-agent", async () => {
		lastResourceLoaderOptions = undefined;
		const projectDir = join(tmpdir(), `pi-sub-agent-generic-${Date.now()}`);
		await mkdir(join(projectDir, ".pi"), { recursive: true });
		await writeFile(join(projectDir, ".pi", "agents.ts"), `
export default {
  helper: {
    description: "Project helper agent",
    systemPrompt: "helper prompt"
  },
  generic: {
    description: "Should be shadowed by reserved generic mode",
    systemPrompt: "generic named prompt"
  }
};
`);

		try {
			const tool = await loadSubAgentExtension();
			const result = await tool.execute(
				"call-generic-agent",
				{ prompt: "do work", agent: "generic", project_path: projectDir, run_in_background: false },
				undefined,
				undefined,
				{ cwd: process.cwd(), getSystemPrompt: () => "parent effective system prompt", sessionManager: { getSessionFile: () => undefined } },
			);

			expect(JSON.parse(result.content[0].text)).toEqual({ session_id: expect.any(String), response: "done" });
			expect(lastResourceLoaderOptions.systemPromptOverride?.("child base prompt") ?? "child base prompt").toBe("child base prompt");
			const appended = lastResourceLoaderOptions.appendSystemPromptOverride([]).join("\n");
			expect(appended).toContain('delegated recursive sub-agent "sub-agent"');
			expect(appended).not.toContain("<sub_agent_instructions");
			expect(appended).not.toContain("generic named prompt");
			expect(sessionManagerCalls.some((call) => call.includes('"agent":null'))).toBe(true);
		} finally {
			await rm(projectDir, { recursive: true, force: true });
		}
	});

	test("loads project agents.ts descriptions and inline system prompts", async () => {
		lastResourceLoaderOptions = undefined;
		const projectDir = join(tmpdir(), `pi-sub-agent-project-${Date.now()}`);
		await mkdir(join(projectDir, ".pi"), { recursive: true });
		await writeFile(join(projectDir, ".pi", "agents.ts"), `
export default {
  helper: {
    description: "Project helper agent",
    systemPrompt: "You are a project helper."
  }
};
`);

		const originalCwd = process.cwd();
		try {
			process.chdir(projectDir);
			await loadSubAgentExtension();
			await sessionStartHandlers[0]({ type: "session_start", reason: "new" }, { cwd: projectDir });
			const tool = latestSubAgentTool();
			expect(tool.description).toContain("helper: Project helper agent");

			const result = await tool.execute(
				"call-project-agent",
				{ prompt: "do work", agent: "helper", project_path: projectDir, run_in_background: false },
				undefined,
				undefined,
				{ cwd: process.cwd(), sessionManager: { getSessionFile: () => undefined } },
			);

			expect(JSON.parse(result.content[0].text)).toEqual({ session_id: expect.any(String), response: "done" });
			const appended = lastResourceLoaderOptions.appendSystemPromptOverride([]).join("\n");
			expect(appended).toContain('<sub_agent_instructions agent="helper"');
			expect(appended).toContain("You are a project helper.");
		} finally {
			process.chdir(originalCwd);
			await rm(projectDir, { recursive: true, force: true });
		}
	});

	test("describes delegation, fork, reference_docs, and continuation boundaries", async () => {
		const tool = await loadSubAgentExtension();

		expect(tool.description).toContain("Prefer delegation when a task is independently executable");
		expect(tool.description).toContain("Keep work in the parent only when delegation would clearly add coordination cost without benefit");
		expect(tool.description).not.toContain("Do not delegate merely because a task exists");
		expect(tool.description).toContain("Omit \"agent\" for ordinary isolated delegation");
		expect(tool.description).toContain("Use agent=\"generic\"");
		expect(tool.description).not.toContain("Available agents from");
		expect(tool.description).not.toContain("Named agents are loaded");
		expect(tool.description).not.toContain("shallow-merge");
		expect(tool.description).not.toContain("no parent/named agent prompt injection");
		expect(tool.description).toContain("Use agent=\"fork\" when inherited conversation context is materially needed");
		expect(tool.description).toContain("Fork is a context-inheritance mode, not a specialized worker");
		expect(tool.description).toContain("reference_docs and fork are independent optimizations");
		expect(tool.description).toContain("Use existing_session_id only to continue the same child session");
		expect(tool.description).toContain("Do not provide project_path or agent with existing_session_id");
		expect(tool.description).toContain("relative reference_docs paths resolve against that existing session's project path");
		expect(tool.promptGuidelines).toContain("Prefer sub_agent for independently executable work with clear payoff: parallelism, isolation, specialized behavior, independent review, context preservation, or filtering noisy output.");
		expect(tool.parameters.prompt.description).toContain("for fork or existing_session_id, provide the incremental follow-up task");
		expect(tool.parameters.prompt.optional).toBeUndefined();
		expect(tool.parameters.agent.optional).toBe(true);
		expect(tool.parameters.run_in_background.optional).toBe(true);
		expect(tool.parameters.existing_session_id.optional).toBe(true);
		expect(tool.parameters.project_path.optional).toBe(true);
		expect(tool.parameters.reference_docs.optional).toBe(true);
		expect(tool.parameters.agent.description).toContain("Role or context mode for a new sub-agent session");
		expect(tool.parameters.agent.description).toContain("Omit for ordinary isolated delegation");
		expect(tool.parameters.agent.description).toContain("Use a named agent when its description clearly matches the task");
		expect(tool.parameters.agent.description).toContain("Use \"generic\" for a neutral helper");
		expect(tool.parameters.agent.description).toContain("Use \"fork\" when inherited conversation context is materially needed");
		expect(tool.parameters.agent.description).toContain("Do not provide with existing_session_id");
		expect(tool.parameters.agent.description).not.toContain("prompt injection");
		expect(tool.parameters.agent.description).not.toContain("takes precedence");
		expect(tool.parameters.project_path.description).toContain("Do not provide project_path with existing_session_id");
		expect(tool.parameters.existing_session_id.description).toContain("Use only to continue, refine, follow up, or correct work");
		expect(tool.parameters.reference_docs.description).toContain("paths are much shorter, faster, or more accurate");
		expect(tool.parameters.reference_docs.description).toContain("existing session's original project path");
	});

	test("rejects project_path and agent when continuing an existing session", async () => {
		const tool = await loadSubAgentExtension();
		const created = await tool.execute(
			"call-create",
			{ prompt: "start", run_in_background: false },
			undefined,
			undefined,
			{ cwd: process.cwd(), sessionManager: { getSessionFile: () => undefined } },
		);
		const sessionID = JSON.parse(created.content[0].text).session_id;

		const withProjectPath = await tool.execute(
			"call-continue-project",
			{ prompt: "continue", existing_session_id: sessionID, project_path: tmpdir(), run_in_background: false },
			undefined,
			undefined,
			{ cwd: process.cwd(), sessionManager: { getSessionFile: () => undefined } },
		);
		expect(JSON.parse(withProjectPath.content[0].text)).toEqual({
			session_id: sessionID,
			error: "project_path cannot be used with existing_session_id; continuing an existing sub-agent keeps its original project context. To use a different project, omit existing_session_id and create a new sub-agent session.",
		});

		const withAgent = await tool.execute(
			"call-continue-agent",
			{ prompt: "continue", existing_session_id: sessionID, agent: "fork", run_in_background: false },
			undefined,
			undefined,
			{ cwd: process.cwd(), sessionManager: { getSessionFile: () => undefined } },
		);
		expect(JSON.parse(withAgent.content[0].text)).toEqual({
			session_id: sessionID,
			error: "agent cannot be used with existing_session_id; continuing an existing sub-agent keeps its original agent identity and fork/isolated mode. To use a different agent or mode, omit existing_session_id and create a new sub-agent session.",
		});
	});

	test("syncs live existing sub-agent sessions to the current parent model before continuing", async () => {
		const tool = await loadSubAgentExtension();
		const firstModel = { provider: "test", id: "model-a" };
		const nextModel = { provider: "test", id: "model-b" };

		const created = await tool.execute(
			"call-create-model-a",
			{ prompt: "start", run_in_background: false },
			undefined,
			undefined,
			{ cwd: process.cwd(), model: firstModel, sessionManager: { getSessionFile: () => undefined } },
		);
		const sessionID = JSON.parse(created.content[0].text).session_id;

		await tool.execute(
			"call-continue-model-b",
			{ prompt: "continue", existing_session_id: sessionID, run_in_background: false },
			undefined,
			undefined,
			{ cwd: process.cwd(), model: nextModel, sessionManager: { getSessionFile: () => undefined } },
		);

		expect(setModelCalls).toEqual([nextModel]);
		expect(promptedTexts).toEqual(["start", "continue"]);
	});

	test("streams child session progress through the parent tool onUpdate callback", async () => {
		const tool = await loadSubAgentExtension();
		const updates: any[] = [];

		await tool.execute(
			"call-stream-progress",
			{ prompt: "start", run_in_background: false },
			undefined,
			(update: any) => updates.push(update),
			{ cwd: process.cwd(), sessionManager: { getSessionFile: () => undefined } },
		);

		expect(updates.length).toBeGreaterThan(0);
		expect(updates.at(-1).details.partial_content).toBe("streaming partial");
	});

	test("returns compact stateless session ids from persisted session file names", async () => {
		const tool = await loadSubAgentExtension();
		const projectDir = join(tmpdir(), `pi-sub-agent-short-id-${Date.now()}`);
		const sessionDirName = `--${resolve(projectDir).replace(/^[\\/]/, "").replace(/[\\/:]/g, "-")}--`;
		const sessionFile = join(tmpdir(), "pi-agent", "sessions", sessionDirName, "2026-07-12T00-00-00-000Z_019f5262-95f7-7785-bccc-150b1c6295c0.jsonl");
		nextChildSessionFile = sessionFile;

		const result = await tool.execute(
			"call-short-id",
			{ prompt: "start", project_path: projectDir, run_in_background: false },
			undefined,
			undefined,
			{ cwd: projectDir, sessionManager: { getSessionFile: () => undefined } },
		);

		const payload = JSON.parse(result.content[0].text);
		const expectedTime = (Date.parse("2026-07-12T00:00:00.000Z") - Date.UTC(2000, 0, 1)).toString(36);
		expect(payload.session_id).toBe(`${expectedTime}_1c6295c0`);
		expect(payload.session_id.length).toBeLessThanOrEqual(18);
	});

	test("materializes new sub-agent session files before the first assistant response", async () => {
		const tool = await loadSubAgentExtension();
		const projectDir = join(tmpdir(), `pi-sub-agent-materialize-${Date.now()}`);
		const sessionFile = join(projectDir, ".pi-agent", "sessions", "2026-07-12T00-00-00-000Z_019f5262-95f7-7785-bccc-150b1c6295c0.jsonl");
		nextChildSessionFile = sessionFile;

		try {
			const result = await tool.execute(
				"call-materialize",
				{ prompt: "start", project_path: projectDir, run_in_background: true },
				undefined,
				undefined,
				{ cwd: projectDir, sessionManager: { getSessionFile: () => undefined } },
			);

			expect(JSON.parse(result.content[0].text).session_file).toBe(sessionFile);
			expect(existsSync(sessionFile)).toBe(true);
			const contents = await readFile(sessionFile, "utf8");
			expect(contents).toContain('"type":"session"');
			expect(contents).toContain('"type":"session_info"');
			expect(contents).toContain('"customType":"sub-agent-metadata"');
			expect(openedSessionFiles).toContain(sessionFile);
			expect(lastSessionManager.kind).toBe("open");
		} finally {
			await rm(projectDir, { recursive: true, force: true });
		}
	});

	test("reopens compact session ids by scanning the parent project session directory before global sessions", async () => {
		const projectDir = join(tmpdir(), `pi-sub-agent-reopen-${Date.now()}`);
		const agentDir = "/tmp/pi-agent-dir";
		const parentSessionDir = join(agentDir, "sessions", `--${resolve(projectDir).replace(/^[\\/]/, "").replace(/[\\/:]/g, "-")}--`);
		const otherSessionDir = join(agentDir, "sessions", "--other-project--");
		const fileName = "2026-07-12T00-00-00-000Z_019f5262-95f7-7785-bccc-150b1c6295c0.jsonl";
		await mkdir(parentSessionDir, { recursive: true });
		await mkdir(otherSessionDir, { recursive: true });
		await writeFile(join(parentSessionDir, fileName), "");
		await writeFile(join(otherSessionDir, fileName), "");

		try {
			const tool = await loadSubAgentExtension();
			const expectedTime = (Date.parse("2026-07-12T00:00:00.000Z") - Date.UTC(2000, 0, 1)).toString(36);
			const sessionID = `${expectedTime}_1c6295c0`;

			const result = await tool.execute(
				"call-reopen",
				{ prompt: "continue", existing_session_id: sessionID, run_in_background: false },
				undefined,
				undefined,
				{ cwd: projectDir, sessionManager: { getSessionFile: () => undefined } },
			);

			expect(JSON.parse(result.content[0].text)).toEqual({ session_id: sessionID, response: "done" });
			expect(openedSessionFiles[0]).toBe(join(parentSessionDir, fileName));
		} finally {
			await rm(join(agentDir, "sessions"), { recursive: true, force: true });
		}
	});

	test("registers running child sessions in the Pi Web live registry and unregisters after completion", async () => {
		const tool = await loadSubAgentExtension();
		const projectDir = join(tmpdir(), `pi-sub-agent-pi-web-live-${Date.now()}`);
		const sessionFile = join(projectDir, ".pi-agent", "sessions", "2026-07-12T00-00-00-000Z_019f5262-95f7-7785-bccc-150b1c6295c0.jsonl");
		nextChildSessionFile = sessionFile;
		nextSessionStreaming = true;
		nextPromptBlocker = new Promise<void>((resolve) => {
			resolveNextPromptBlocker = resolve;
		});

		const runningSnapshots: string[][] = [];
		(globalThis as any).__piRunningListeners = new Set([(ids: string[]) => runningSnapshots.push(ids)]);

		try {
			const result = await tool.execute(
				"call-pi-web-live-registry",
				{ prompt: "start", project_path: projectDir, run_in_background: true },
				undefined,
				undefined,
				{ cwd: projectDir, sessionManager: { getSessionFile: () => undefined } },
			);

			const payload = JSON.parse(result.content[0].text);
			expect(payload.session_file).toBe(sessionFile);

			const registry = (globalThis as any).__piSessions;
			expect(registry).toBeInstanceOf(Map);
			const wrapper = registry.get("019f5262-95f7-7785-bccc-150b1c6295c0");
			expect(wrapper).toBeTruthy();
			expect(wrapper.sessionId).toBe("019f5262-95f7-7785-bccc-150b1c6295c0");
			expect(wrapper.sessionFile).toBe(sessionFile);
			expect(wrapper.isAlive()).toBe(true);
			expect(wrapper.isRunning()).toBe(true);
			expect(runningSnapshots.some((ids) => ids.includes("019f5262-95f7-7785-bccc-150b1c6295c0"))).toBe(true);

			const events: any[] = [];
			const unsubscribe = wrapper.onEvent((event: any) => events.push(event));
			for (const handler of childSessionEventHandlers) {
				handler({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "live" }, message: { role: "assistant", content: [{ type: "text", text: "live" }] } });
			}
			expect(events.at(-1)?.type).toBe("message_update");
			unsubscribe();

			expect(await wrapper.send({ type: "get_state" })).toMatchObject({
				sessionId: "019f5262-95f7-7785-bccc-150b1c6295c0",
				sessionFile,
				isStreaming: true,
				isPromptRunning: true,
			});

			nextSessionStreaming = false;
			resolveNextPromptBlocker?.();
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(registry.has("019f5262-95f7-7785-bccc-150b1c6295c0")).toBe(false);
			expect(runningSnapshots.at(-1)).not.toContain("019f5262-95f7-7785-bccc-150b1c6295c0");
		} finally {
			resolveNextPromptBlocker?.();
			await rm(projectDir, { recursive: true, force: true });
		}
	});

	test("sub_agent_result resolves compact ids through the cached/scanned session index", async () => {
		const projectDir = join(tmpdir(), `pi-sub-agent-result-${Date.now()}`);
		const agentDir = "/tmp/pi-agent-dir";
		const parentSessionDir = join(agentDir, "sessions", `--${resolve(projectDir).replace(/^[\\/]/, "").replace(/[\\/:]/g, "-")}--`);
		const fileName = "2026-07-12T00-00-00-000Z_019f5262-95f7-7785-bccc-150b1c6295c0.jsonl";
		await mkdir(parentSessionDir, { recursive: true });
		await writeFile(join(parentSessionDir, fileName), "");

		try {
			await loadSubAgentExtension();
			const resultTool = toolDefinitions.find((tool) => tool.name === "sub_agent_result");
			const expectedTime = (Date.parse("2026-07-12T00:00:00.000Z") - Date.UTC(2000, 0, 1)).toString(36);
			const sessionID = `${expectedTime}_1c6295c0`;

			const result = await resultTool.execute(
				"call-result",
				{ session_ids: [sessionID], wait: "none" },
				undefined,
				undefined,
				{ cwd: projectDir, sessionManager: { getSessionFile: () => undefined } },
			);

			const payload = JSON.parse(result.content[0].text);
			expect(payload[0]).toMatchObject({
				session_id: sessionID,
				session_file: join(parentSessionDir, fileName),
				status: "completed",
				content: "done",
			});
		} finally {
			await rm(join(agentDir, "sessions"), { recursive: true, force: true });
		}
	});
});

describe("sub-agent skill discovery", () => {
	test("does not expose legacy subagent skills", async () => {
		const handlers: Array<() => Promise<{ skillPaths?: string[] }>> = [];
		const { default: subAgentExtension } = await import("../extensions/sub-agent/sub-agent.ts");

		await subAgentExtension({
			on(eventName: string, handler: () => Promise<{ skillPaths?: string[] }>) {
				if (eventName === "resources_discover") handlers.push(handler);
			},
			registerTool() {},
			getThinkingLevel: () => undefined,
			getActiveTools: () => [],
		} as never);

		expect(handlers).toHaveLength(0);
	});
});

describe("sub_agent fork mode", () => {
	function makeParentBranch(forkPrompt: string, toolAgent = "fork") {
		return [
			{ type: "message", id: "user-1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hello", timestamp: 1 } },
			{
				type: "message",
				id: "assistant-1",
				parentId: "user-1",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "I will fork." },
						{ type: "toolCall", id: "call-1", name: "sub_agent", arguments: { prompt: forkPrompt, agent: toolAgent, run_in_background: false } },
					],
					timestamp: 2,
				},
			},
		];
	}

	test('treats agent="fork" as fork mode before named-agent lookup', async () => {
		sessionManagerCalls.length = 0;
		const forkDir = join(tmpdir(), `pi-sub-agent-fork-${Date.now()}`);
		await mkdir(forkDir, { recursive: true });
		const tool = await loadSubAgentExtension();
		const parentSessionManager = {
			getSessionFile: () => join(forkDir, "parent.jsonl"),
			getSessionDir: () => forkDir,
			getLeafId: () => "assistant-1",
			getBranch: (leafId: string) => {
				sessionManagerCalls.push(`getBranch:${leafId}`);
				return makeParentBranch("do work");
			},
			createBranchedSession: () => {
				throw new Error("createBranchedSession mutates the parent session and must not be used");
			},
		};

		try {
			const result = await tool.execute(
				"call-1",
				{ prompt: "do work", agent: "fork", run_in_background: false },
				undefined,
				undefined,
				{ cwd: process.cwd(), getSystemPrompt: () => "parent fork system prompt", sessionManager: parentSessionManager },
			);

			expect(lastResourceLoaderOptions.systemPromptOverride("child base prompt")).toBe("parent fork system prompt");

			expect(JSON.parse(result.content[0].text)).toEqual({ session_id: expect.any(String), response: "done" });
			expect(sessionManagerCalls).toContain("getBranch:assistant-1");
			expect(sessionManagerCalls.some((call) => call.startsWith(`open:${forkDir}/`))).toBe(true);
			expect(lastSessionManager.kind).toBe("open");
			expect(sessionManagerCalls.some((call) => call.startsWith("create:appendSessionInfo"))).toBe(false);
		} finally {
			await rm(forkDir, { recursive: true, force: true });
		}
	});

	test("prunes the current sub_agent fork tool call from fork branch snapshots", async () => {
		sessionManagerCalls.length = 0;
		const forkDir = join(tmpdir(), `pi-sub-agent-fork-prune-${Date.now()}`);
		await mkdir(forkDir, { recursive: true });
		const tool = await loadSubAgentExtension();
		const parentSessionManager = {
			getSessionFile: () => join(forkDir, "parent.jsonl"),
			getSessionDir: () => forkDir,
			getLeafId: () => "assistant-1",
			getBranch: () => makeParentBranch("do work"),
		};

		try {
			const result = await tool.execute(
				"call-prune-fork",
				{ prompt: "do work", agent: "fork", run_in_background: false },
				undefined,
				undefined,
				{ cwd: process.cwd(), sessionManager: parentSessionManager },
			);

			expect(JSON.parse(result.content[0].text)).toEqual({ session_id: expect.any(String), response: "done" });
			expect(openedSessionFiles).toHaveLength(1);
			const branchContents = await readFile(openedSessionFiles[0], "utf8");
			expect(branchContents).not.toContain('"name":"sub_agent"');
			expect(branchContents).not.toContain('"type":"toolCall"');
			expect(branchContents).toContain('"text":"I will fork."');
		} finally {
			await rm(forkDir, { recursive: true, force: true });
		}
	});

	test("fails fork mode when parent branch does not end with the current fork tool call", async () => {
		sessionManagerCalls.length = 0;
		lastCreateAgentSessionOptions = undefined;
		const forkDir = join(tmpdir(), `pi-sub-agent-fork-prune-fail-${Date.now()}`);
		await mkdir(forkDir, { recursive: true });
		const tool = await loadSubAgentExtension();
		const parentSessionManager = {
			getSessionFile: () => join(forkDir, "parent.jsonl"),
			getSessionDir: () => forkDir,
			getLeafId: () => "assistant-1",
			getBranch: () => makeParentBranch("do work", "helper"),
		};

		try {
			const result = await tool.execute(
				"call-prune-fork-fail",
				{ prompt: "do work", agent: "fork", run_in_background: false },
				undefined,
				undefined,
				{ cwd: process.cwd(), sessionManager: parentSessionManager },
			);

			const payload = JSON.parse(result.content[0].text);
			expect(payload.message ?? payload.error).toContain("fork snapshot pruning failed because parent branch did not end with the current sub_agent fork tool call");
			expect(openedSessionFiles).toHaveLength(0);
			expect(lastCreateAgentSessionOptions).toBeUndefined();
		} finally {
			await rm(forkDir, { recursive: true, force: true });
		}
	});

	test("adds forked_subagent_context to the first fork prompt after reference documents", async () => {
		const forkDir = join(tmpdir(), `pi-sub-agent-fork-context-${Date.now()}`);
		const refDoc = join(forkDir, "ref.md");
		await mkdir(forkDir, { recursive: true });
		await writeFile(refDoc, "reference body");
		const tool = await loadSubAgentExtension();
		const parentSessionManager = {
			getSessionFile: () => join(forkDir, "parent.jsonl"),
			getSessionDir: () => forkDir,
			getLeafId: () => "assistant-1",
			getBranch: () => makeParentBranch("do fork work"),
		};

		try {
			const result = await tool.execute(
				"call-fork-context",
				{ prompt: "do fork work", agent: "fork", reference_docs: [refDoc], run_in_background: false },
				undefined,
				undefined,
				{ cwd: process.cwd(), sessionManager: parentSessionManager },
			);

			expect(JSON.parse(result.content[0].text)).toEqual({ session_id: expect.any(String), response: "done" });
			expect(promptedTexts).toHaveLength(1);
			expect(promptedTexts[0]).toStartWith("<reference_documents>");
			expect(promptedTexts[0]).toContain("</reference_documents>\n\n<forked_subagent_context>");
			expect(promptedTexts[0]).toContain("You are a forked sub-agent.");
			expect(promptedTexts[0]).toContain("All conversation history and tool results that existed before this fork request are inherited context.");
			expect(promptedTexts[0]).not.toContain("visible sub_agent tool call");
			expect(promptedTexts[0]).toContain("</forked_subagent_context>\n\n<delegated_task>\ndo fork work\n</delegated_task>");
		} finally {
			await rm(forkDir, { recursive: true, force: true });
		}
	});

	test("does not add forked_subagent_context to ordinary isolated sub-agent prompts", async () => {
		const tool = await loadSubAgentExtension();

		const result = await tool.execute(
			"call-isolated-no-fork-context",
			{ prompt: "do isolated work", run_in_background: false },
			undefined,
			undefined,
			{ cwd: process.cwd(), sessionManager: { getSessionFile: () => undefined } },
		);

		expect(JSON.parse(result.content[0].text)).toEqual({ session_id: expect.any(String), response: "done" });
		expect(promptedTexts).toEqual(["do isolated work"]);
	});

	test("does not repeat forked_subagent_context when continuing an existing fork run", async () => {
		const forkDir = join(tmpdir(), `pi-sub-agent-fork-context-continue-${Date.now()}`);
		await mkdir(forkDir, { recursive: true });
		const tool = await loadSubAgentExtension();
		const parentSessionManager = {
			getSessionFile: () => join(forkDir, "parent.jsonl"),
			getSessionDir: () => forkDir,
			getLeafId: () => "assistant-1",
			getBranch: () => makeParentBranch("start fork"),
		};

		try {
			const created = await tool.execute(
				"call-fork-context-continue-start",
				{ prompt: "start fork", agent: "fork", run_in_background: false },
				undefined,
				undefined,
				{ cwd: process.cwd(), sessionManager: parentSessionManager },
			);
			const sessionID = JSON.parse(created.content[0].text).session_id;

			const continued = await tool.execute(
				"call-fork-context-continue-next",
				{ prompt: "continue fork", existing_session_id: sessionID, run_in_background: false },
				undefined,
				undefined,
				{ cwd: process.cwd(), sessionManager: parentSessionManager },
			);

			expect(JSON.parse(continued.content[0].text)).toEqual({ session_id: sessionID, response: "done" });
			expect(promptedTexts).toHaveLength(2);
			expect(promptedTexts[0]).toContain("<forked_subagent_context>");
			expect(promptedTexts[1]).toBe("continue fork");
		} finally {
			await rm(forkDir, { recursive: true, force: true });
		}
	});
});
