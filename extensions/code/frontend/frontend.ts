import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getExtensionLoader } from "../../base/extension-loader.ts";

export default async function codeFrontend(pi: ExtensionAPI) {
	const load = getExtensionLoader(pi).from(import.meta.url).load;

	await load("./frontend-development.ts");
}
