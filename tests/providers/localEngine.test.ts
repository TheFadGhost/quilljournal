import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TranscriptionError } from "../../src/core/errors.js";
import {
  createLocalEngineProvider,
  type LocalEngineProviderConfig,
} from "../../src/core/providers/localEngine.js";
import { runProviderConformance, syntheticAudio } from "../conformance/suite.js";

const fixturePath = fileURLToPath(new URL("../fixtures/fake-engine.mjs", import.meta.url));
const tmpRoot = fileURLToPath(new URL("../.tmp/le/", import.meta.url));
const CANNED_TEXT = "The kettle warmed slowly while rain tapped against the window.";

function makeEngineProvider(scenario: string): ReturnType<typeof createLocalEngineProvider> {
  const config: LocalEngineProviderConfig = {
    enginePath: process.execPath,
    modelArgs: `"${fixturePath}"`,
    extraArgs: [`--qj-scenario=${scenario}`],
    tempDir: tmpRoot,
  };
  return createLocalEngineProvider(config);
}

const okProvider = makeEngineProvider("ok");

runProviderConformance(
  "local-engine",
  (scenario) =>
    scenario === "broken"
      ? createLocalEngineProvider({ enginePath: path.join(tmpRoot, "missing", "engine.exe") })
      : okProvider,
  {
    textFor: () => CANNED_TEXT,
  },
);

async function assertTempEmpty(): Promise<void> {
  const entries = await readdir(tmpRoot);
  expect(entries).toHaveLength(0);
}

describe("local engine provider", () => {
  beforeAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
    await mkdir(tmpRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("transcribes through the fake engine and cleans its temp file", async () => {
    const session = okProvider.createSession(syntheticAudio("ok"));
    const result = await session.finalize();
    expect(result.text).toBe(CANNED_TEXT);
    await assertTempEmpty();
  });

  it("rejects garbage engine output without fabricating text", async () => {
    const garbageProvider = makeEngineProvider("garbage");
    const session = garbageProvider.createSession(syntheticAudio("garbage"));
    let failure: unknown = null;
    try {
      await session.finalize();
    } catch (error) {
      failure = error;
    }
    expect(TranscriptionError.is(failure)).toBe(true);
    expect(failure instanceof TranscriptionError ? failure.code : null).toBe("provider-unavailable");
    expect(
      failure instanceof TranscriptionError ? failure.message : "",
    ).toBe("could not parse engine output");
    await assertTempEmpty();
  });

  it("maps a non-zero engine exit to provider-unavailable with the stderr tail", async () => {
    const crashProvider = makeEngineProvider("crash");
    const session = crashProvider.createSession(syntheticAudio("crash"));
    await expect(session.finalize()).rejects.toSatisfy((error: unknown) => {
      if (!TranscriptionError.is(error)) return false;
      expect(error.code).toBe("provider-unavailable");
      expect(error.message).toContain("engine exploded on purpose");
      expect(error.message.length).toBeLessThanOrEqual(300);
      return true;
    });
    await assertTempEmpty();
  });

  it("reports unavailable when the configured engine path does not exist", async () => {
    const missing = path.join(tmpRoot, "missing", "engine.exe");
    const missingProvider = createLocalEngineProvider({ enginePath: missing });
    expect(await missingProvider.isAvailable()).toBe(false);
  });

  it("finds engine candidates on PATH by stem name including .exe", async () => {
    const fakeBin = path.join(tmpRoot, "bin");
    await mkdir(fakeBin, { recursive: true });
    await writeFile(path.join(fakeBin, "whisper-cli.exe"), "");
    const originalPath = process.env.PATH ?? "";
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath}`;
    try {
      const scanner = createLocalEngineProvider({});
      expect(await scanner.isAvailable()).toBe(true);
    } finally {
      process.env.PATH = originalPath;
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  it("rejects unsupported mime types as unsupported-format", async () => {
    const session = okProvider.createSession(syntheticAudio("mime", { mimeType: "text/plain" }));
    await expect(session.finalize()).rejects.toMatchObject({ code: "unsupported-format" });
    await assertTempEmpty();
  });

  it("cancels a running transcription, rejects with cancelled, and cleans up", async () => {
    const slowish = makeEngineProvider("slow");
    const session = slowish.createSession(syntheticAudio("cancel"));
    const finalizeOutcome = session.finalize().catch((error) => error);
    await session.cancel();
    const failure = await finalizeOutcome;
    expect(TranscriptionError.is(failure) ? failure.code : null).toBe("cancelled");
    await assertTempEmpty();
  });
});
