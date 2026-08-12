import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getExtensionLoader } from "../../base/extension-loader.ts";

export default async function codeMethodology(pi: ExtensionAPI) {
	const load = getExtensionLoader(pi).from(import.meta.url).load;

	await load("./brainstorming.ts");
	await load("./reasoning.ts");
}
