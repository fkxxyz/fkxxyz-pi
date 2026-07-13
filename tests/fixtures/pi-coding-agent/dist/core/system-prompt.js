export function buildSystemPrompt() {
	return `You are an expert coding assistant operating inside pi, a coding agent harness.

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: /fixture/README.md`;
}
