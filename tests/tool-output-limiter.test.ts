import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { readFile as readFileSync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

type ToolResultEvent = {
	toolName: string;
	toolCallId: string;
	input?: unknown;
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
};

type ToolResultPatch = {
	content?: Array<{ type: string; text?: string }>;
};

const tempRoot = `${tmpdir()}/pi-tool-output-limiter`;
let handler: ((event: ToolResultEvent, ctx: { cwd: string }) => Promise<ToolResultPatch | undefined>) | undefined;

beforeEach(async () => {
	await rm(tempRoot, { recursive: true, force: true });
	handler = undefined;
	const { default: toolOutputLimiter } = await import("../extensions/tool-output/tool-output-limiter.ts");
	toolOutputLimiter({
		on(eventName: string, registeredHandler: typeof handler) {
			if (eventName === "tool_result") handler = registeredHandler;
		},
	} as never);
});

afterEach(async () => {
	await rm(tempRoot, { recursive: true, force: true });
});

async function runLimiter(event: ToolResultEvent) {
	if (!handler) throw new Error("tool_result handler was not registered");
	return handler(event, { cwd: "/workspace/project" });
}

function longText(length: number) {
	return "A".repeat(length / 3) + "B".repeat(length / 3) + "C".repeat(length - 2 * Math.floor(length / 3));
}

function extractPath(text: string) {
	const match = text.match(/Full output file:\n(.+)\n\nTool:/);
	if (!match) throw new Error(`Could not extract output path from:\n${text}`);
	return match[1]!;
}

describe("tool output limiter", () => {
	test("leaves short tool output unchanged", async () => {
		const result = await runLimiter({
			toolName: "bash",
			toolCallId: "call_short",
			content: [{ type: "text", text: "short output" }],
		});

		expect(result).toBeUndefined();
		expect(existsSync(tempRoot)).toBe(false);
	});

	test("saves long non-error output and returns natural language preview with head prioritized", async () => {
		const original = longText(30000);
		const result = await runLimiter({
			toolName: "bash",
			toolCallId: "call_abc123",
			content: [{ type: "text", text: original }],
			isError: false,
		});

		const preview = result?.content?.[0]?.text ?? "";
		const filePath = extractPath(preview);
		expect(filePath).toMatch(/^\/tmp\/pi-tool-output-limiter\/[a-f0-9]{16}\/\d{8}-\d{6}-bash-call_abc123\.txt$/);
		expect(await readFile(filePath, "utf8")).toBe(original);
		expect(preview).toContain("Tool output was too long, so pi saved the full original output to a temporary file");
		expect(preview).toContain("Original output length:\n30000 characters");
		expect(preview).toContain("Kept the first 12800 characters and the last 3200 characters.");
		expect(preview).toContain("create a fresh sub-agent and ask it to inspect the saved file directly");
		expect(preview).toContain("----- OMITTED 14000 CHARACTERS -----");
		expect(preview).toContain(original.slice(0, 12800));
		expect(preview).toContain(original.slice(-3200));
	});

	test("prioritizes tail for long error output", async () => {
		const original = longText(30000);
		const result = await runLimiter({
			toolName: "bash",
			toolCallId: "call_error",
			content: [{ type: "text", text: original }],
			isError: true,
		});

		const preview = result?.content?.[0]?.text ?? "";
		expect(await readFile(extractPath(preview), "utf8")).toBe(original);
		expect(preview).toContain(
			"This was an error result. Kept the first 3200 characters and the last 12800 characters",
		);
		expect(preview).toContain("----- OMITTED 14000 CHARACTERS -----");
		expect(preview).toContain(original.slice(0, 3200));
		expect(preview).toContain(original.slice(-12800));
	});

	test("default preset loads the tool output limiter globally", async () => {
		const defaultPreset = await readFileSync(resolve("extensions/entrypoints/default-preset.json"), "utf8");

		expect(defaultPreset).toContain("../tool-output/tool-output-limiter.ts");
	});
});
