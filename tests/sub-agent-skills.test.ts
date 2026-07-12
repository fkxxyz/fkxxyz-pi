import { describe, expect, mock, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
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

function makeChildSessionManager(kind: string, sessionFile?: string) {
	return {
		kind,
		appendSessionInfo() {
			sessionManagerCalls.push(`${kind}:appendSessionInfo`);
		},
		appendCustomEntry(_type: string, data: unknown) {
			sessionManagerCalls.push(`${kind}:appendCustomEntry:${JSON.stringify(data)}`);
		},
		getSessionFile() {
			return sessionFile ?? `/tmp/${kind}/2026-07-12T00-00-00-000Z_019f5262-95f7-7785-bccc-150b1c6295c0.jsonl`;
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
		return {
			session: {
				messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
				sessionManager: options.sessionManager,
				subscribe() {
					return () => undefined;
				},
				async prompt() {},
				async abort() {},
				dispose() {},
			},
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
	openedSessionFiles = [];
	nextChildSessionFile = undefined;
	const { default: subAgentExtension } = await import("../extensions/sub-agent/sub-agent.ts");
	await subAgentExtension({
		on() {},
		registerTool(definition: any) {
			toolDefinitions.push(definition);
		},
		getThinkingLevel: () => undefined,
		getActiveTools: () => [],
	} as never);
	return toolDefinitions.find((tool) => tool.name === "sub_agent");
}

describe("sub_agent agents.ts project catalog", () => {
	test("shallow-merges project agent fields over global agents", async () => {
		lastResourceLoaderOptions = undefined;
		const projectDir = join(tmpdir(), `pi-sub-agent-merge-${Date.now()}`);
		await mkdir(join(projectDir, ".pi"), { recursive: true });
		await writeFile(join(projectDir, ".pi", "agents.ts"), `
export default {
  researcher: {
    description: "Project researcher override"
  }
};
`);

		const originalCwd = process.cwd();
		try {
			process.chdir(projectDir);
			const tool = await loadSubAgentExtension();
			process.chdir(originalCwd);
			expect(tool.description).toContain("researcher: Project researcher override");
			const result = await tool.execute(
				"call-merge-agent",
				{ prompt: "do work", agent: "researcher", project_path: projectDir, run_in_background: false },
				undefined,
				undefined,
				{ cwd: process.cwd(), sessionManager: { getSessionFile: () => undefined } },
			);

			expect(JSON.parse(result.content[0].text)).toEqual({ session_id: expect.any(String), response: "done" });
			const appended = lastResourceLoaderOptions.appendSystemPromptOverride([]).join("\n");
			expect(appended).toContain("You are **researcher**");
		} finally {
			process.chdir(originalCwd);
			await rm(projectDir, { recursive: true, force: true });
		}
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
			const tool = await loadSubAgentExtension();
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
			const tool = await loadSubAgentExtension();
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

		expect(tool.description).toContain("expected benefit outweighs the cost");
		expect(tool.description).toContain("Do not delegate merely because a task exists");
		expect(tool.description).toContain("Use agent=\"fork\" sparingly");
		expect(tool.description).toContain("Fork is not a specialized worker; it is a context-inheritance mode");
		expect(tool.description).toContain("reference_docs and fork are independent optimizations");
		expect(tool.description).toContain("Use existing_session_id only to continue the same child session");
		expect(tool.description).toContain("Do not provide project_path or agent with existing_session_id");
		expect(tool.description).toContain("relative reference_docs paths resolve against that existing session's project path");
		expect(tool.promptGuidelines).toContain("Use sub_agent only when an independently executable child task has clear payoff: parallelism, isolation, specialized behavior, independent review, context preservation, or filtering noisy output.");
		expect(tool.parameters.prompt.description).toContain("for fork or existing_session_id, provide the incremental follow-up task");
		expect(tool.parameters.prompt.optional).toBeUndefined();
		expect(tool.parameters.agent.optional).toBe(true);
		expect(tool.parameters.run_in_background.optional).toBe(true);
		expect(tool.parameters.existing_session_id.optional).toBe(true);
		expect(tool.parameters.project_path.optional).toBe(true);
		expect(tool.parameters.reference_docs.optional).toBe(true);
		expect(tool.parameters.agent.description).toContain("Do not provide agent with existing_session_id");
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
	test('treats agent="fork" as fork mode before named-agent lookup', async () => {
		sessionManagerCalls.length = 0;
		const tool = await loadSubAgentExtension();
		const parentSessionManager = {
			getSessionFile: () => "/tmp/parent.jsonl",
			getSessionDir: () => "/tmp",
			getLeafId: () => "leaf-1",
			getBranch: (leafId: string) => {
				sessionManagerCalls.push(`getBranch:${leafId}`);
				return [{ type: "message", id: "leaf-1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hello", timestamp: 1 } }];
			},
			createBranchedSession: () => {
				throw new Error("createBranchedSession mutates the parent session and must not be used");
			},
		};

		const result = await tool.execute(
			"call-1",
			{ prompt: "do work", agent: "fork", run_in_background: false },
			undefined,
			undefined,
			{ cwd: process.cwd(), sessionManager: parentSessionManager },
		);

		expect(JSON.parse(result.content[0].text)).toEqual({ session_id: expect.any(String), response: "done" });
		expect(sessionManagerCalls).toContain("getBranch:leaf-1");
		expect(sessionManagerCalls.some((call) => call.startsWith("open:/tmp/"))).toBe(true);
		expect(lastSessionManager.kind).toBe("open");
		expect(sessionManagerCalls.some((call) => call.startsWith("create:appendSessionInfo"))).toBe(false);
	});
});
