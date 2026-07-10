import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getExtensionLoader } from "./extension-loader.ts";

const DEFAULT_ENTRYPOINT = "../entrypoints/default.ts";
const DISABLE_PRESET_MARKER = path.join(".pi", "disable-preset");

function findDisablePresetMarker(cwd: string): string | undefined {
	let currentDir = path.resolve(cwd);

	while (true) {
		const markerPath = path.join(currentDir, DISABLE_PRESET_MARKER);
		if (fs.existsSync(markerPath)) return markerPath;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return undefined;
		currentDir = parentDir;
	}
}

export default function conditionalPresetLoader(pi: ExtensionAPI) {
	let defaultPresetLoaded = false;

	pi.on("session_start", async (_event, ctx) => {
		const markerPath = findDisablePresetMarker(ctx.cwd);

		if (markerPath) {
			ctx.ui.notify(`Default preset skipped because ${markerPath} exists.`, "info");
			return;
		}

		if (defaultPresetLoaded) return;
		defaultPresetLoaded = true;

		const load = getExtensionLoader(pi).from(import.meta.url).load;
		await load(DEFAULT_ENTRYPOINT);
	});
}
