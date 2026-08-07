import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STRUCTURED_DELEGATION_SKILL_PATHS = [
	"../../../skills/structured-delegation",
].map((path) => fileURLToPath(new URL(path, import.meta.url)));

export default function loadStructuredDelegationSkill(pi: ExtensionAPI) {
	pi.on("resources_discover", async () => {
		return {
			skillPaths: STRUCTURED_DELEGATION_SKILL_PATHS,
		};
	});
}
