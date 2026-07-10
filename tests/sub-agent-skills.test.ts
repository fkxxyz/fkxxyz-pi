import { describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

mock.module("@earendil-works/pi-coding-agent", () => ({
	createAgentSession: async () => ({ session: {} }),
	DefaultResourceLoader: class {
		async reload() {}
	},
	getAgentDir: () => "/tmp/pi-agent-dir",
	initTheme: () => undefined,
	SessionManager: {
		create: () => ({
			appendSessionInfo() {},
			appendCustomEntry() {},
		}),
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
