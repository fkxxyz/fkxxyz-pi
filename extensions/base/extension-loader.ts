import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  ExtensionAPI,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

export type ExtensionModuleSpecifier = string | URL;

export interface ExtensionLoaderLocalScope {
  load(specifier: ExtensionModuleSpecifier): Promise<void>;
  loadMany(specifiers: readonly ExtensionModuleSpecifier[]): Promise<void>;
  isLoaded(specifier: ExtensionModuleSpecifier): boolean;
}

export interface ExtensionLoader {
  load(
    specifier: ExtensionModuleSpecifier,
    parentUrl?: ExtensionModuleSpecifier,
  ): Promise<void>;

  loadMany(
    specifiers: readonly ExtensionModuleSpecifier[],
    parentUrl?: ExtensionModuleSpecifier,
  ): Promise<void>;

  from(parentUrl: ExtensionModuleSpecifier): ExtensionLoaderLocalScope;

  isLoaded(
    specifier: ExtensionModuleSpecifier,
    parentUrl?: ExtensionModuleSpecifier,
  ): boolean;

  getLoadedModuleIds(): string[];
  getLoadingStack(): string[];
}

interface LoaderState {
  loaded: Set<string>;
  loading: Set<string>;
  stack: string[];
}

const loaderMap = new WeakMap<ExtensionAPI, ExtensionLoader>();

export function getExtensionLoader(pi: ExtensionAPI): ExtensionLoader {
  const existing = loaderMap.get(pi);
  if (existing) return existing;

  const state: LoaderState = {
    loaded: new Set(),
    loading: new Set(),
    stack: [],
  };

  function resolveModuleId(
    specifier: ExtensionModuleSpecifier,
    parentUrl?: ExtensionModuleSpecifier,
  ): string {
    let url: URL;

    if (specifier instanceof URL) {
      url = specifier;
    } else if (isUrlString(specifier)) {
      url = new URL(specifier);
    } else if (path.isAbsolute(specifier)) {
      url = pathToFileURL(specifier);
    } else {
      if (!parentUrl) {
        throw new Error(
          `Cannot resolve extension module without parentUrl: ${specifier}`,
        );
      }

      url = new URL(specifier, normalizeParentUrl(parentUrl));
    }

    return canonicalizeModuleUrl(url);
  }

  function normalizeParentUrl(parentUrl: ExtensionModuleSpecifier): URL {
    if (parentUrl instanceof URL) return parentUrl;
    if (isUrlString(parentUrl)) return new URL(parentUrl);
    if (path.isAbsolute(parentUrl)) return pathToFileURL(parentUrl);
    throw new Error(`parentUrl must be an absolute path or URL: ${parentUrl}`);
  }

  function isUrlString(value: string): boolean {
    return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value);
  }

  function canonicalizeModuleUrl(url: URL): string {
    if (url.protocol !== "file:") return url.href;

    const originalPath = fileURLToPath(url);
    if (!existsSync(originalPath)) return url.href;

    const realPath = realpathSync(originalPath);
    return pathToFileURL(realPath).href;
  }

  function formatModuleId(moduleId: string): string {
    if (!moduleId.startsWith("file:")) return moduleId;

    try {
      return fileURLToPath(moduleId);
    } catch {
      return moduleId;
    }
  }

  function createCircularDependencyError(moduleId: string): Error {
    const cycleStart = state.stack.indexOf(moduleId);
    const cycle =
      cycleStart >= 0
        ? [...state.stack.slice(cycleStart), moduleId]
        : [...state.stack, moduleId];

    return new Error(
      [
        "Circular extension dependency detected:",
        ...cycle.map((id, index) =>
          index === 0
            ? `  ${formatModuleId(id)}`
            : `  -> ${formatModuleId(id)}`,
        ),
      ].join("\n"),
    );
  }

  async function importExtensionFactory(
    moduleId: string,
  ): Promise<ExtensionFactory> {
    const moduleExports = (await import(moduleId)) as {
      default?: unknown;
    };

    if (typeof moduleExports.default !== "function") {
      throw new Error(
        `Extension module has no default extension factory: ${formatModuleId(
          moduleId,
        )}`,
      );
    }

    return moduleExports.default as ExtensionFactory;
  }

  async function loadResolved(moduleId: string): Promise<void> {
    if (state.loaded.has(moduleId)) return;

    if (state.loading.has(moduleId)) {
      throw createCircularDependencyError(moduleId);
    }

    state.loading.add(moduleId);
    state.stack.push(moduleId);

    try {
      const factory = await importExtensionFactory(moduleId);
      await factory(pi);
      state.loaded.add(moduleId);
    } finally {
      state.stack.pop();
      state.loading.delete(moduleId);
    }
  }

  const loader: ExtensionLoader = {
    async load(specifier, parentUrl) {
      const moduleId = resolveModuleId(specifier, parentUrl);
      await loadResolved(moduleId);
    },

    async loadMany(specifiers, parentUrl) {
      for (const specifier of specifiers) {
        await loader.load(specifier, parentUrl);
      }
    },

    from(parentUrl) {
      return {
        load(specifier) {
          return loader.load(specifier, parentUrl);
        },

        loadMany(specifiers) {
          return loader.loadMany(specifiers, parentUrl);
        },

        isLoaded(specifier) {
          return loader.isLoaded(specifier, parentUrl);
        },
      };
    },

    isLoaded(specifier, parentUrl) {
      const moduleId = resolveModuleId(specifier, parentUrl);
      return state.loaded.has(moduleId);
    },

    getLoadedModuleIds() {
      return [...state.loaded];
    },

    getLoadingStack() {
      return [...state.stack];
    },
  };

  loaderMap.set(pi, loader);
  return loader;
}
