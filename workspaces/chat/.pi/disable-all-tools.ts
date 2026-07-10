import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function disableAllTools(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const before = pi.getActiveTools();
    pi.setActiveTools([]);

    if (before.length > 0 && ctx.hasUI) {
      ctx.ui.notify(
        `Chat workspace: disabled all tools (${before.join(", ")})`,
        "warning",
      );
    }
  });

  pi.on("tool_call", async (event) => ({
    block: true,
    reason: `Tool '${event.toolName}' is disabled in the chat-only workspace.`,
  }));
}
