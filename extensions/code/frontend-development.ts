import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FRONTEND_DEVELOPMENT_SKILL_PATHS = [
	"../../skills/agent-browser",
	"../../skills/flutter-ui-debugging",
	"../../skills/ui-ux-pro-max",
].map((path) => fileURLToPath(new URL(path, import.meta.url)));

export default function discoverFrontendDevelopmentSkills(pi: ExtensionAPI) {
	pi.on("resources_discover", async () => {
		return {
			skillPaths: FRONTEND_DEVELOPMENT_SKILL_PATHS,
		};
	});
}
