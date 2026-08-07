import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SHARED_SKILL_PATHS = [
	"../../../skills/lm-studio-local-model-yaml-wrapper",
	"../../../skills/multi-identity-manager",
	"../../../skills/openwrt-service-deployment",
].map((path) => fileURLToPath(new URL(path, import.meta.url)));

export default function discoverSharedSkills(pi: ExtensionAPI) {
	pi.on("resources_discover", async () => {
		return {
			skillPaths: SHARED_SKILL_PATHS,
		};
	});
}
