import { useEffect, useRef, useState } from "react";

interface LockOverlayProps {
  passphraseRequired: boolean;
  onUnlock: (passphrase: string) => Promise<void>;
  onDismiss: () => void;
}

export function LockOverlay({ passphraseRequired, onUnlock, onDismiss }: LockOverlayProps) {
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dismissRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (passphraseRequired) {
      inputRef.current?.focus();
    } else {
      dismissRef.current?.focus();
    }
  }, [passphraseRequired]);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onUnlock(passphrase);
    } catch {
      setError("Incorrect passphrase.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lock-overlay">
      <section className="lock-card" role="dialog" aria-modal="true" aria-label="Journal locked">
        <h2 className="modal-title">Journal locked</h2>
        {passphraseRequired ? (
          <>
            <p style={{ margin: 0, color: "var(--ink-mid)" }}>
              This journal is encrypted. Enter your passphrase to continue.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
              style={{ display: "grid", gap: "var(--space-3)" }}
            >
              <input
                ref={inputRef}
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                aria-label="Passphrase"
                autoComplete="off"
              />
              {error ? (
                <p role="alert" className="lock-error">
                  {error}
                </p>
              ) : null}
              <button type="submit" className="btn btn-primary" disabled={busy}>
                Unlock
              </button>
            </form>
          </>
        ) : (
          <>
            <p style={{ margin: 0, color: "var(--ink-mid)" }}>
              Locked after a period of inactivity.
            </p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onDismiss}
              ref={dismissRef}
            >
              Unlock
            </button>
          </>
        )}
      </section>
    </div>
  );
}
