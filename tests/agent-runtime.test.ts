import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("agent runtime main agent injector", () => {
  test("injects the mainAgent prompt from nested .pi/agents.ts", async () => {
    const projectDir = join(tmpdir(), `pi-agent-runtime-main-${Date.now()}`);
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await writeFile(join(projectDir, ".pi", "main.md"), "main prompt from file");
    await writeFile(join(projectDir, ".pi", "agents.ts"), `
export default {
  mainAgent: "main",
  agents: {
    main: {
      description: "Main coordinator",
      systemPromptFile: "./main.md"
    },
    helper: {
      description: "Helper",
      systemPrompt: "helper prompt"
    }
  }
};
`);

    try {
      const handlers: any[] = [];
      const { default: agentRuntimeExtension } = await import("../extensions/agent-runtime/agent-runtime.ts");
      agentRuntimeExtension({
        on(eventName: string, handler: any) {
          if (eventName === "before_agent_start") handlers.push(handler);
        },
      } as never);

      expect(handlers).toHaveLength(1);
      const result = await handlers[0]({ systemPrompt: "base prompt" }, { cwd: projectDir });

      expect(result.systemPrompt).toContain("base prompt");
      expect(result.systemPrompt).toContain('<agent_instructions agent="main" role="main"');
      expect(result.systemPrompt).toContain("main prompt from file");
      expect(result.systemPrompt).not.toContain("helper prompt");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("does nothing when .pi/agents.ts has no mainAgent", async () => {
    const projectDir = join(tmpdir(), `pi-agent-runtime-no-main-${Date.now()}`);
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await writeFile(join(projectDir, ".pi", "agents.ts"), `
export default {
  helper: {
    description: "Helper",
    systemPrompt: "helper prompt"
  }
};
`);

    try {
      const handlers: any[] = [];
      const { default: agentRuntimeExtension } = await import("../extensions/agent-runtime/agent-runtime.ts");
      agentRuntimeExtension({
        on(eventName: string, handler: any) {
          if (eventName === "before_agent_start") handlers.push(handler);
        },
      } as never);

      expect(await handlers[0]({ systemPrompt: "base prompt" }, { cwd: projectDir })).toBeUndefined();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
