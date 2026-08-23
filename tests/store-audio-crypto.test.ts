import { describe, expect, it } from "vitest";
import { MemFs } from "./helpers/memfs.js";
import { JournalStore } from "../src/core/store/journalStore.js";
import { hasEnvelopeMagic } from "../src/core/crypto.js";

const encoder = new TextEncoder();

async function makeEncryptedJournal() {
  const fs = new MemFs();
  const store = new JournalStore(fs);
  await store.init();
  await store.enableEncryption("correct horse");
  const entry = await store.createEntry({
    dateKey: "2026-03-14",
    title: "Sealed audio",
    body: "spoken notes follow",
  });
  const audioPath = await store.beginAudio(entry.id, "audio/webm");
  return { fs, store, entry, audioPath };
}

describe("audio sealing under encryption", () => {
  it("passes chunks through untouched when encryption is off", async () => {
    const fs = new MemFs();
    const store = new JournalStore(fs);
    await store.init();
    const chunk = encoder.encode("raw webm bytes");
    const sealed = await store.sealAudioChunk(chunk);
    expect(Array.from(sealed)).toEqual(Array.from(chunk));
  });

  it("seals chunks as length-framed envelopes and consolidates to one envelope", async () => {
    const { fs, store, entry, audioPath } = await makeEncryptedJournal();
    const part1 = encoder.encode("1a45dfa3-header-bytes");
    const part2 = encoder.encode("cluster-payload-continues-here");
    for (const part of [part1, part2]) {
      await store.appendAudioChunk(audioPath, part);
    }
    const sealedOnDisk = await fs.readFile(audioPath);
    expect(hasEnvelopeMagic(sealedOnDisk)).toBe(false);
    expect(new TextDecoder().decode(sealedOnDisk)).not.toContain("header-bytes");

    await store.consolidateAudioFile(audioPath);
    const consolidated = await fs.readFile(audioPath);
    expect(hasEnvelopeMagic(consolidated)).toBe(true);
    expect(new TextDecoder().decode(consolidated)).not.toContain("cluster-payload");

    const plain = await store.readAudio(audioPath);
    expect(Array.from(plain)).toEqual(Array.from(new Uint8Array([...part1, ...part2])));

    await store.setEntryAudio(entry.id, {
      storedPath: audioPath,
      mimeType: "audio/webm",
      durationMs: 4200,
      transcript: null,
    });
    const stored = await store.getEntry(entry.id);
    expect(stored.audio?.storedPath).toBe(audioPath);
    expect(
      await store.readAudio((stored.audio as { storedPath: string }).storedPath),
    ).toEqual(plain);
  });

  it("consolidate is a no-op on already-consolidated files", async () => {
    const { store, audioPath } = await makeEncryptedJournal();
    await expect(store.consolidateAudioFile(audioPath)).resolves.toBeUndefined();
  });
});

describe("disableEncryption", () => {
  it("rejects a wrong passphrase without mutating anything", async () => {
    const { fs, store, audioPath } = await makeEncryptedJournal();
    const manifestBefore = await fs.readFile("manifest.json");
    const audioBefore = await fs.readFile(audioPath);
    await expect(store.disableEncryption("wrong")).rejects.toMatchObject({
      kind: "wrong-passphrase",
    });
    expect(store.isEncrypted()).toBe(true);
    expect(await fs.readFile("manifest.json")).toEqual(manifestBefore);
    expect(await fs.readFile(audioPath)).toEqual(audioBefore);
  });

  it("decrypts entries, attachments and audio in place and clears the manifest block", async () => {
    const { fs, store, entry, audioPath } = await makeEncryptedJournal();
    const att = await store.addAttachment(entry.id, "notes.txt", "text/plain", encoder.encode("attachment-body"));
    await store.disableEncryption("correct horse");
    expect(store.isEncrypted()).toBe(false);
    const manifestRaw = new TextDecoder().decode(await fs.readFile("manifest.json"));
    expect(manifestRaw.includes('"encryption": {')).toBe(false);
    expect(new TextDecoder().decode(await fs.readFile(`entries/${entry.id}.json`))).toContain(
      "spoken notes follow",
    );
    expect(new TextDecoder().decode(await fs.readFile(att.storedPath))).toContain(
      "attachment-body",
    );
    expect(await store.readAudio(audioPath)).toEqual(new Uint8Array());
  });

  it("recovers after a simulated crash mid-decryption via the transitioning flag", async () => {
    const { fs, store, entry } = await makeEncryptedJournal();
    fs.setFault({ failAt: "after-write-before-rename", once: true });
    await expect(store.disableEncryption("correct horse")).rejects.toThrow(/simulated-crash/);

    const reopened = new JournalStore(fs);
    await reopened.init();
    expect(reopened.isEncrypted()).toBe(true);
    await reopened.unlock("correct horse");
    const stillReadable = await reopened.getEntry(entry.id);
    expect(stillReadable.body).toBe("spoken notes follow");

    await reopened.disableEncryption("correct horse");
    expect(reopened.isEncrypted()).toBe(false);
    const raw = new TextDecoder().decode(await fs.readFile(`entries/${entry.id}.json`));
    expect(raw).toContain("spoken notes follow");
  });
});

describe("changePassphrase", () => {
  it("rotates the key and keeps all content intact", async () => {
    const { fs, store, entry, audioPath } = await makeEncryptedJournal();
    await store.changePassphrase("correct horse", "new passphrase 9");
    expect(store.isUnlocked()).toBe(true);
    await store.lock();
    await expect(store.unlock("correct horse")).rejects.toMatchObject({
      kind: "wrong-passphrase",
    });
    await store.unlock("new passphrase 9");
    const loaded = await store.getEntry(entry.id);
    expect(loaded.title).toBe("Sealed audio");
    expect(await store.readAudio(audioPath)).toEqual(new Uint8Array());
    const rawManifest = JSON.parse(
      new TextDecoder().decode(await fs.readFile("manifest.json")),
    ) as { encryption: { saltB64: string } | null };
    expect(rawManifest.encryption).not.toBeNull();
  });
});
