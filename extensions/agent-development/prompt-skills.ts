import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getExtensionLoader } from "../base/extension-loader.ts";

const AGENT_DEVELOPMENT_SKILL_PATHS = [
	"../../skills/prompt-maintenance",
	"../../skills/prompt-best-practices",
].map((path) => fileURLToPath(new URL(path, import.meta.url)));

export default async function loadAgentDevelopmentSkills(pi: ExtensionAPI) {
	const load = getExtensionLoader(pi).from(import.meta.url).load;

	await load("../skills/experience-capture.ts");

	pi.on("resources_discover", async () => {
		return {
			skillPaths: AGENT_DEVELOPMENT_SKILL_PATHS,
		};
	});
}
