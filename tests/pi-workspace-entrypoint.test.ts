import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

describe("pi workspace entrypoint", () => {
	test("loads tool output limiter despite disabled global preset", async () => {
		const source = await readFile(resolve("extensions/entrypoints/pi-workspace.ts"), "utf8");

		expect(source).toContain('await load("../tool-output/tool-output-limiter.ts");');
	});

	test("loads auto session naming for this maintenance workspace", async () => {
		const source = await readFile(resolve("extensions/entrypoints/pi-workspace.ts"), "utf8");

		expect(source).toContain('await load("../session/auto-session-name.ts");');
	});
});
