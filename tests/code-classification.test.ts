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
			"extensions/code/methodology/reasoning.ts",
			"extensions/code/research/research.ts",
			"extensions/code/research/exa-mcp.ts",
			"extensions/code/research/markitdown-mcp.ts",
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

	test("research entrypoint exposes configured MCP bridges", async () => {
		const source = await readFile(resolve("extensions/code/research/research.ts"), "utf8");

		expect(source).toContain('await load("./exa-mcp.ts");');
		expect(source).toContain('await load("./markitdown-mcp.ts");');
	});

	test("MarkItDown MCP bridge uses personal config and caller-facing tool guidance", async () => {
		const source = await readFile(resolve("extensions/code/research/markitdown-mcp.ts"), "utf8");
		const personalConfig = await readFile(resolve("extensions/base/personal-config.ts"), "utf8");
		const envExample = await readFile(resolve(".env.example.json"), "utf8");
		const readme = await readFile(resolve("README.md"), "utf8");

		expect(personalConfig).toContain("markitdownMcp?:");
		expect(source).toContain("config.markitdownMcp?.url");
		expect(source).toContain('warnMissingPersonalConfigValue("MarkItDown MCP", "markitdownMcp.url")');
		expect(source).toContain("[MarkItDown MCP]");
		expect(source).toContain("convert files, URLs, PDFs, Office documents, and other supported content to Markdown or plain text");
		expect(source).toContain("Do not use MarkItDown MCP for web search");
		expect(envExample).toContain('"markitdownMcp"');
		expect(envExample).toContain('"url": "http://127.0.0.1:3001/mcp/"');
		expect(readme).toContain("extensions/code/research/markitdown-mcp.ts` uses `markitdownMcp.url`");
	});
});
