export default {
  mainAgent: "researcher",
  agents: {
    researcher: {
      description: "Primary researcher workspace agent for evidence-backed historical-evolutionary investigation.",
      systemPromptFile: "./researcher.md",
    },
    "search-report": {
      description: "Use for one bounded web-research angle when a concise, source-backed report will inform the researcher main agent. Do not use for multi-round investigation or cross-angle synthesis.",
      systemPromptFile: "./search-report.md",
    },
  },
} satisfies {
  mainAgent: string;
  agents: Record<string, {
    description: string;
    systemPrompt?: string;
    systemPromptFile?: string;
    workspace?: string;
  }>;
};
