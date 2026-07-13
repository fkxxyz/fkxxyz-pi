import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface BuildSystemPromptOptions {
	customPrompt?: string;
	selectedTools?: string[];
	toolSnippets?: Record<string, string>;
	promptGuidelines?: string[];
	appendSystemPrompt?: string;
	cwd: string;
	contextFiles?: Array<{ path: string; content: string }>;
	skills?: unknown[];
}

interface PrivateSystemPromptModule {
	buildSystemPrompt(options: BuildSystemPromptOptions): string;
}

interface PiPublicModule {
	getPackageDir(): string;
}

const GENERATED_SKILL_DIRECTORY = fileURLToPath(
	new URL("./generated/pi-framework-knowledge", import.meta.url),
);
const GENERATED_SKILL_PATH = join(GENERATED_SKILL_DIRECTORY, "SKILL.md");
const PACKAGE_DIRECTORY_OVERRIDE_ENV = "PI_FRAMEWORK_KNOWLEDGE_PACKAGE_DIR";

const SKILL_FRONTMATTER = `---
name: pi-framework-knowledge
description: Pi framework-level development knowledge from the installed Pi version. Use when developing Pi itself, its SDK, extensions, skills, themes, TUI, providers, models, prompt templates, or packages, especially when a custom system prompt has replaced Pi's default framework guidance.
---

`;

async function importPrivateSystemPromptModule(): Promise<PrivateSystemPromptModule> {
	/**
	 * Compatibility warning:
	 *
	 * This extension intentionally imports Pi's private build artifact through an
	 * absolute file URL. buildSystemPrompt() is not part of Pi's public package
	 * exports. Its path, export name, option shape, or availability may change in
	 * future Pi releases. Bundled or repackaged Pi builds may omit this file.
	 *
	 * Keeping this dependency explicit is preferable to copying the default prompt:
	 * the generated skill then follows the installed Pi version automatically.
	 */
	let packageDirectory = process.env[PACKAGE_DIRECTORY_OVERRIDE_ENV];

	if (!packageDirectory) {
		const pi = (await import(
			"@earendil-works/pi-coding-agent"
		)) as Partial<PiPublicModule>;

		if (typeof pi.getPackageDir !== "function") {
			throw new Error("Pi's public module does not export getPackageDir()");
		}

		packageDirectory = pi.getPackageDir();
	}

	const modulePath = join(packageDirectory, "dist/core/system-prompt.js");

	try {
		const module = (await import(
			pathToFileURL(modulePath).href
		)) as Partial<PrivateSystemPromptModule>;

		if (typeof module.buildSystemPrompt !== "function") {
			throw new Error("private module does not export buildSystemPrompt()");
		}

		return module as PrivateSystemPromptModule;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Cannot generate pi-framework-knowledge skill from Pi's private system prompt module at ${modulePath}: ${message}`,
		);
	}
}

async function writeGeneratedSkill(content: string): Promise<void> {
	await mkdir(GENERATED_SKILL_DIRECTORY, { recursive: true });

	try {
		if ((await readFile(GENERATED_SKILL_PATH, "utf8")) === content) return;
	} catch {
		// Missing or unreadable output is replaced below.
	}

	const temporaryPath = `${GENERATED_SKILL_PATH}.${process.pid}.tmp`;
	await writeFile(temporaryPath, content, "utf8");
	await rename(temporaryPath, GENERATED_SKILL_PATH);
}

export default async function loadPiFrameworkKnowledge(pi: ExtensionAPI) {
	const { buildSystemPrompt } = await importPrivateSystemPromptModule();
	const defaultSystemPrompt = buildSystemPrompt({ cwd: process.cwd() });

	await writeGeneratedSkill(`${SKILL_FRONTMATTER}${defaultSystemPrompt}\n`);

	pi.on("resources_discover", async () => ({
		skillPaths: [GENERATED_SKILL_DIRECTORY],
	}));
}
