import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

describe("systematic debugging skill discovery extension", () => {
	test("discovers systematic debugging skill", async () => {
		const handlers: Array<() => Promise<{ skillPaths?: string[] }>> = [];
		const { default: systematicDebugging } = await import(
			"../extensions/code/methodology/systematic-debugging.ts"
		);

		systematicDebugging({
			on(eventName: string, handler: () => Promise<{ skillPaths?: string[] }>) {
				if (eventName === "resources_discover") handlers.push(handler);
			},
		} as never);

		expect(handlers).toHaveLength(1);
		const result = await handlers[0]!();
		const skillPaths = result.skillPaths ?? [];

		expect(skillPaths).toEqual([resolve("skills/superpowers/systematic-debugging")]);
		expect(skillPaths.every((path) => existsSync(path))).toBe(true);
	});
});
