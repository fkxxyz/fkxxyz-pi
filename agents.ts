export default {} satisfies Record<string, {
  description: string;
  systemPrompt?: string;
  systemPromptFile?: string;
  systemPromptFiles?: string[];
  systemPromptScript?: string;
  workspace?: string;
}>;
