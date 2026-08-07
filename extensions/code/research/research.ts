import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getExtensionLoader } from "../../base/extension-loader.ts";

export default async function codeResearch(pi: ExtensionAPI) {
	const load = getExtensionLoader(pi).from(import.meta.url).load;

	await load("./exa-mcp.ts");
	await load("./markitdown-mcp.ts");
}
