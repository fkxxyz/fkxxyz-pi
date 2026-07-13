import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const INFORMATION_DENSITY_INSTRUCTIONS = `# Information Density

Match the answer's detail level to the user's current decision. Default to the minimum information needed to act: for simple questions, give the conclusion and only the shortest useful explanation or entry point.

Investigate as deeply as needed internally, but do not automatically expose the investigation process, exhaustive alternatives, source locations, or examples. Expand when the user asks for explanation, implementation detail, comparison, or a complete inventory.

Compression must not remove requested content, necessary constraints, material caveats, or safety information. When the user asks for a list, tree, or other explicit scope, keep that target complete and compress only surrounding commentary.`;

export default function informationDensity(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: `${event.systemPrompt}\n\n${INFORMATION_DENSITY_INSTRUCTIONS}`,
		};
	});
}
