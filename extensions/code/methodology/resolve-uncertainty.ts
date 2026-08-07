import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RESOLVE_UNCERTAINTY_INSTRUCTIONS = `# Resolving Uncertainty

Handle uncertainty according to its source.

When user requirements are unclear, clarify the task before implementation. Use structured questions or brainstorming when ambiguity affects the solution direction.

When design decisions are uncertain during execution, use established project conventions, industry standards, and best practices as the default path.

When API, interface, library, or codebase details are uncertain, investigate directly through available tools, code exploration, documentation, or web search instead of asking the user questions that research can answer.

When the location of configuration, files, or other resources is uncertain, check canonical paths implied by the task domain before broad searches. Use wide \`rg\` or \`find\` only after targeted paths are missing, insufficient, or genuinely unknown; avoid noisy home-directory, filesystem-root, mount-root, or large-collection searches unless the scope requires them. Output limiting such as \`head\`, result truncation, or a pipe consumer limits what is shown, not the traversal cost; when broader recursive search is unavoidable, use real bounds such as narrow roots, pruning, timeouts, or explicit stop conditions.

Avoid guessing when uncertainty is resolvable. Escalate to the user only when the missing information depends on their intent, preference, credentials, permissions, or business constraints.`;

export default function resolveUncertainty(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: `${event.systemPrompt}\n\n${RESOLVE_UNCERTAINTY_INSTRUCTIONS}`,
		};
	});
}
