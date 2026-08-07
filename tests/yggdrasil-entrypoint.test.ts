import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

describe("yggdrasil entrypoint", () => {
	test("keeps default preset extensions except thinking methodology and code agents", async () => {
		const source = await readFile(resolve("extensions/entrypoints/yggdrasil.ts"), "utf8");

		expect(source).toContain('await load("../system-prompt/simplify-system-prompt.ts");');
		expect(source).toContain('await load("../system-prompt/load-agents-md.ts");');
		expect(source).toContain('await load("../interaction/interaction.ts");');
		expect(source).toContain('await load("../code/tools/tools.ts");');
		expect(source).toContain('await load("../code/methodology/methodology.ts");');
		expect(source).toContain('await load("../code/research/research.ts");');
		expect(source).toContain('await load("../code/frontend/frontend.ts");');
		expect(source).toContain('await load("../code/environment/environment.ts");');
		expect(source).toContain('await load("../tool-output/tool-output-limiter.ts");');
		expect(source).toContain('await load("../session/auto-session-name.ts");');
		expect(source).toContain('await load("../agent-development/prompt-skills.ts");');
		expect(source).toContain('await load("../pi-framework/pi-framework-knowledge.ts");');

		expect(source).not.toContain("../skills/thinking-methodology.ts");
		expect(source).not.toContain("../code/code.ts");
		expect(source).not.toContain("../code/agents/agents.ts");
	});
});
