import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

describe("pi framework knowledge extension", () => {
	test("generates and discovers a skill containing Pi's default system prompt", async () => {
		const handlers: Record<string, (event: { cwd: string }) => Promise<{ skillPaths?: string[] }>> = {};
		const previousPackageDirectory = process.env.PI_FRAMEWORK_KNOWLEDGE_PACKAGE_DIR;
		process.env.PI_FRAMEWORK_KNOWLEDGE_PACKAGE_DIR = resolve(
			"tests/fixtures/pi-coding-agent",
		);
		const { default: loadPiFrameworkKnowledge } = await import(
			"../extensions/pi-framework/pi-framework-knowledge.ts"
		);

		try {
			await loadPiFrameworkKnowledge({
				on(event: string, handler: (event: { cwd: string }) => Promise<{ skillPaths?: string[] }>) {
					handlers[event] = handler;
				},
			} as never);
		} finally {
			if (previousPackageDirectory === undefined) {
				delete process.env.PI_FRAMEWORK_KNOWLEDGE_PACKAGE_DIR;
			} else {
				process.env.PI_FRAMEWORK_KNOWLEDGE_PACKAGE_DIR = previousPackageDirectory;
			}
		}

		const result = await handlers.resources_discover({ cwd: resolve("tests/fixtures/example-project") });
		const skillDirectory = resolve(
			"extensions/pi-framework/generated/pi-framework-knowledge",
		);
		const skillPath = resolve(skillDirectory, "SKILL.md");

		expect(result.skillPaths).toEqual([skillDirectory]);
		expect(existsSync(skillPath)).toBe(true);

		const skill = await readFile(skillPath, "utf8");
		expect(skill).toContain("name: pi-framework-knowledge");
		const body = skill.slice(skill.indexOf("---\n", 4) + 4).trimStart();
		expect(body).toStartWith("You are an expert coding assistant operating inside pi");
		expect(skill).toContain("Pi documentation (read only when the user asks about pi itself");
	});

	test("keeps generated skill output out of git", async () => {
		const gitignore = await readFile(resolve(".gitignore"), "utf8");

		expect(gitignore).toContain("/extensions/pi-framework/generated/");
	});

	test("loads the extension from the default preset", async () => {
		const preset = JSON.parse(
			await readFile(resolve("extensions/entrypoints/default-preset.json"), "utf8"),
		);

		expect(preset.extensions).toContain(
			"../pi-framework/pi-framework-knowledge.ts",
		);
	});
});
