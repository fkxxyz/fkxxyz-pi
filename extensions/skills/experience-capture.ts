import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const EXPERIENCE_CAPTURE_SKILL_PATHS = [
	"../../skills/experience-capture",
].map((path) => fileURLToPath(new URL(path, import.meta.url)));

export default function loadExperienceCaptureSkill(pi: ExtensionAPI) {
	pi.on("resources_discover", async () => {
		return {
			skillPaths: EXPERIENCE_CAPTURE_SKILL_PATHS,
		};
	});
}
