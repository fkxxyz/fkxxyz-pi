import { describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const sessionManagerCalls: string[] = [];
let createdSessionManager: any;
let toolDefinitions: any[] = [];
let lastSessionManager: any;

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
		Array: (schema: unknown) => schema,
		Boolean: (schema: unknown) => schema,
		Object: (schema: unknown) => schema,
		Optional: (schema: unknown) => schema,
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
