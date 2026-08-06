import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";

// Maintenance note: entropy-aware allow/truncate design and fixture methodology live in
// ./entropy-aware-limiting-design.md. Read that document before changing long-output
// classification behavior or thresholds.

const MAX_OUTPUT_CHARS = 25_600;
const NORMAL_HEAD_CHARS = 12_800;
const NORMAL_TAIL_CHARS = 3_200;
const ERROR_HEAD_CHARS = 3_200;
const ERROR_TAIL_CHARS = 12_800;
const OUTPUT_ROOT = join(tmpdir(), "pi-tool-output-limiter");
const TEXT_ENCODER = new TextEncoder();

type TextContent = { type: string; text?: string };

type ToolResultEvent = {
	toolName: string;
	toolCallId: string;
	content: TextContent[];
	isError?: boolean;
};

type OutputMetrics = {
	byteEntropy: number;
	gzipRatio: number;
	printableRatio: number;
	replacementRatio: number;
	lineTemplateDupScore: number;
	shapeDupScore: number;
	naturalTextScore: number;
	base64ishRatio: number;
};

type LongOutputDecision =
	| { kind: "allow"; reason: "long_readable_text" }
	| { kind: "truncate"; reason: "binary_or_encoded" | "low_entropy" | "repetitive_machine" | "fallback" };

function cwdHash(cwd: string): string {
	return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

function timestampForFile(date = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function safeFilePart(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

function textFromContent(content: TextContent[]): string {
	return content
		.map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : JSON.stringify(part)))
		.join("\n");
}

function byteEntropy(bytes: Uint8Array): number {
	if (bytes.length === 0) return 0;

	const counts = new Array<number>(256).fill(0);
	for (const byte of bytes) counts[byte]++;

	let entropy = 0;
	for (const count of counts) {
		if (count === 0) continue;
		const probability = count / bytes.length;
		entropy -= probability * Math.log2(probability);
	}
	return entropy;
}

function printableRatio(text: string): number {
	if (text.length === 0) return 1;

	let printable = 0;
	let total = 0;
	for (const char of text) {
		total++;
		const codePoint = char.codePointAt(0) ?? 0;
		if (char === "\n" || char === "\r" || char === "\t" || (codePoint >= 0x20 && codePoint !== 0x7f)) {
			printable++;
		}
	}
	return printable / total;
}

function replacementRatio(text: string): number {
	if (text.length === 0) return 0;
	let replacements = 0;
	let total = 0;
	for (const char of text) {
		total++;
		if (char === "\uFFFD") replacements++;
	}
	return replacements / total;
}

function base64ishRatio(text: string): number {
	const compact = text.replace(/\s+/g, "");
	if (compact.length < 256) return 0;
	let base64ish = 0;
	for (const char of compact) {
		const code = char.charCodeAt(0);
		if (
			(code >= 65 && code <= 90) ||
			(code >= 97 && code <= 122) ||
			(code >= 48 && code <= 57) ||
			char === "+" ||
			char === "/" ||
			char === "=" ||
			char === "_" ||
			char === "-"
		) {
			base64ish++;
		}
	}
	return base64ish / compact.length;
}

function normalizeTemplateLine(line: string): string {
	return line
		.slice(0, 1_000)
		.replace(/\b\d{4}-\d{2}-\d{2}\b/g, "<date>")
		.replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "<time>")
		.replace(/\b0x[0-9a-fA-F]+\b/g, "<hex>")
		.replace(/\b[0-9a-fA-F]{8,}\b/g, "<hex>")
		.replace(/\b\d+\b/g, "<num>")
		.replace(/\S*\/\S*/g, "<path>")
		.replace(/\s+/g, " ")
		.trim();
}

function shapeLine(line: string): string {
	return line
		.slice(0, 1_000)
		.replace(/[A-Za-z]+/g, "a")
		.replace(/[0-9]+/g, "0")
		.replace(/[a-fA-F0-9]{8,}/g, "x")
		.replace(/\s+/g, " ")
		.trim();
}

function duplicateScore(lines: string[]): number {
	if (lines.length < 10) return 0;

	const counts = new Map<string, number>();
	for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);

	let repeated = 0;
	for (const count of counts.values()) {
		if (count > 1) repeated += count;
	}
	return repeated / lines.length;
}

function sampledLines(text: string): string[] {
	const lines: string[] = [];
	for (const line of text.split(/\r?\n/, 5_000)) {
		if (line.length >= 20 && line.length <= 1_000) lines.push(line);
	}
	return lines;
}

function lineTemplateDupScore(lines: string[]): number {
	return duplicateScore(lines.map(normalizeTemplateLine).filter((line) => line.length >= 20));
}

function shapeDupScore(lines: string[]): number {
	return duplicateScore(lines.map(shapeLine).filter((line) => line.length >= 10));
}

