import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

function lineNumberWidth(startLine: number, lineCount: number): number {
	return String(startLine + Math.max(0, lineCount - 1)).length;
}

function addLineNumbers(lines: string[], startLine: number): string {
	const width = lineNumberWidth(startLine, lines.length);
	return lines.map((line, index) => `${String(startLine + index).padStart(width, " ")}: ${line}`).join("\n");
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function truncateNumberedLines(lines: string[], startLine: number, maxLines: number, maxBytes: number) {
	const selected: string[] = [];
	let outputLines = 0;

	for (const line of lines) {
		if (outputLines >= maxLines) break;

		const candidate = addLineNumbers([...selected, line], startLine);
		if (byteLength(candidate) > maxBytes) {
			if (selected.length === 0) {
				return {
					content: `[Line ${startLine} exceeds ${Math.floor(maxBytes / 1024)}KB limit after adding line numbers.]`,
					outputLines: 0,
					truncated: true,
					firstLineExceedsLimit: true,
				};
			}
			break;
		}

		selected.push(line);
		outputLines++;
	}

	return {
		content: addLineNumbers(selected, startLine),
		outputLines,
		truncated: outputLines < lines.length,
		firstLineExceedsLimit: false,
	};
}

export default function readWithLineNumbers(pi: ExtensionAPI) {
	pi.registerTool({
		name: "read",
		label: "read (line-numbered)",
		description:
			"Read the contents of a file. Text output is prefixed with 1-based line numbers. Supports offset/limit for large files. Output is truncated to 2000 lines or 50KB (whichever is hit first).",
		parameters: readSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const absolutePath = resolve(ctx.cwd, params.path);
			await access(absolutePath, constants.R_OK);

			const content = await readFile(absolutePath, "utf8");
			const allLines = content.split("\n");
			const startLineIndex = params.offset ? Math.max(0, params.offset - 1) : 0;
			const startLineDisplay = startLineIndex + 1;

			if (startLineIndex >= allLines.length) {
				throw new Error(`Offset ${params.offset} is beyond end of file (${allLines.length} lines total)`);
			}

			const requestedEnd = params.limit === undefined ? allLines.length : Math.min(startLineIndex + params.limit, allLines.length);
			const requestedLines = allLines.slice(startLineIndex, requestedEnd);
			const maxLines = params.limit === undefined ? MAX_LINES : Math.min(params.limit, MAX_LINES);
			const truncated = truncateNumberedLines(requestedLines, startLineDisplay, maxLines, MAX_BYTES);

			let outputText = truncated.content;
			const shownEndLine = startLineDisplay + Math.max(0, truncated.outputLines - 1);
			const stoppedAtLineIndex = startLineIndex + truncated.outputLines;

			if (truncated.truncated && !truncated.firstLineExceedsLimit) {
				const nextOffset = stoppedAtLineIndex + 1;
				outputText += `\n\n[Showing lines ${startLineDisplay}-${shownEndLine} of ${allLines.length}. Use offset=${nextOffset} to continue.]`;
			} else if (params.limit !== undefined && requestedEnd < allLines.length) {
				const remaining = allLines.length - requestedEnd;
				const nextOffset = requestedEnd + 1;
				outputText += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
			}

			return {
				content: [{ type: "text", text: outputText }] as TextContent[],
				details: {
					lines: allLines.length,
					lineNumbers: true,
					truncated: truncated.truncated,
				},
			};
		},
	});
}
