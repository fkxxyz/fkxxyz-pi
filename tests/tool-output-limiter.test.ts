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

function repeatToLength(seed: string, length: number): string {
	let output = "";
	while (output.length < length) output += seed;
	return output.slice(0, length);
}

function repeatedMachineLog(length: number): string {
	let output = "";
	for (let index = 0; output.length < length; index++) {
		output += `2026-08-06 14:${String(index % 60).padStart(2, "0")}:${String((index * 7) % 60).padStart(2, "0")}.123 WARN builder retrying unchanged task package=app shard=${index % 17} file=/repo/src/module${index % 13}.ts\n`;
	}
	return output.slice(0, length);
}

function encodedHighEntropy(length: number): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let output = "";
	for (let index = 0; output.length < length; index++) {
		output += alphabet[(index * 37 + index * index * 17) % alphabet.length];
	}
	return output.slice(0, length);
}

function lossyBinaryText(length: number): string {
	return repeatToLength("\uFFFD\u0000\u0001\u0002binary-fragment-", length);
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

	test("allows existing readable long documentation instead of truncating it", async () => {
		const original = [
			await readFile(resolve("AGENTS.md"), "utf8"),
			await readFile(resolve("extensions/tool-output/entropy-aware-limiting-design.md"), "utf8"),
		].join("\n\n");
		const result = await runLimiter({
			toolName: "read",
			toolCallId: "call_readable_doc",
			content: [{ type: "text", text: original }],
			isError: false,
		});

		expect(original.length).toBeGreaterThan(25_600);
		expect(result).toBeUndefined();
	});

	test("continues truncating compact synthetic noise classes", async () => {
		const samples = [
			{ name: "low entropy", text: "A".repeat(30_000) },
			{ name: "repeated machine log", text: repeatedMachineLog(30_000) },
			{ name: "encoded high entropy", text: encodedHighEntropy(30_000) },
			{ name: "lossy binary text", text: lossyBinaryText(30_000) },
		];

		for (const sample of samples) {
			const result = await runLimiter({
				toolName: "bash",
				toolCallId: `call_${sample.name}`,
				content: [{ type: "text", text: sample.text }],
				isError: false,
			});

			expect(result?.content?.[0]?.text, sample.name).toContain("Tool output was too long");
		}
	});
});
