import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASIC_BUILTIN_TOOLS = new Set(["bash", "read", "edit", "write"]);

function withoutBasicBuiltinTools(toolNames: string[]): string[] {
  return toolNames.filter((name) => !BASIC_BUILTIN_TOOLS.has(name));
}

export default function disableBasicTools(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const before = pi.getActiveTools();
    const after = withoutBasicBuiltinTools(before);

    pi.setActiveTools(after);

    const disabled = before.filter((name) => BASIC_BUILTIN_TOOLS.has(name));
    if (disabled.length > 0 && ctx.hasUI) {
      ctx.ui.notify(
        `Disabled basic built-in tools: ${disabled.join(", ")}`,
        "warning",
      );
    }
  });

  pi.on("tool_call", async (event) => {
    if (!BASIC_BUILTIN_TOOLS.has(event.toolName)) return;

    return {
      block: true,
      reason: `Tool '${event.toolName}' is disabled by the disable-basic-tools policy extension.`,
    };
  });
}
