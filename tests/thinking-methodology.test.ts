import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

describe("thinking methodology extension", () => {
	test("discovers the thinking-methodology skill path", async () => {
		const handlers: Record<string, () => Promise<{ skillPaths?: string[] }>> = {};
		const { default: loadThinkingMethodologySkill } = await import("../extensions/skills/thinking-methodology.ts");

		loadThinkingMethodologySkill({
			on(event: string, handler: () => Promise<{ skillPaths?: string[] }>) {
				handlers[event] = handler;
			},
		} as never);

		const result = await handlers.resources_discover();

		expect(result.skillPaths).toEqual([resolve("skills/thinking-methodology")]);
	});

	test("global preset loads thinking methodology", async () => {
		const preset = JSON.parse(await readFile(resolve("extensions/entrypoints/default-preset.json"), "utf8"));

		expect(preset.extensions).toContain("../skills/thinking-methodology.ts");
	});

	test("pi workspace entrypoint loads thinking methodology", async () => {
		const source = await readFile(resolve("extensions/entrypoints/pi-workspace.ts"), "utf8");

		expect(source).toContain('await load("../skills/thinking-methodology.ts");');
	});
});
