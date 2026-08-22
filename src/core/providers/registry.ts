import type { HttpProviderConfig } from "../types.js";
import type { TranscriptionProvider } from "../provider.js";
import { createMockProvider } from "./mock.js";
import { createLocalEngineProvider, type LocalEngineProviderConfig } from "./localEngine.js";
import { createHttpProvider } from "./httpProvider.js";

export type ProviderSettings = {
  httpProvider: unknown;
  localEngine: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function normalizeLocalEngineConfig(raw: unknown): LocalEngineProviderConfig {
  const record = asRecord(raw);
  const config: LocalEngineProviderConfig = {};
  if (!record) return config;
  if (typeof record.enginePath === "string") config.enginePath = record.enginePath;
  if (typeof record.modelArgs === "string") config.modelArgs = record.modelArgs;
  if (Array.isArray(record.extraArgs)) {
    config.extraArgs = record.extraArgs.filter((arg): arg is string => typeof arg === "string");
  }
  if (typeof record.tempDir === "string") config.tempDir = record.tempDir;
  return config;
}

export function getMockProvider(): TranscriptionProvider {
  return createMockProvider();
}

export function buildProviders(settings: ProviderSettings): TranscriptionProvider[] {
  const providers: TranscriptionProvider[] = [getMockProvider()];
  providers.push(createLocalEngineProvider(normalizeLocalEngineConfig(settings.localEngine)));
  if (asRecord(settings.httpProvider) !== null) {
    providers.push(createHttpProvider(settings.httpProvider as HttpProviderConfig));
  }
  return providers;
}

export function getProviderById(
  providers: readonly TranscriptionProvider[],
  id: string,
): TranscriptionProvider | undefined {
  return providers.find((provider) => provider.id === id);
}
