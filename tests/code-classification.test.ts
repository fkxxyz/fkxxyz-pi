import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const codeSubcategories = ["tools", "agents", "methodology", "research", "frontend", "environment"];

describe("code extension classification", () => {
	test("code root delegates to focused subcategory entrypoints", async () => {
		const source = await readFile(resolve("extensions/code/code.ts"), "utf8");

		for (const category of codeSubcategories) {
			expect(source).toContain(`await load("./${category}/${category}.ts");`);
		}
		expect(source).not.toContain("../agent-runtime/agent-runtime.ts");
		expect(source).not.toContain("../sub-agent/sub-agent.ts");
		expect(source).not.toContain("./apply-patch.ts");
	});

	test("code subcategory files live under the code tree", () => {
		const expectedFiles = [
			"extensions/code/tools/tools.ts",
			"extensions/code/tools/apply-patch.ts",
			"extensions/code/tools/lsp-tools.ts",
			"extensions/code/tools/read-with-line-numbers.ts",
			"extensions/code/agents/agents.ts",
			"extensions/code/agents/agent-runtime.ts",
			"extensions/code/agents/sub-agent.ts",
			"extensions/code/agents/structured-delegation.ts",
			"extensions/code/methodology/methodology.ts",
			"extensions/code/methodology/brainstorming.ts",
			"extensions/code/methodology/test-driven-development.ts",
			"extensions/code/methodology/systematic-debugging.ts",
			"extensions/code/methodology/reasoning.ts",
			"extensions/code/research/research.ts",
			"extensions/code/research/exa-mcp.ts",
			"extensions/code/frontend/frontend.ts",
			"extensions/code/frontend/frontend-development.ts",
			"extensions/code/environment/environment.ts",
			"extensions/code/environment/shared-skill-discovery.ts",
			"extensions/code/environment/arch-package-management.ts",
			"extensions/code/environment/project-directory-rules.ts",
		];

		for (const file of expectedFiles) {
			expect(existsSync(resolve(file)), file).toBe(true);
		}
	});
});
