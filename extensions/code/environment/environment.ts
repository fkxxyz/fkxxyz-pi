import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getExtensionLoader } from "../../base/extension-loader.ts";

export default async function codeEnvironment(pi: ExtensionAPI) {
	const load = getExtensionLoader(pi).from(import.meta.url).load;

	await load("./shared-skill-discovery.ts");
	await load("./arch-package-management.ts");
	await load("./project-directory-rules.ts");
}
