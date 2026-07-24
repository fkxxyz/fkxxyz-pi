import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

describe("agent runtime main agent injector", () => {
  test("code extension loads agent runtime", async () => {
    const source = await readFile(resolve("extensions/code/code.ts"), "utf8");

    expect(source).toContain('await load("../agent-runtime/agent-runtime.ts");');
  });

  test("discovers the bundled workspace agent authoring skill", async () => {
    const handlers: Array<() => Promise<{ skillPaths?: string[] }>> = [];
    const { default: agentRuntimeExtension } = await import("../extensions/agent-runtime/agent-runtime.ts");

    agentRuntimeExtension({
      on(eventName: string, handler: () => Promise<{ skillPaths?: string[] }>) {
        if (eventName === "resources_discover") handlers.push(handler);
      },
    } as never);

    expect(handlers).toHaveLength(1);
    const result = await handlers[0]!();
    const skillPaths = result.skillPaths ?? [];
    const skillPath = resolve("extensions/agent-runtime/skills/workspace-agent-authoring");

    expect(skillPaths).toEqual([skillPath]);
    expect(existsSync(join(skillPath, "SKILL.md"))).toBe(true);
  });

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
