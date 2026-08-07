import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

type ReadToolParams = {
	path: string;
	offset?: number;
	limit?: number;
};

type RegisteredTool = {
	name: string;
	description: string;
	execute: (
		toolCallId: string,
		params: ReadToolParams,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: { cwd: string },
	) => Promise<{ content: Array<{ type: string; text?: string }>; details?: Record<string, unknown> }>;
};

let cwd: string;
let tool: RegisteredTool;

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "pi-numbered-read-test-"));
	let registered: RegisteredTool | undefined;
	mock.module("typebox", () => ({
		Type: {
			Object: (schema: unknown) => schema,
			String: (schema: unknown) => schema,
			Number: (schema: unknown) => schema,
			Optional: (schema: unknown) => schema,
		},
	}));
	const { default: numberedReadExtension } = await import("../extensions/code/tools/read-with-line-numbers.ts");
	numberedReadExtension({
		registerTool(definition: RegisteredTool) {
			registered = definition;
		},
	} as never);
	if (!registered) throw new Error("read tool was not registered");
	tool = registered;
});

afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

async function readText(params: ReadToolParams) {
	const result = await tool.execute("test-call", params, undefined, undefined, { cwd });
	return result.content[0].text ?? "";
}

describe("read-with-line-numbers tool policy", () => {
	test("overrides read and prefixes text file lines with 1-based line numbers", async () => {
		await writeFile(join(cwd, "sample.txt"), "alpha\nbeta\ngamma\n");

		const text = await readText({ path: "sample.txt" });

		expect(tool.name).toBe("read");
		expect(text).toBe("1: alpha\n2: beta\n3: gamma\n4: ");
	});

	test("uses offset as first displayed line number", async () => {
		await writeFile(join(cwd, "sample.txt"), "alpha\nbeta\ngamma\ndelta\n");

		const text = await readText({ path: "sample.txt", offset: 2, limit: 2 });

		expect(text).toBe("2: beta\n3: gamma\n\n[2 more lines in file. Use offset=4 to continue.]");
	});

	test("rejects offset beyond end of file", async () => {
		await writeFile(join(cwd, "sample.txt"), "alpha\nbeta\n");

		await expect(readText({ path: "sample.txt", offset: 10 })).rejects.toThrow(
			"Offset 10 is beyond end of file (3 lines total)",
		);
	});

	test("code extension loads the read override but default preset does not", async () => {
		const codeSource = await readFile(resolve("extensions/code/tools/tools.ts"), "utf8");
		const defaultPreset = await readFile(resolve("extensions/entrypoints/default-preset.json"), "utf8");

		expect(codeSource).toContain('await load("./read-with-line-numbers.ts");');
		expect(defaultPreset).not.toContain("read-with-line-numbers.ts");
	});
});
