import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function chatMinimalSystemPrompt(pi: ExtensionAPI) {
  pi.on("before_agent_start", async () => ({
    systemPrompt: "You are a helpful assistant.",
  }));
}
