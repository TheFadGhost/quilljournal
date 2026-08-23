import { StorageError } from "./errors.js";

export const KDF_ITERATIONS = 650_000;

const MAGIC_TEXT = "QJENC1";
const MAGIC_BYTES = new TextEncoder().encode(MAGIC_TEXT);
const IV_BYTES = 12;

export interface Envelope {
  iv: Uint8Array;
  ct: Uint8Array;
}

type SubtleApi = typeof crypto.subtle;
export type AesKey = Awaited<ReturnType<SubtleApi["deriveKey"]>>;

export function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

function arrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
}

export async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<AesKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    arrayBufferView(new TextEncoder().encode(passphrase)),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: arrayBufferView(salt), iterations },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encrypt(key: AesKey, plaintext: Uint8Array): Promise<Envelope> {
  const iv = randomBytes(IV_BYTES);
  const buf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: arrayBufferView(iv) },
    key,
    arrayBufferView(plaintext),
  );
  return { iv, ct: new Uint8Array(buf) };
}

export async function decrypt(key: AesKey, iv: Uint8Array, ct: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: arrayBufferView(iv) },
    key,
    arrayBufferView(ct),
  );
  return new Uint8Array(buf);
}

export function encodeEnvelope(envelope: Envelope): Uint8Array {
  const out = new Uint8Array(MAGIC_BYTES.length + envelope.iv.length + envelope.ct.length);
  out.set(MAGIC_BYTES, 0);
  out.set(envelope.iv, MAGIC_BYTES.length);
  out.set(envelope.ct, MAGIC_BYTES.length + envelope.iv.length);
  return out;
}

export function decodeEnvelope(bytes: Uint8Array): Envelope {
  if (bytes.length < MAGIC_BYTES.length + IV_BYTES || !hasMagic(bytes)) {
    throw new StorageError(
      "corrupt",
      `not a quilljournal encrypted envelope (${bytes.length} bytes)`,
    );
  }
  const ivStart = MAGIC_BYTES.length;
  const ivEnd = ivStart + IV_BYTES;
  return {
    iv: bytes.slice(ivStart, ivEnd),
    ct: bytes.slice(ivEnd),
  };
}

function hasMagic(bytes: Uint8Array): boolean {
  for (let i = 0; i < MAGIC_BYTES.length; i++) {
    if (bytes[i] !== MAGIC_BYTES[i]) return false;
  }
  return true;
}

export function hasEnvelopeMagic(bytes: Uint8Array): boolean {
  return hasMagic(bytes);
}
