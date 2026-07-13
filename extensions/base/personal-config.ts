import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type PersonalConfig = {
	markdownPreview?: {
		baseUrl?: string;
	};
	exaMcp?: {
		url?: string;
	};
	autoSessionName?: {
		provider?: string;
		model?: string;
	};
	projectDirectories?: {
		thirdPartyRepos?: string;
		thirdPartyRepoExample?: string;
		personalProjects?: string;
		personalProjectExample?: string;
	};
};

let cachedConfig: PersonalConfig | null | undefined;
let cachedError: unknown;

export const PERSONAL_CONFIG_PATH = fileURLToPath(new URL("../../.env.json", import.meta.url));

export function readPersonalConfig(): PersonalConfig | null {
	if (cachedConfig !== undefined) return cachedConfig;

	cachedConfig = null;
	cachedError = undefined;

	if (!existsSync(PERSONAL_CONFIG_PATH)) return cachedConfig;

	try {
		cachedConfig = JSON.parse(readFileSync(PERSONAL_CONFIG_PATH, "utf-8")) as PersonalConfig;
	} catch (error) {
		cachedError = error;
	}

	return cachedConfig;
}

export function warnMissingPersonalConfig(feature: string) {
	console.warn(`Warning: ${feature} disabled: personal config .env.json not found at ${PERSONAL_CONFIG_PATH}`);
}

export function warnInvalidPersonalConfig(feature: string) {
	console.warn(`Warning: ${feature} disabled: failed to parse personal config .env.json at ${PERSONAL_CONFIG_PATH}: ${cachedError}`);
}

export function warnMissingPersonalConfigValue(feature: string, key: string) {
	console.warn(`Warning: ${feature} disabled: missing ${key} in personal config .env.json`);
}

export function hasPersonalConfigParseError() {
	return cachedError !== undefined;
}
