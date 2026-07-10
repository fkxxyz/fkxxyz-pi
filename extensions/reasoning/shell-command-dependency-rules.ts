import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const COMMAND_DEPENDENCY_CONTEXT = `## Shell Command Dependency Rules

When planning tool calls or shell commands, preserve correctness before optimizing for speed.

- Dependent operations must run sequentially so later steps only execute after prerequisites succeed.
  - Prefer explicit sequencing such as \`mkdir dir && cp file dir\` when the second command depends on the first.
- Independent operations may run in parallel when doing so reduces waiting without changing behavior.

This distinction exists to avoid race conditions and invalid assumptions while still allowing efficient execution for unrelated work.`;

export default function shellCommandDependencyRules(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: `${event.systemPrompt}\n\n${COMMAND_DEPENDENCY_CONTEXT}`,
		};
	});
}
