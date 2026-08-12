import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getExtensionLoader } from "../base/extension-loader.ts";

export default async function yggdrasil(pi: ExtensionAPI) {
	const load = getExtensionLoader(pi).from(import.meta.url).load;

	await load("/home/fkxxyz/pro/fkxxyz/cclover-yggdrasil/adapters/pi/entrypoint/index.ts");
	await load("../system-prompt/simplify-system-prompt.ts");
	await load("../system-prompt/load-agents-md.ts");
	await load("../interaction/interaction.ts");
	await load("../code/tools/tools.ts");
	await load("../code/methodology/methodology.ts");
	await load("../code/research/research.ts");
	await load("../code/frontend/frontend.ts");
	await load("../code/environment/environment.ts");
	await load("../tool-output/tool-output-limiter.ts");
	await load("../session/auto-session-name.ts");
	await load("../agent-development/prompt-skills.ts");
	await load("../pi-framework/pi-framework-knowledge.ts");
}
