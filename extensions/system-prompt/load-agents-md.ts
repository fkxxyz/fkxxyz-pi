import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENTS_FILE_NAME = "AGENTS.md";

function getCwd(event: { systemPromptOptions?: { cwd?: string } }): string {
	return event.systemPromptOptions?.cwd ? resolve(event.systemPromptOptions.cwd) : process.cwd();
}

function getAgentsFile(cwd: string): string | undefined {
	const candidate = join(resolve(cwd), AGENTS_FILE_NAME);
	return existsSync(candidate) ? candidate : undefined;
}

function formatAgentsMd(path: string): string {
	const content = readFileSync(path, "utf8").trim();
	return `<project_instructions path="${path}">\n${content}\n</project_instructions>`;
}

export default function loadAgentsMd(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const agentsFile = getAgentsFile(getCwd(event));
		if (!agentsFile) return;

		const projectContext = `<project_context>\n\n${formatAgentsMd(agentsFile)}\n\n</project_context>`;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${projectContext}`,
		};
	});
}
