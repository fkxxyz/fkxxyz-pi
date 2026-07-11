export default {
  researcher: {
    description: "Use for questions needing an evidence-backed account of a topic's origins, evolution, and present state. Do not use for quick fact checks, a single bounded search angle, local codebase investigation, or tasks without meaningful historical context; delegate bounded web-research angles to search-report instead.",
    systemPromptFile: "./agents/cclover/researcher.md",
  },
  "search-report": {
    description: "Use for one bounded web-research angle when a concise, source-backed report will inform a larger answer or research process. Do not use for multi-round investigation, cross-angle synthesis, complete historical accounts, or local codebase investigation; create separate agents for independent angles.",
    systemPromptFile: "./agents/cclover/search-report.md",
  },
} satisfies Record<string, {
  description: string;
  systemPrompt?: string;
  systemPromptFile?: string;
  workspace?: string;
}>;
