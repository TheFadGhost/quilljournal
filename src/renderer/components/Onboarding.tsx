interface OnboardingProps {
  storageLocation: string;
  promptsEnabled: boolean;
  onPromptsChange: (enabled: boolean) => void;
  onBegin: () => void;
}

export function Onboarding({
  storageLocation,
  promptsEnabled,
  onPromptsChange,
  onBegin,
}: OnboardingProps) {
  return (
    <div className="onboarding">
      <section className="onboarding-card" aria-labelledby="onboarding-heading">
        <h1 id="onboarding-heading">Quilljournal</h1>
        <p>
          A private journal that stays on this machine. There is no account, no telemetry, and no
          network access unless you configure an HTTP transcription provider yourself.
        </p>
        <h2>Where your writing lives</h2>
        <p className="storage-path">{storageLocation}</p>
        <p>
          Every entry is stored as a plain file at the location above, with full revision history.
          You can copy, back up, or read your files at any time.
        </p>
        <h2>Transcription</h2>
        <p>
          Dictation runs through an offline mock provider by default, so every feature works
          without leaving your machine. A local transcription engine and a self-configured HTTP
          endpoint are available opt-in from Settings.
        </p>
        <div className="checkbox-line">
          <input
            id="onboarding-prompts"
            type="checkbox"
            checked={promptsEnabled}
            onChange={(e) => onPromptsChange(e.target.checked)}
          />
          <label htmlFor="onboarding-prompts">Offer an optional writing prompt each day</label>
        </div>
        <h2>Encryption</h2>
        <p>
          The journal can be encrypted with a passphrase. Encryption is off by default and can be
          enabled later in Settings.
        </p>
        <div>
          <button type="button" className="btn btn-primary" onClick={onBegin}>
            Begin
          </button>
        </div>
      </section>
    </div>
  );
}
