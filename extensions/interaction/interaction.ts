import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getExtensionLoader } from "../base/extension-loader.ts";

export default async function interaction(pi: ExtensionAPI) {
	const load = getExtensionLoader(pi).from(import.meta.url).load;

	await load("./caveman.ts");
	await load("./tool-result-progress.ts");
	await load("./markdown-preview-links.ts");
}
