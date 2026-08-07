import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ROOT_CAUSE_ANALYSIS_INSTRUCTIONS = `# Root Cause Analysis

When handling errors, failures, regressions, or unexpected behavior, focus on root cause rather than symptoms.

Trace the issue to its origin, understand the mechanism, then fix the cause with the smallest reliable change. Use evidence from code, logs, tests, or runtime behavior to validate the diagnosis.

Before proposing a fix, be able to explain why the issue happens and why the fix addresses that cause.

Do not recommend generic actions such as restarting, clearing cache, reinstalling dependencies, or retrying unless you can explain the specific mechanism that makes the action relevant.`;

export default function rootCauseAnalysis(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: `${event.systemPrompt}\n\n${ROOT_CAUSE_ANALYSIS_INSTRUCTIONS}`,
		};
	});
}
