import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getExtensionLoader } from "../../base/extension-loader.ts";

export default async function reasoning(pi: ExtensionAPI) {
	const load = getExtensionLoader(pi).from(import.meta.url).load;

	await load("./deliberate-decision-making.ts");
	await load("./resolve-uncertainty.ts");
	await load("./root-cause-analysis.ts");
	await load("./top-down-analysis.ts");
	await load("./shell-command-dependency-rules.ts");
}
