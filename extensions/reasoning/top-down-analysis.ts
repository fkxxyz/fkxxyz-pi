import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TOP_DOWN_ANALYSIS_INSTRUCTIONS = `# Top-Down Analysis

Approach complex problems from the top down.

Start with the overall goal, architecture, system boundaries, and major data or control flows before diving into local details. Understand the macro context first, then progressively narrow to the relevant component, function, file, or line.

Use clear hypotheses and systematic elimination instead of blind exploration. Let the big-picture model guide which details matter.

For configuration tasks, first identify the scope of the change: user-global state, workspace-local settings, reusable repository assets, or installed package/source files. This prevents the current working directory from anchoring the search to the wrong layer.

For small, self-contained tasks, keep this lightweight and do not over-analyze.`;

export default function topDownAnalysis(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: `${event.systemPrompt}\n\n${TOP_DOWN_ANALYSIS_INSTRUCTIONS}`,
		};
	});
}
