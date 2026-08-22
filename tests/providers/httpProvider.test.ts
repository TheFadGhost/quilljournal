import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { TranscriptionError } from "../../src/core/errors.js";
import { createHttpProvider } from "../../src/core/providers/httpProvider.js";
import type { HttpProviderConfig } from "../../src/core/types.js";
import { runProviderConformance, syntheticAudio } from "../conformance/suite.js";

const ECHO_TEXT = "Rain moved across the roof and the cat slept through all of it.";

async function startServer(handler: http.RequestListener): Promise<{ server: http.Server; url: string }> {
  const srv = http.createServer(handler);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  const address = srv.address() as AddressInfo;
  return { server: srv, url: `http://127.0.0.1:${address.port}` };
}

let server: http.Server | null = null;
let baseUrl = "";
let refusedUrl = "";
let capturedBodies: Buffer[][] = [];

beforeAll(async () => {
  const echoServer = await startServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      capturedBodies.push(chunks);
      const url = new URL(req.url ?? "/", "http://localhost");
      const respondJson = (body: string) => {
        res.setHeader("Content-Type", "application/json");
        res.end(body);
      };
      if (url.pathname === "/fail") {
        res.statusCode = 500;
        res.end("boom");
        return;
      }
      if (url.pathname === "/malformed") {
        respondJson("{not-json-at-all");
        return;
      }
      if (url.pathname === "/badshape") {
        respondJson(JSON.stringify({ text: 42 }));
        return;
      }
      if (url.pathname === "/slow") {
        setTimeout(() => {
          respondJson(JSON.stringify({ text: ECHO_TEXT }));
        }, 250);
        return;
      }
      respondJson(JSON.stringify({ text: ECHO_TEXT, language: "en" }));
    });
  });
  server = echoServer.server;
  baseUrl = echoServer.url;
  const refused = await startServer(() => undefined);
  refusedUrl = refused.url;
  await new Promise<void>((resolve, reject) =>
    refused.server.close((err) => (err ? reject(err) : resolve())),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    if (!server) return resolve();
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

function makeHttpProvider(scenario: string): ReturnType<typeof createHttpProvider> {
  if (scenario === "broken") return createHttpProvider({ endpointUrl: "" });
  const routes: Record<string, string> = {
    fail: "/fail",
    malformed: "/malformed",
    badshape: "/badshape",
    slow: "/slow",
  };
  const route = routes[scenario] ?? "/";
  const config: HttpProviderConfig = {
    endpointUrl: `${baseUrl}${route}`,
    headers: { "X-QJ-Test": "1" },
  };
  return createHttpProvider(config);
}

runProviderConformance("http", (scenario) => makeHttpProvider(scenario), {
  textFor: () => ECHO_TEXT,
});

describe("http provider", () => {
  it("posts raw audio bytes as the request body", async () => {
    const provider = makeHttpProvider("ok");
    capturedBodies = [];
    const session = provider.createSession(syntheticAudio("ok"));
    const result = await session.finalize();
    expect(result.text).toBe(ECHO_TEXT);
    expect(result.words).toBeUndefined();
    const posted = capturedBodies.at(-1) ?? [];
    expect(Buffer.concat(posted).length).toBe(512);
  });

  it("maps HTTP 500 to provider-unavailable", async () => {
    const provider = makeHttpProvider("fail");
    const session = provider.createSession(syntheticAudio("fail"));
    await expect(session.finalize()).rejects.toSatisfy((error: unknown) => {
      if (!TranscriptionError.is(error)) return false;
      expect(error.code).toBe("provider-unavailable");
      expect(error.message).toBe("HTTP 500");
      return true;
    });
  });

  it("maps malformed JSON to unknown without inventing text", async () => {
    const provider = makeHttpProvider("malformed");
    const session = provider.createSession(syntheticAudio("malformed"));
    await expect(session.finalize()).rejects.toMatchObject({
      code: "unknown",
      message: "provider returned malformed response",
    });
  });

  it("rejects responses whose shape is wrong even when JSON parses", async () => {
    const provider = makeHttpProvider("badshape");
    const session = provider.createSession(syntheticAudio("badshape"));
    await expect(session.finalize()).rejects.toMatchObject({ code: "unknown" });
  });

  it("maps connection-refused endpoints to provider-unavailable", async () => {
    const provider = createHttpProvider({ endpointUrl: refusedUrl });
    const session = provider.createSession(syntheticAudio("refused"));
    await expect(session.finalize()).rejects.toMatchObject({ code: "provider-unavailable" });
  });

  it("cancels an in-flight request and rejects with cancelled", async () => {
    const provider = makeHttpProvider("slow");
    const session = provider.createSession(syntheticAudio("cancel"));
    const finalizeOutcome = session.finalize().catch((error) => error);
    await session.cancel();
    const failure = await finalizeOutcome;
    expect(TranscriptionError.is(failure) ? failure.code : null).toBe("cancelled");
  });

  it("throws invalid-config synchronously for an empty endpoint and fires onError once", () => {
    let onErrorCount = 0;
    let thrown: unknown = null;
    try {
      createHttpProvider({ endpointUrl: "" }).createSession(syntheticAudio("broken"), {
        onError: () => {
          onErrorCount++;
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(TranscriptionError.is(thrown)).toBe(true);
    expect(thrown instanceof TranscriptionError ? thrown.code : null).toBe("invalid-config");
    expect(onErrorCount).toBe(1);
  });
});
