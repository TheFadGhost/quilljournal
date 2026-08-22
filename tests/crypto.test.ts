import { describe, expect, it } from "vitest";
import {
  KDF_ITERATIONS,
  decodeEnvelope,
  decrypt,
  deriveKey,
  encodeEnvelope,
  encrypt,
  randomBytes,
} from "../src/core/crypto.js";
import { StorageError } from "../src/core/errors.js";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("crypto: key derivation", () => {
  it("derives a non-extractable 256-bit AES-GCM key using the documented PBKDF2-SHA-256 iteration count", async () => {
    expect(KDF_ITERATIONS).toBe(650_000);
    const salt = randomBytes(16);
    expect(salt).toHaveLength(16);
    const key = await deriveKey("correct horse battery staple", salt, KDF_ITERATIONS);
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect(key.extractable).toBe(false);
    expect([...key.usages].sort()).toEqual(["decrypt", "encrypt"]);
  });
});

describe("crypto: AES-256-GCM round trips", () => {
  it("round-trips multibyte unicode text byte-exactly through encrypt then decrypt", async () => {
    const key = await deriveKey("passphrase-one", randomBytes(16), KDF_ITERATIONS);
    const message = "héllo — ünïcode ✓ 日本語 🌊 tail";
    const plaintext = new TextEncoder().encode(message);
    const { iv, ct } = await encrypt(key, plaintext);
    expect(iv).toHaveLength(12);
    const restored = await decrypt(key, iv, ct);
    expect(Array.from(restored)).toEqual(Array.from(plaintext));
    expect(new TextDecoder().decode(restored)).toBe(message);
  });

  it("produces a fresh IV and different ciphertext for every encryption of identical plaintext", async () => {
    const key = await deriveKey("nonce-check", randomBytes(16), 10_000);
    const plaintext = new TextEncoder().encode("the same words every time");
    const first = await encrypt(key, plaintext);
    const second = await encrypt(key, plaintext);
    expect(first.iv).toHaveLength(12);
    expect(second.iv).toHaveLength(12);
    expect(hex(first.iv)).not.toBe(hex(second.iv));
    expect(hex(first.ct)).not.toBe(hex(second.ct));
  });

  it("rejects decryption under a key derived from a different passphrase with no partial plaintext", async () => {
    const salt = randomBytes(16);
    const rightKey = await deriveKey("right-passphrase", salt, KDF_ITERATIONS);
    const wrongKey = await deriveKey("wrong-passphrase", salt, KDF_ITERATIONS);
    const { iv, ct } = await encrypt(rightKey, new TextEncoder().encode("secret diary text"));
    await expect(decrypt(wrongKey, iv, ct)).rejects.toThrow();
    let leaked: Uint8Array | null = null;
    try {
      leaked = await decrypt(wrongKey, iv, ct);
    } catch (caught) {
      expect(caught).toBeInstanceOf(Error);
    }
    expect(leaked).toBeNull();
  });

  it("detects a single tampered ciphertext byte through authentication failure", async () => {
    const key = await deriveKey("tamper-check", randomBytes(16), 10_000);
    const { iv, ct } = await encrypt(key, new TextEncoder().encode("tamper target text"));
    const tampered = ct.slice();
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    await expect(decrypt(key, iv, tampered)).rejects.toThrow();
  });

  it("round-trips an empty plaintext and yields exactly the GCM tag as ciphertext", async () => {
    const key = await deriveKey("empty-check", randomBytes(16), 10_000);
    const { iv, ct } = await encrypt(key, new Uint8Array(0));
    expect(ct).toHaveLength(16);
    const restored = await decrypt(key, iv, ct);
    expect(restored).toHaveLength(0);
    const decoded = decodeEnvelope(encodeEnvelope({ iv, ct }));
    expect(hex(decoded.iv)).toBe(hex(iv));
    expect(hex(decoded.ct)).toBe(hex(ct));
  });
});

describe("crypto: envelope codec", () => {
  it("encodes the QJENC1 layout of magic followed by iv followed by ciphertext", () => {
    const iv = randomBytes(12);
    const ct = randomBytes(7);
    const envelope = encodeEnvelope({ iv, ct });
    expect(envelope).toHaveLength(6 + 12 + 7);
    expect(new TextDecoder().decode(envelope.slice(0, 6))).toBe("QJENC1");
    expect(hex(envelope.slice(6, 18))).toBe(hex(iv));
    expect(hex(envelope.slice(18))).toBe(hex(ct));
    const decoded = decodeEnvelope(envelope);
    expect(hex(decoded.iv)).toBe(hex(iv));
    expect(hex(decoded.ct)).toBe(hex(ct));
  });

  it("throws StorageError kind corrupt for bytes without the magic header", () => {
    const garbage = randomBytes(48);
    let caught: unknown;
    try {
      decodeEnvelope(garbage);
      expect.unreachable("decodeEnvelope should have thrown");
    } catch (error) {
      caught = error;
    }
    expect(StorageError.is(caught)).toBe(true);
    expect((caught as StorageError).kind).toBe("corrupt");
  });

  it("throws StorageError kind corrupt for truncated envelopes at magic and iv boundaries", () => {
    const envelope = encodeEnvelope({ iv: randomBytes(12), ct: randomBytes(20) });
    for (const cut of [0, 5, 6, 17]) {
      let caught: unknown;
      try {
        decodeEnvelope(envelope.slice(0, cut));
        expect.unreachable(`decodeEnvelope should have thrown at ${cut} bytes`);
      } catch (error) {
        caught = error;
      }
      expect(StorageError.is(caught)).toBe(true);
      expect((caught as StorageError).kind).toBe("corrupt");
    }
    expect(() => decodeEnvelope(envelope.slice(0, envelope.length))).not.toThrow();
  });
});
