import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MAX_OUTPUT_CHARS = 25_600;
const NORMAL_HEAD_CHARS = 12_800;
const NORMAL_TAIL_CHARS = 3_200;
const ERROR_HEAD_CHARS = 3_200;
const ERROR_TAIL_CHARS = 12_800;
const OUTPUT_ROOT = join(tmpdir(), "pi-tool-output-limiter");

type TextContent = { type: string; text?: string };

type ToolResultEvent = {
	toolName: string;
	toolCallId: string;
	content: TextContent[];
	isError?: boolean;
};

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
