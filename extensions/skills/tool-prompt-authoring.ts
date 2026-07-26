import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TOOL_PROMPT_AUTHORING_SKILL_PATHS = [
	"../../skills/tool-prompt-authoring",
].map((path) => fileURLToPath(new URL(path, import.meta.url)));

export default function loadToolPromptAuthoringSkill(pi: ExtensionAPI) {
	pi.on("resources_discover", async () => {
		return {
			skillPaths: TOOL_PROMPT_AUTHORING_SKILL_PATHS,
		};
	});
}
