import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getExtensionLoader } from "../../base/extension-loader.ts";

export default async function codeTools(pi: ExtensionAPI) {
	const load = getExtensionLoader(pi).from(import.meta.url).load;

	await load("./apply-patch.ts");
	await load("./lsp-tools.ts");
	await load("./read-with-line-numbers.ts");
}
