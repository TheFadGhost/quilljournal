export type TranscriptionErrorCode =
  | "no-audio-device"
  | "permission-denied"
  | "device-lost"
  | "unsupported-format"
  | "provider-unavailable"
  | "audio-too-long"
  | "cancelled"
  | "invalid-config"
  | "unknown";

const CODES: readonly TranscriptionErrorCode[] = [
  "no-audio-device",
  "permission-denied",
  "device-lost",
  "unsupported-format",
  "provider-unavailable",
  "audio-too-long",
  "cancelled",
  "invalid-config",
  "unknown",
];

export class TranscriptionError extends Error {
  readonly code: TranscriptionErrorCode;
  constructor(code: TranscriptionErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "TranscriptionError";
    this.code = code;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
  static is(value: unknown): value is TranscriptionError {
    return value instanceof TranscriptionError && CODES.includes(value.code);
  }
}

export type StorageErrorKind =
  | "io"
  | "corrupt"
  | "locked"
  | "wrong-passphrase"
  | "not-found";

export class StorageError extends Error {
  readonly kind: StorageErrorKind;
  constructor(kind: StorageErrorKind, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "StorageError";
    this.kind = kind;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
  static is(value: unknown): value is StorageError {
    return value instanceof StorageError;
  }
}
