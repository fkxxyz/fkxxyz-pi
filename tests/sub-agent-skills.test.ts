import { describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const sessionManagerCalls: string[] = [];
let createdSessionManager: any;
let toolDefinitions: any[] = [];
let lastSessionManager: any;
let lastResourceLoaderOptions: any;
let lastCreateAgentSessionOptions: any;

function makeChildSessionManager(kind: string) {
	return {
		kind,
		appendSessionInfo() {
			sessionManagerCalls.push(`${kind}:appendSessionInfo`);
		},
		appendCustomEntry(_type: string, data: unknown) {
			sessionManagerCalls.push(`${kind}:appendCustomEntry:${JSON.stringify(data)}`);
		},
		getSessionFile() {
			return `/tmp/${kind}.jsonl`;
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
			createdSessionManager = makeChildSessionManager("create");
			return createdSessionManager;
		},
		open: (path: string) => {
			sessionManagerCalls.push(`open:${path}`);
			return makeChildSessionManager("open");
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
		const globalAgentsPath = resolve("agents.ts");
		const originalGlobal = existsSync(globalAgentsPath) ? readFileSync(globalAgentsPath, "utf8") : null;
		const projectDir = join(tmpdir(), `pi-sub-agent-merge-${Date.now()}`);
		await mkdir(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(globalAgentsPath, `
export default {
  helper: {
    description: "Global helper",
    systemPrompt: "global prompt"
  }
};
`);
		await writeFile(join(projectDir, ".pi", "agents.ts"), `
export default {
  helper: {
    description: "Project helper"
  }
};
`);

		const originalCwd = process.cwd();
		try {
			process.chdir(projectDir);
			const tool = await loadSubAgentExtension();
			process.chdir(originalCwd);
			expect(tool.description).toContain("helper: Project helper");
			const result = await tool.execute(
				"call-merge-agent",
				{ prompt: "do work", agent: "helper", project_path: projectDir, run_in_background: false },
				undefined,
				undefined,
				{ cwd: process.cwd(), sessionManager: { getSessionFile: () => undefined } },
			);

			expect(JSON.parse(result.content[0].text)).toEqual({ session_id: expect.any(String), response: "done" });
			const appended = lastResourceLoaderOptions.appendSystemPromptOverride([]).join("\n");
			expect(appended).toContain("global prompt");
		} finally {
			process.chdir(originalCwd);
			if (originalGlobal === null) rmSync(globalAgentsPath, { force: true });
			else writeFileSync(globalAgentsPath, originalGlobal);
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
		expect(tool.description).toContain("Use existing_session_id only to continue the same live child session");
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
		expect(tool.parameters.existing_session_id.description).toContain("Mutually exclusive with project_path and agent");
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
});

describe("sub-agent skill discovery", () => {
	test("discovers subagent skills", async () => {
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

		expect(handlers).toHaveLength(1);
		const result = await handlers[0]!();
		const skillPaths = result.skillPaths ?? [];

		expect(skillPaths).toEqual([
			resolve("skills/subagent-delegation-verification"),
			resolve("skills/subagent-prompt-simplification"),
			resolve("skills/superpowers/subagent-driven-development"),
		]);
		expect(skillPaths.every((path) => existsSync(path))).toBe(true);
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
