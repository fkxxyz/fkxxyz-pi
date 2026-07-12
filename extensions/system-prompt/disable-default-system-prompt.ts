import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const NEUTRAL_SYSTEM_PROMPT = "You are running inside the pi agent harness.";

export default function disableDefaultSystemPrompt(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const append = event.systemPromptOptions.appendSystemPrompt?.trim();

    return {
      systemPrompt: append
        ? `${NEUTRAL_SYSTEM_PROMPT}\n\n${append}`
        : NEUTRAL_SYSTEM_PROMPT,
    };
  });
}
