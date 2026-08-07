import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getExtensionLoader } from "../base/extension-loader.ts";

export default async function code(pi: ExtensionAPI) {
	const load = getExtensionLoader(pi).from(import.meta.url).load;

	await load("./tools/tools.ts");
	await load("./agents/agents.ts");
	await load("./methodology/methodology.ts");
	await load("./research/research.ts");
	await load("./frontend/frontend.ts");
	await load("./environment/environment.ts");
}
