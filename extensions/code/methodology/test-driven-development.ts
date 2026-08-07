import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TEST_DRIVEN_DEVELOPMENT_SKILL_PATHS = [
	"../../../skills/superpowers/test-driven-development",
].map((path) => fileURLToPath(new URL(path, import.meta.url)));

export default function loadTestDrivenDevelopmentSkill(pi: ExtensionAPI) {
	pi.on("resources_discover", async () => {
		return {
			skillPaths: TEST_DRIVEN_DEVELOPMENT_SKILL_PATHS,
		};
	});
}
