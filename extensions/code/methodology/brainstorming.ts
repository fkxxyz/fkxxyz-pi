import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BRAINSTORMING_SKILL_PATHS = [
  "../../../skills/cclover/brainstorming",
  "../../../skills/cclover/brainstorming-complete",
].map((path) => fileURLToPath(new URL(path, import.meta.url)));

export default function loadBrainstormingSkills(pi: ExtensionAPI) {
  pi.on("resources_discover", async () => {
    return {
      skillPaths: BRAINSTORMING_SKILL_PATHS,
    };
  });
}
