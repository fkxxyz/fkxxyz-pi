import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

describe("frontend development skill discovery extension", () => {
	test("discovers frontend development skills", async () => {
		const handlers: Array<() => Promise<{ skillPaths?: string[] }>> = [];
		const { default: frontendDevelopment } = await import(
			"../extensions/code/frontend-development.ts"
		);

		frontendDevelopment({
			on(eventName: string, handler: () => Promise<{ skillPaths?: string[] }>) {
				if (eventName === "resources_discover") handlers.push(handler);
			},
		} as never);

		expect(handlers).toHaveLength(1);
		const result = await handlers[0]!();
		const skillPaths = result.skillPaths ?? [];

		expect(skillPaths).toEqual([
			resolve("skills/agent-browser"),
			resolve("skills/flutter-ui-debugging"),
			resolve("skills/ui-ux-pro-max"),
		]);
		expect(skillPaths.every((path) => existsSync(path))).toBe(true);
	});

	test("code extension loads frontend development skill discovery", async () => {
		const source = await readFile(resolve("extensions/code/code.ts"), "utf8");

		expect(source).toContain('await load("./frontend-development.ts");');
	});
});
