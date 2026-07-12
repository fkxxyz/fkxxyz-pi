import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

describe("disable default system prompt extension", () => {
  test("removes the pi coding prompt while preserving appended agent instructions", async () => {
    const handlers: any[] = [];
    const { default: disableDefaultSystemPrompt } = await import("../extensions/system-prompt/disable-default-system-prompt.ts");

    disableDefaultSystemPrompt({
      on(eventName: string, handler: any) {
        if (eventName === "before_agent_start") handlers.push(handler);
      },
    } as never);

    expect(handlers).toHaveLength(1);
    const result = await handlers[0]({
      systemPrompt: "You are an expert coding assistant. Use bash, read, edit, and write.",
      systemPromptOptions: {
        appendSystemPrompt: '<sub_agent_instructions agent="roleplay-narrator">narrator prompt</sub_agent_instructions>',
      },
    });

    expect(result.systemPrompt).not.toContain("expert coding assistant");
    expect(result.systemPrompt).not.toContain("bash, read, edit, and write");
    expect(result.systemPrompt).toContain('<sub_agent_instructions agent="roleplay-narrator">');
    expect(result.systemPrompt).toContain("narrator prompt");
  });

  test("uses a neutral minimal prompt when no appended prompt exists", async () => {
    const handlers: any[] = [];
    const { default: disableDefaultSystemPrompt } = await import("../extensions/system-prompt/disable-default-system-prompt.ts");

    disableDefaultSystemPrompt({
      on(eventName: string, handler: any) {
        if (eventName === "before_agent_start") handlers.push(handler);
      },
    } as never);

    const result = await handlers[0]({
      systemPrompt: "coding prompt",
      systemPromptOptions: {},
    });

    expect(result.systemPrompt).toBe("You are running inside the pi agent harness.");
  });

  test("roleplay workspace loads it before the main agent runtime", async () => {
    const settings = JSON.parse(await readFile(resolve("workspaces/roleplay-chat/.pi/settings.json"), "utf8"));

    expect(settings.extensions).toEqual([
      "../../../extensions/system-prompt/disable-default-system-prompt.ts",
      "../../../extensions/agent-runtime/agent-runtime.ts",
      "../../../extensions/sub-agent/sub-agent.ts",
      "../../../extensions/tool-policy/disable-basic-tools.ts",
    ]);
  });
});
