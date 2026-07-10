import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getExtensionLoader } from "../base/extension-loader.ts";

interface PresetConfig {
	extensions?: unknown;
}

const PRESET_CONFIG_URL = new URL("./default-preset.json", import.meta.url);
const PRESET_CONFIG_PATH = fileURLToPath(PRESET_CONFIG_URL);

function readPresetExtensions(): string[] {
	const raw = fs.readFileSync(PRESET_CONFIG_PATH, "utf-8");
	const config = JSON.parse(raw) as PresetConfig;

	if (!Array.isArray(config.extensions)) {
		throw new Error("entrypoints/default-preset.json must contain an extensions array.");
	}

	return config.extensions.map((entry, index) => {
		if (typeof entry !== "string" || entry.trim() === "") {
			throw new Error(`entrypoints/default-preset.json extensions[${index}] must be a non-empty string.`);
		}
		return entry;
	});
}

export default async function defaultEntrypoint(pi: ExtensionAPI) {
	const extensions = readPresetExtensions();
	const load = getExtensionLoader(pi).from(PRESET_CONFIG_URL).load;

	for (const extension of extensions) {
		await load(extension);
	}
}
