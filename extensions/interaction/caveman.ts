import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LEVELS = ["off", "lite", "full", "ultra"] as const;
type CavemanLevel = (typeof LEVELS)[number];

let currentLevel: CavemanLevel = "full";

const INSTRUCTIONS: Record<Exclude<CavemanLevel, "off">, string> = {
	lite: [
		"Caveman lite mode active.",
		"Keep normal grammar, but remove filler, pleasantries, hedging, and repeated setup phrases.",
		"Prefer concise professional wording. Keep technical terms, code, commands, paths, URLs, and quoted errors exact.",
	].join(" "),
	full: [
		"Caveman mode active.",
		"Answer with compact fragments where clear. Drop articles, filler, pleasantries, and hedging.",
		"Prefer short direct words without losing technical substance.",
		"Keep technical terms exact. Do not alter code blocks, commands, paths, URLs, or quoted error messages.",
		"Preserve the user's language unless explicitly asked to translate.",
	].join(" "),
	ultra: [
		"Caveman ultra mode active.",
		"Use maximum compression: telegraphic fragments, terse bullets, no filler.",
		"Keep technical terms exact. Do not alter code blocks, commands, paths, URLs, or quoted error messages.",
		"Preserve the user's language unless explicitly asked to translate.",
	].join(" "),
};

function isCavemanLevel(value: string): value is CavemanLevel {
	return (LEVELS as readonly string[]).includes(value);
}

function formatLevel(level: CavemanLevel): string {
	switch (level) {
		case "off":
			return "Caveman off. Normal mode.";
		case "lite":
			return "Caveman lite. Filler gone, grammar kept.";
		case "full":
			return "Caveman full. Compact fragments.";
		case "ultra":
			return "Caveman ultra. Maximum compression.";
	}
}

export default function caveman(pi: ExtensionAPI) {
	pi.registerCommand("caveman", {
		description: "Set caveman response compression level: off, lite, full, or ultra. Default: full.",
		getArgumentCompletions: (prefix) =>
			LEVELS.map((level) => ({ value: level, label: level })).filter((item) => item.value.startsWith(prefix)),
		handler: async (args, ctx) => {
			const requestedLevel = args.trim().toLowerCase();

			if (!requestedLevel) {
				ctx.ui.notify(formatLevel(currentLevel), "info");
				return;
			}

			if (!isCavemanLevel(requestedLevel)) {
				ctx.ui.notify("Unknown caveman level. Use: off, lite, full, ultra.", "error");
				return;
			}

			currentLevel = requestedLevel;
			ctx.ui.notify(formatLevel(currentLevel), "info");
		},
	});

	pi.on("session_start", async () => {
		currentLevel = "full";
	});

	pi.on("before_agent_start", async (event) => {
		if (currentLevel === "off") return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${INSTRUCTIONS[currentLevel]}`,
		};
	});
}
