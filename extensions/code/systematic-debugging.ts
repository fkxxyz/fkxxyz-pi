import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SYSTEMATIC_DEBUGGING_SKILL_PATHS = [
	"../../skills/superpowers/systematic-debugging",
].map((path) => fileURLToPath(new URL(path, import.meta.url)));

export default function discoverSystematicDebuggingSkill(pi: ExtensionAPI) {
	pi.on("resources_discover", async () => {
		return {
			skillPaths: SYSTEMATIC_DEBUGGING_SKILL_PATHS,
		};
	});
}
