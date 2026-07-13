import { existsSync, realpathSync, readFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENTS_FILE_NAME = "AGENTS.md";

function getCwd(event: { systemPromptOptions?: { cwd?: string } }): string {
	return event.systemPromptOptions?.cwd ? resolve(event.systemPromptOptions.cwd) : process.cwd();
}

function findAgentsFiles(cwd: string): string[] {
	const files: string[] = [];
	const seenRealPaths = new Set<string>();
	let current = resolve(cwd);

	while (true) {
		const candidate = join(current, AGENTS_FILE_NAME);
		if (existsSync(candidate)) {
			const realPath = realpathSync(candidate);
			if (!seenRealPaths.has(realPath)) {
				seenRealPaths.add(realPath);
				files.push(candidate);
			}
		}

		const parent = dirname(current);
		if (parent === current || current === parse(current).root) break;
		current = parent;
	}

	return files.reverse();
}

function formatAgentsMd(path: string): string {
	const content = readFileSync(path, "utf8").trim();
	return `<project_instructions path="${path}">\n${content}\n</project_instructions>`;
}

export default function loadAgentsMd(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const agentsFiles = findAgentsFiles(getCwd(event));
		if (agentsFiles.length === 0) return;

		const projectContext = `<project_context>\n\n${agentsFiles.map(formatAgentsMd).join("\n\n")}\n\n</project_context>`;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${projectContext}`,
		};
	});
}