function naturalTextScore(lines: string[]): number {
	if (lines.length === 0) return 0;

	let proseLike = 0;
	let codeLike = 0;
	for (const line of lines) {
		const letters = line.match(/[A-Za-z]/g)?.length ?? 0;
		const spaces = line.match(/\s/g)?.length ?? 0;
		const punctuation = line.match(/[.,;:!?`'"(){}[\]<>]/g)?.length ?? 0;
		const pathOrMachineTokens = line.match(/[=/\\]|\b(?:WARN|ERROR|INFO|DEBUG|TRACE)\b|\b\d+(?:\.\d+)?\s*(?:kB|MB|GB|ms|s)\b/g)?.length ?? 0;
		const letterRatio = letters / Math.max(1, line.length);
		const spaceRatio = spaces / Math.max(1, line.length);

		if (letterRatio >= 0.45 && spaceRatio >= 0.10 && pathOrMachineTokens <= 2) proseLike++;
		if (letterRatio >= 0.25 && punctuation >= 2 && pathOrMachineTokens <= 3) codeLike++;
	}

	return Math.max(proseLike / lines.length, codeLike / lines.length);
}

function analyzeOutput(text: string): OutputMetrics {
	const bytes = TEXT_ENCODER.encode(text);
	const lines = sampledLines(text);
	return {
		byteEntropy: byteEntropy(bytes),
		gzipRatio: gzipSync(bytes).length / Math.max(1, bytes.length),
		printableRatio: printableRatio(text),
		replacementRatio: replacementRatio(text),
		lineTemplateDupScore: lineTemplateDupScore(lines),
		shapeDupScore: shapeDupScore(lines),
		naturalTextScore: naturalTextScore(lines),
		base64ishRatio: base64ishRatio(text),
	};
}

function classifyLongOutput(text: string, options: { isError: boolean }): LongOutputDecision {
	const metrics = analyzeOutput(text);

	const binaryOrEncoded =
		metrics.printableRatio < 0.92 ||
		metrics.replacementRatio > 0.02 ||
		metrics.byteEntropy > 7.2 ||
		(metrics.byteEntropy > 5.85 && metrics.gzipRatio > 0.55 && metrics.lineTemplateDupScore < 0.2) ||
		(metrics.base64ishRatio > 0.95 && metrics.gzipRatio > 0.5);
	if (binaryOrEncoded) return { kind: "truncate", reason: "binary_or_encoded" };

	const lowEntropy = metrics.byteEntropy < 2.0 || metrics.gzipRatio < 0.01;
	if (lowEntropy) return { kind: "truncate", reason: "low_entropy" };

	const repetitiveMachine =
		metrics.gzipRatio < 0.25 &&
		(metrics.lineTemplateDupScore > 0.8 || metrics.shapeDupScore > 0.8) &&
		metrics.naturalTextScore < 0.55;
	if (repetitiveMachine) return { kind: "truncate", reason: "repetitive_machine" };

	const longReadableText =
		!options.isError &&
		metrics.printableRatio >= 0.98 &&
		metrics.replacementRatio <= 0.001 &&
		metrics.byteEntropy >= 3.2 &&
		metrics.byteEntropy <= 5.7 &&
		metrics.gzipRatio >= 0.2 &&
		metrics.naturalTextScore >= 0.55 &&
		metrics.shapeDupScore < 0.8;
	if (longReadableText) return { kind: "allow", reason: "long_readable_text" };

	return { kind: "truncate", reason: "fallback" };
}

function makePreview(original: string, isError: boolean): { previewText: string; previewPolicy: string; omittedLength: number } {
	const headLength = isError ? ERROR_HEAD_CHARS : NORMAL_HEAD_CHARS;
	const tailLength = isError ? ERROR_TAIL_CHARS : NORMAL_TAIL_CHARS;
	const head = original.slice(0, headLength);
	const tail = original.slice(-tailLength);
	const omittedLength = original.length - head.length - tail.length;
	const previewPolicy = isError
		? "This was an error result. Kept the first 3200 characters and the last 12800 characters, because the end of error output often contains the most useful failure details."
		: "Kept the first 12800 characters and the last 3200 characters.";

	return {
		previewPolicy,
		omittedLength,
		previewText: `----- BEGIN KEPT START -----\n${head}\n----- END KEPT START -----\n\n----- OMITTED ${omittedLength} CHARACTERS -----\n\n----- BEGIN KEPT END -----\n${tail}\n----- END KEPT END -----`,
	};
}

function buildLimitedMessage(options: {
	filePath: string;
	toolName: string;
	toolCallId: string;
	originalLength: number;
	previewPolicy: string;
	previewText: string;
}): string {
	return `Tool output was too long, so pi saved the full original output to a temporary file and returned a shortened preview here.

Full output file:
${options.filePath}

Tool:
${options.toolName}

Tool call id:
${options.toolCallId}

Original output length:
${options.originalLength} characters

Preview policy:
${options.previewPolicy}

Important:
The preview below is incomplete. Do not assume omitted content is irrelevant. If you need facts, errors, paths, IDs, logs, code, or search results that may be in the omitted part, create a fresh sub-agent and ask it to inspect the saved file directly. Tell the sub-agent exactly what information to extract from the file.

Shortened preview:
${options.previewText}`;
}

export default function toolOutputLimiter(pi: ExtensionAPI) {
	pi.on("tool_result", async (event: ToolResultEvent, ctx: { cwd: string }) => {
		const original = textFromContent(event.content);
		if (original.length <= MAX_OUTPUT_CHARS) return;

		const decision = classifyLongOutput(original, { isError: Boolean(event.isError) });
		if (decision.kind === "allow") return;

		const dir = join(OUTPUT_ROOT, cwdHash(ctx.cwd));
		await mkdir(dir, { recursive: true });

		const filePath = join(
			dir,
			`${timestampForFile()}-${safeFilePart(event.toolName)}-${safeFilePart(event.toolCallId)}.txt`,
		);
		await writeFile(filePath, original, "utf8");

		const { previewText, previewPolicy } = makePreview(original, Boolean(event.isError));
		return {
			content: [
				{
					type: "text",
					text: buildLimitedMessage({
						filePath,
						toolName: event.toolName,
						toolCallId: event.toolCallId,
						originalLength: original.length,
						previewPolicy,
						previewText,
					}),
				},
			],
		};
	});
}
