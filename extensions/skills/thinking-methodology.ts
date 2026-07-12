import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const THINKING_METHODOLOGY_SKILL_PATHS = [
	"../../skills/thinking-methodology",
].map((path) => fileURLToPath(new URL(path, import.meta.url)));

export default function loadThinkingMethodologySkill(pi: ExtensionAPI) {
	pi.on("resources_discover", async () => {
		return {
			skillPaths: THINKING_METHODOLOGY_SKILL_PATHS,
		};
	});
}
