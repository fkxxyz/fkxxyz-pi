import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getExtensionLoader } from "../base/extension-loader.ts";

export default async function code(pi: ExtensionAPI) {
	const load = getExtensionLoader(pi).from(import.meta.url).load;

	await load("../skills/brainstorming.ts");
	await load("../skills/test-driven-development.ts");
	await load("../reasoning/reasoning.ts");
	await load("../exa/exa-mcp.ts");
	await load("../sub-agent/sub-agent.ts");
	await load("./apply-patch.ts");
	await load("./lsp-tools.ts");
	await load("./frontend-development.ts");
	await load("./systematic-debugging.ts");
	await load("../tool-policy/read-with-line-numbers.ts");
	await load("../environment/shared-skill-discovery.ts");
	await load("../environment/arch-package-management.ts");
	await load("../environment/project-directory-rules.ts");
}
