import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getExtensionLoader } from "../base/extension-loader.ts";

export default async function piWorkspace(pi: ExtensionAPI) {
	const load = getExtensionLoader(pi).from(import.meta.url).load;

	await load("../interaction/interaction.ts");
	await load("../code/code.ts");
	await load("../tool-output/tool-output-limiter.ts");
	await load("../session/auto-session-name.ts");
	await load("../agent-development/prompt-skills.ts");
	await load("../skills/thinking-methodology.ts");
}
