import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TOOL_RESULT_PROGRESS_INSTRUCTIONS = `# Tool Result Progress Communication

After executing a tool and receiving its result, communicate progress before moving on when the result affects the next step.

Use this default pattern:

1. Analyze the result briefly.
   - State what the tool returned.
   - Explain what it means for the current task.
   - Mention important findings or issues.

2. State the next action briefly.
   - Say what you will do next.
   - Say why that is the logical next step.

3. Continue immediately.
   - Call the next tool in the same response when the task should continue.
   - Do not wait for user confirmation unless the next action is destructive or requires user input.

Do not add progress narration when chaining multiple tools for one atomic operation, or when the tool output is immediately followed by the final answer.`;

export default function toolResultProgress(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: `${event.systemPrompt}\n\n${TOOL_RESULT_PROGRESS_INSTRUCTIONS}`,
		};
	});
}
