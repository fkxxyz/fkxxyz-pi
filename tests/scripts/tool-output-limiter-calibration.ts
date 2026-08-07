import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(process.cwd(), "tests/generated/tool-output-limiter-samples");
const encoder = new TextEncoder();

function writeSample(name: string, content: string | Uint8Array) {
	writeFileSync(join(root, name), content);
}

function maybeRead(path: string, maxBytes?: number): Uint8Array | undefined {
	if (!existsSync(path)) return undefined;
	const content = readFileSync(path);
	return maxBytes ? content.subarray(0, maxBytes) : content;
}

function byteEntropy(bytes: Uint8Array): number {
	if (bytes.length === 0) return 0;
	const counts = new Array<number>(256).fill(0);
	for (const byte of bytes) counts[byte]++;
	let entropy = 0;
	for (const count of counts) {
		if (!count) continue;
		const probability = count / bytes.length;
		entropy -= probability * Math.log2(probability);
	}
	return entropy;
}

function printableRatio(text: string): number {
	if (!text.length) return 1;
	let printable = 0;
	let total = 0;
	for (const char of text) {
		total++;
		const codePoint = char.codePointAt(0) ?? 0;
		if (char === "\n" || char === "\r" || char === "\t" || (codePoint >= 0x20 && codePoint !== 0x7f)) printable++;
	}
	return printable / total;
}

function replacementRatio(text: string): number {
	if (!text.length) return 0;
	let replacements = 0;
	let total = 0;
	for (const char of text) {
		total++;
		if (char === "\uFFFD") replacements++;
	}
	return replacements / total;
}

function emitMetrics(name: string, bytes: Uint8Array) {
	const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
	const gzipRatio = gzipSync(bytes).length / Math.max(1, bytes.length);
	console.log([
		name,
		bytes.length,
		byteEntropy(bytes).toFixed(3),
		gzipRatio.toFixed(3),
		printableRatio(text).toFixed(3),
		replacementRatio(text).toFixed(3),
	].join("\t"));
}

mkdirSync(root, { recursive: true });

const docs = [
	"/home/fkxxyz/pi/skills/thinking-methodology/SKILL.md",
	"/home/fkxxyz/pi/skills/thinking-methodology/risk-controls/inspection.md",
	"/home/fkxxyz/pi/skills/prompt-best-practices/prompt-best-practices.md",
]
	.map((path) => maybeRead(path))
	.filter((content): content is Uint8Array => Boolean(content));

if (docs.length) writeSample("allow_real_docs.md", Buffer.concat(docs));
const source = maybeRead("/home/fkxxyz/pi/extensions/code/tools/lsp-tools.ts", 120_000);
if (source) writeSample("allow_real_source.ts", source);
const pacmanLog = maybeRead("/var/log/pacman.log");
if (pacmanLog) writeSample("truncate_real_pacman.log", pacmanLog);
const wtmp = maybeRead("/var/log/wtmp", 80_000);
if (wtmp) writeSample("truncate_real_wtmp.bin", wtmp);

writeSample("truncate_find_listing.txt", encoder.encode(Array.from({ length: 4000 }, (_, index) => `/repo/node_modules/pkg-${index}/dist/file-${index}.js`).join("\n")));
writeSample("truncate_repeated_log.txt", encoder.encode(Array.from({ length: 1200 }, (_, index) => `2026-08-06 WARN retry path=/repo/src/module${index % 17}.ts code=${index}`).join("\n")));
writeSample("truncate_random_base64.txt", Buffer.from(randomBytes(80_000).toString("base64")));
writeSample("truncate_random_bytes.bin", randomBytes(80_000));

console.log("sample\tbytes\tbyteEntropy\tgzipRatio\tprintableRatio\treplacementRatio");
for (const name of [
	"allow_real_docs.md",
	"allow_real_source.ts",
	"truncate_real_pacman.log",
	"truncate_real_wtmp.bin",
	"truncate_find_listing.txt",
	"truncate_repeated_log.txt",
	"truncate_random_base64.txt",
	"truncate_random_bytes.bin",
]) {
	const path = join(root, name);
	if (existsSync(path)) emitMetrics(name, readFileSync(path));
}

console.error(`\nGenerated calibration samples under ${root}`);
