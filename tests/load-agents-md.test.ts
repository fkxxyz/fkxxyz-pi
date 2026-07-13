import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function withTempWorkspace<T>(fn: (root: string) => Promise<T>): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), "pi-agents-md-"));
	try {
		return await fn(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("load AGENTS.md system prompt extension", () => {
	test("appends AGENTS.md files from workspace root to cwd", async () => {
		await withTempWorkspace(async (root) => {
			const nested = join(root, "packages", "app");
			await mkdir(nested, { recursive: true });
			await writeFile(join(root, "AGENTS.md"), "# Root Rules\n\nUse root guidance.");
			await writeFile(join(root, "packages", "AGENTS.md"), "# Package Rules\n\nUse package guidance.");

			const handlers: any[] = [];
			const { default: loadAgentsMd } = await import("../extensions/system-prompt/load-agents-md.ts");

			loadAgentsMd({
				on(eventName: string, handler: any) {
					if (eventName === "before_agent_start") handlers.push(handler);
				},
			} as never);

			expect(handlers).toHaveLength(1);
			const result = await handlers[0]({
				systemPrompt: "Base prompt",
				systemPromptOptions: { cwd: nested },
			});

			expect(result.systemPrompt).toContain("Base prompt");
			expect(result.systemPrompt).toContain(`<project_instructions path="${join(root, "AGENTS.md")}">`);
			expect(result.systemPrompt).toContain("Use root guidance.");
			expect(result.systemPrompt).toContain(`<project_instructions path="${join(root, "packages", "AGENTS.md")}">`);
			expect(result.systemPrompt).toContain("Use package guidance.");
			expect(result.systemPrompt.indexOf("Use root guidance.")).toBeLessThan(
				result.systemPrompt.indexOf("Use package guidance."),
			);
		});
	});

	test("default preset loads AGENTS.md after the simplified system prompt", async () => {
		const preset = JSON.parse(await readFile(resolve("extensions/entrypoints/default-preset.json"), "utf8"));

		expect(preset.extensions).toEqual([
			"../system-prompt/simplify-system-prompt.ts",
			"../system-prompt/load-agents-md.ts",
			"../interaction/interaction.ts",
			"../code/code.ts",
			"../tool-output/tool-output-limiter.ts",
			"../session/auto-session-name.ts",
			"../skills/thinking-methodology.ts",
			"../pi-framework/pi-framework-knowledge.ts",
		]);
	});
});
