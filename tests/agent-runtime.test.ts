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
      registerCommand() {},
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
        registerCommand() {},
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

  test("injects the mainAgent prompt from multiple files in order", async () => {
    const projectDir = join(tmpdir(), `pi-agent-runtime-main-files-${Date.now()}`);
    await mkdir(join(projectDir, ".pi", "prompts"), { recursive: true });
    await writeFile(join(projectDir, ".pi", "prompts", "one.md"), "first prompt");
    await writeFile(join(projectDir, ".pi", "prompts", "two.md"), "second prompt");
    await writeFile(join(projectDir, ".pi", "agents.ts"), `
export default {
  mainAgent: "main",
  agents: {
    main: {
      description: "Main coordinator",
      systemPromptFiles: ["./prompts/one.md", "./prompts/two.md"]
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
        registerCommand() {},
      } as never);

      const result = await handlers[0]({ systemPrompt: "base prompt" }, { cwd: projectDir });

      expect(result.systemPrompt).toContain('<agent_instructions agent="main" role="main"');
      expect(result.systemPrompt).toContain("first prompt\n\nsecond prompt");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("injects the mainAgent prompt from systemPromptScript stdout", async () => {
    const projectDir = join(tmpdir(), `pi-agent-runtime-main-script-${Date.now()}`);
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await writeFile(join(projectDir, ".pi", "dynamic-prompt.ts"), `
process.stdout.write("main prompt from script");
`);
    await writeFile(join(projectDir, ".pi", "agents.ts"), `
export default {
  mainAgent: "main",
  agents: {
    main: {
      description: "Main coordinator",
      systemPromptScript: "./dynamic-prompt.ts"
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
        registerCommand() {},
      } as never);

      const result = await handlers[0]({ systemPrompt: "base prompt" }, { cwd: projectDir });

      expect(result.systemPrompt).toContain('<agent_instructions agent="main" role="main"');
      expect(result.systemPrompt).toContain("main prompt from script");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("active-agent session entry overrides mainAgent without injecting both prompts", async () => {
    const projectDir = join(tmpdir(), `pi-agent-runtime-active-${Date.now()}`);
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await writeFile(join(projectDir, ".pi", "agents.ts"), `
export default {
  mainAgent: "main",
  agents: {
    main: {
      description: "Main coordinator",
      systemPrompt: "main prompt"
    },
    reviewer: {
      description: "Reviewer",
      systemPrompt: "reviewer prompt"
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
        registerCommand() {},
      } as never);

      const result = await handlers[0]({ systemPrompt: "base prompt" }, {
        cwd: projectDir,
        sessionManager: {
          getEntries: () => [
            { type: "custom", customType: "active-agent", data: { name: "reviewer" } },
          ],
        },
      });

      expect(result.systemPrompt).toContain('<agent_instructions agent="reviewer" role="active"');
      expect(result.systemPrompt).toContain("You are reviewer. You are currently running as the active workspace agent, interacting directly with the user. The following block defines your identity and behavior instructions.");
      expect(result.systemPrompt.indexOf("You are reviewer. You are currently running as the active workspace agent, interacting directly with the user. The following block defines your identity and behavior instructions.")).toBeLessThan(result.systemPrompt.indexOf('<agent_instructions agent="reviewer" role="active"'));
      expect(result.systemPrompt.indexOf('<agent_instructions agent="reviewer" role="active"')).toBeLessThan(result.systemPrompt.indexOf("reviewer prompt"));
      expect(result.systemPrompt).toContain("reviewer prompt");
      expect(result.systemPrompt).not.toContain("main prompt");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("agent command persists selected agent in the current session", async () => {
    const projectDir = join(tmpdir(), `pi-agent-runtime-command-${Date.now()}`);
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await writeFile(join(projectDir, ".pi", "agents.ts"), `
export default {
  mainAgent: "main",
  agents: {
    main: {
      description: "Main coordinator",
      systemPrompt: "main prompt"
    },
    reviewer: {
      description: "Reviewer",
      systemPrompt: "reviewer prompt"
    }
  }
};
`);

    try {
      const commands: Record<string, any> = {};
      const entries: any[] = [];
      const notifications: string[] = [];
      const { default: agentRuntimeExtension } = await import("../extensions/agent-runtime/agent-runtime.ts");
      agentRuntimeExtension({
        on() {},
        registerCommand(name: string, command: any) {
          commands[name] = command;
        },
        appendEntry(customType: string, data: unknown) {
          entries.push({ customType, data });
        },
      } as never);

      expect(commands.agent).toBeDefined();

      await commands.agent.handler("reviewer", {
        cwd: projectDir,
        ui: {
          notify(message: string) {
            notifications.push(message);
          },
        },
        sessionManager: { getEntries: () => [] },
      });

      expect(entries).toEqual([{ customType: "active-agent", data: { name: "reviewer" } }]);
      expect(notifications.at(-1)).toContain("reviewer");
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
        registerCommand() {},
      } as never);

      expect(await handlers[0]({ systemPrompt: "base prompt" }, { cwd: projectDir })).toBeUndefined();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
