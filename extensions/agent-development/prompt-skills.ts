import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AGENT_DEVELOPMENT_SKILL_PATHS = [
	"../../skills/prompt-maintenance",
	"../../skills/prompt-best-practices",
].map((path) => fileURLToPath(new URL(path, import.meta.url)));

export default function loadAgentDevelopmentSkills(pi: ExtensionAPI) {
	pi.on("resources_discover", async () => {
		return {
			skillPaths: AGENT_DEVELOPMENT_SKILL_PATHS,
		};
	});
}
