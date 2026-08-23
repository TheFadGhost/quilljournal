import { useEffect, useState } from "react";
import type { ThemeName, AppSettings } from "../../core/types.js";
import { buildProviders } from "../../core/providers/registry.js";
import { getQuillRaw, ipc } from "../ipc/rendererBridge.js";

export const APP_VERSION = "0.1.0";

export type ExportKind = "markdown" | "archive" | "printable";

const THEMES: readonly { id: ThemeName; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "night", label: "Night" },
  { id: "high-contrast", label: "High contrast" },
];

interface SettingsViewProps {
  settings: AppSettings;
  storageLocation: string;
  encryptionEnabled: boolean;
  encryptionUnlocked: boolean;
  onUpdateSettings(patch: Partial<AppSettings>): void;
  onEnableEncryption(passphrase: string): Promise<void>;
  onDisableEncryption(passphrase: string): Promise<void>;
  onChangePassphrase(oldPassphrase: string, newPassphrase: string): Promise<void>;
  onLock(): void;
  onExport(kind: ExportKind): Promise<string>;
  onRevealStorage(): Promise<void>;
}

interface StatusLine {
  ok: boolean;
  text: string;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function headersToJson(headers: Record<string, string> | undefined): string {
  if (!headers || Object.keys(headers).length === 0) return "{}";
  return JSON.stringify(headers, null, 2);
}

export function SettingsView({
  settings,
  storageLocation,
  encryptionEnabled,
  encryptionUnlocked,
  onUpdateSettings,
  onEnableEncryption,
  onDisableEncryption,
  onChangePassphrase,
  onLock,
  onExport,
  onRevealStorage,
}: SettingsViewProps) {
  const [localAvailable, setLocalAvailable] = useState<boolean | null>(null);
  const [enginePath, setEnginePath] = useState(settings.localEngine.enginePath ?? "");
  const [modelArgs, setModelArgs] = useState(settings.localEngine.modelArgs ?? "");
  const [endpointUrl, setEndpointUrl] = useState(settings.httpProvider?.endpointUrl ?? "");
  const [timeoutMs, setTimeoutMs] = useState(
    settings.httpProvider?.timeoutMs === undefined ? "" : String(settings.httpProvider.timeoutMs),
  );
  const [headersJson, setHeadersJson] = useState(() =>
    headersToJson(settings.httpProvider?.headers),
  );
  const [headersError, setHeadersError] = useState<string | null>(null);
  const [idleDraft, setIdleDraft] = useState(
    settings.idleLockMinutes === null ? "" : String(settings.idleLockMinutes),
  );
  const [promptDraft, setPromptDraft] = useState("");
  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");
  const [understandPhrase, setUnderstandPhrase] = useState("");
  const [encryptionBusy, setEncryptionBusy] = useState(false);
  const [encryptionError, setEncryptionError] = useState<string | null>(null);
  const [changeOld, setChangeOld] = useState("");
  const [changeNew, setChangeNew] = useState("");
  const [changeConfirm, setChangeConfirm] = useState("");
  const [disablePass, setDisablePass] = useState("");
  const [disablePhrase, setDisablePhrase] = useState("");
  const [shortcutDraft, setShortcutDraft] = useState(settings.globalNewEntryShortcut);
  const [shortcutStatus, setShortcutStatus] = useState<StatusLine | null>(null);
  const [storageStatus, setStorageStatus] = useState<StatusLine | null>(null);
  const [exportStatus, setExportStatus] = useState<StatusLine | null>(null);
  const [revealStatus, setRevealStatus] = useState<StatusLine | null>(null);

  useEffect(() => {
    let cancelled = false;
    const providers = buildProviders({
      httpProvider: settings.httpProvider,
      localEngine: settings.localEngine,
    });
    const engine = providers.find((p) => p.id === "local-engine");
    void (engine ? engine.isAvailable() : Promise.resolve(false)).then((value) => {
      if (!cancelled) setLocalAvailable(value);
    });
    return () => {
      cancelled = true;
    };
  }, [settings.localEngine]);

  const patchHttpProvider = (
    endpoint: string,
    headersValid: Record<string, string> | null,
    timeout: number | undefined,
  ) => {
    if (endpoint.trim().length === 0 && headersValid === null) {
      onUpdateSettings({ httpProvider: null });
      return;
    }
    onUpdateSettings({
      httpProvider: {
        endpointUrl: endpoint,
        ...(headersValid !== null ? { headers: headersValid } : {}),
        ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
      },
    });
  };

  const onHeadersChange = (value: string) => {
    setHeadersJson(value);
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      setHeadersError("Headers must be valid JSON.");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setHeadersError("Headers must be a JSON object mapping names to strings.");
      return;
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (!entries.every(([, v]) => typeof v === "string")) {
      setHeadersError("Header values must be strings.");
      return;
    }
    setHeadersError(null);
    patchHttpProvider(endpointUrl, parsed as Record<string, string>, parseTimeout(timeoutMs));
  };

  function parseTimeout(raw: string): number | undefined {
    if (raw.trim().length === 0) return undefined;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  const applyShortcut = async () => {
    const value = shortcutDraft.trim();
    if (value.length === 0) return;
    try {
      const ok = await ipc.registerGlobalShortcut(value);
      if (ok) {
        onUpdateSettings({ globalNewEntryShortcut: value });
        setShortcutStatus({ ok: true, text: "Global shortcut applied." });
      } else {
        setShortcutStatus({ ok: false, text: "That accelerator could not be registered." });
      }
    } catch (err) {
      setShortcutStatus({ ok: false, text: messageOf(err) });
    }
  };

  const changeStorage = async () => {
    setStorageStatus(null);
    try {
      const picked = await getQuillRaw().invoke("app:pick-dir");
      if (typeof picked !== "string" || picked.length === 0) return;
      await getQuillRaw().invoke("app:set-storage", picked);
      setStorageStatus({ ok: true, text: `Storage will move to ${picked} after restart.` });
    } catch (err) {
      setStorageStatus({ ok: false, text: messageOf(err) });
    }
  };

  const runExport = async (kind: ExportKind) => {
    setExportStatus(null);
    try {
      const folder = await onExport(kind);
      setExportStatus({ ok: true, text: `Exported to ${folder}/` });
    } catch (err) {
      setExportStatus({ ok: false, text: messageOf(err) });
    }
  };

  const reveal = async () => {
    try {
      await onRevealStorage();
      setRevealStatus({ ok: true, text: "Opened the storage folder." });
    } catch (err) {
      setRevealStatus({ ok: false, text: messageOf(err) });
    }
  };

  const enableEncryption = async () => {
    if (encryptionBusy) return;
    setEncryptionBusy(true);
    setEncryptionError(null);
    try {
      await onEnableEncryption(pass1);
      setPass1("");
      setPass2("");
      setUnderstandPhrase("");
    } catch (err) {
      setEncryptionError(messageOf(err));
    } finally {
      setEncryptionBusy(false);
    }
  };

  const passwordsMatch = pass1.length > 0 && pass1 === pass2;
  const understands = understandPhrase === "I understand";

  return (
    <section className="view-section" data-view="settings" aria-label="Settings">
      <h2 className="view-heading">Settings</h2>

      <h3 className="quiet-heading">Appearance</h3>
      <div role="radiogroup" aria-label="Theme">
        {THEMES.map((theme) => (
          <label key={theme.id} className="radio-line">
            <input
              type="radio"
              name="theme"
              checked={settings.theme === theme.id}
              onChange={() => onUpdateSettings({ theme: theme.id })}
            />
            {theme.label}
          </label>
        ))}
      </div>
      <label className="settings-row">
        Font size
        <input
          type="range"
          min={16}
          max={24}
          step={1}
          value={settings.fontSizePx}
          aria-label="Font size in pixels"
          onChange={(e) => onUpdateSettings({ fontSizePx: Number.parseInt(e.target.value, 10) })}
        />
        <span className="range-value">{`${settings.fontSizePx}px`}</span>
      </label>
      <label className="settings-row">
        Measure
        <input
          type="range"
          min={48}
          max={80}
          step={2}
          value={settings.measureCh}
          aria-label="Line measure in characters"
          onChange={(e) => onUpdateSettings({ measureCh: Number.parseInt(e.target.value, 10) })}
        />
        <span className="range-value">{`${settings.measureCh}ch`}</span>
      </label>

      <h3 className="quiet-heading">Writing</h3>
      <label className="settings-row">
        Idle lock after (minutes)
        <input
          type="number"
          min={0}
          value={idleDraft}
          placeholder="off"
          aria-label="Idle lock minutes"
          onChange={(e) => {
            const raw = e.target.value.trim();
            setIdleDraft(raw);
            if (raw.length === 0) {
              onUpdateSettings({ idleLockMinutes: null });
              return;
            }
            const n = Number.parseInt(raw, 10);
            if (Number.isFinite(n) && n >= 0) onUpdateSettings({ idleLockMinutes: n });
          }}
        />
        <span className="settings-note">Empty means idle lock is off.</span>
      </label>
      <label className="checkbox-line">
        <input
          type="checkbox"
          checked={settings.discardAudioAfterTranscriptionDefault}
          onChange={(e) =>
            onUpdateSettings({ discardAudioAfterTranscriptionDefault: e.target.checked })
          }
        />
        Discard audio by default after committing a transcript
      </label>

      <h3 className="quiet-heading">Prompts</h3>
      <label className="checkbox-line">
        <input
          type="checkbox"
          checked={settings.promptsEnabled}
          onChange={(e) => onUpdateSettings({ promptsEnabled: e.target.checked })}
        />
        Show a writing prompt on empty days
      </label>
      <form
        className="settings-row"
        onSubmit={(e) => {
          e.preventDefault();
          const value = promptDraft.trim();
          if (value.length === 0) return;
          if (!settings.userPrompts.includes(value)) {
            onUpdateSettings({ userPrompts: [...settings.userPrompts, value] });
          }
          setPromptDraft("");
        }}
      >
        <input
          type="text"
          value={promptDraft}
          placeholder="Add your own prompt"
          aria-label="New user prompt"
          onChange={(e) => setPromptDraft(e.target.value)}
        />
        <button type="submit" className="btn btn-outline">
          Add prompt
        </button>
      </form>
      {settings.userPrompts.map((prompt) => (
        <div key={prompt} className="settings-row">
          <span>{prompt}</span>
          <button
            type="button"
            className="chip-remove"
            aria-label={`Remove prompt ${prompt}`}
            onClick={() =>
              onUpdateSettings({ userPrompts: settings.userPrompts.filter((p) => p !== prompt) })
            }
          >
            ×
          </button>
        </div>
      ))}

      <h3 className="quiet-heading">Transcription provider</h3>
      <div role="radiogroup" aria-label="Transcription provider">
        <label className="radio-line">
          <input
            type="radio"
            name="provider"
            checked={settings.providerId === "mock"}
            onChange={() => onUpdateSettings({ providerId: "mock" })}
          />
          Offline mock — always available. Produces scripted transcripts for testing; it never
          performs real speech recognition.
        </label>
        <label className="radio-line">
          <input
            type="radio"
            name="provider"
            checked={settings.providerId === "local-engine"}
            onChange={() => onUpdateSettings({ providerId: "local-engine" })}
          />
          Local engine{" "}
          {localAvailable === null
            ? "(checking…)"
            : localAvailable
              ? "(detected)"
              : "(not detected)"}
        </label>
        <label className="radio-line">
          <input
            type="radio"
            name="provider"
            checked={settings.providerId === "http"}
            onChange={() => onUpdateSettings({ providerId: "http" })}
          />
          HTTP endpoint
        </label>
      </div>
      {settings.providerId === "local-engine" ? (
        <div className="settings-warning" role="note">
          <label className="settings-row">
            Engine path
            <input
              type="text"
              value={enginePath}
              placeholder="Path to a whisper-compatible executable"
              aria-label="Local engine path"
              onChange={(e) => {
                setEnginePath(e.target.value);
                onUpdateSettings({
                  localEngine: { ...settings.localEngine, enginePath: e.target.value },
                });
              }}
            />
          </label>
          <label className="settings-row">
            Model arguments
            <input
              type="text"
              value={modelArgs}
              placeholder="--model base.en"
              aria-label="Local engine model arguments"
              onChange={(e) => {
                setModelArgs(e.target.value);
                onUpdateSettings({
                  localEngine: { ...settings.localEngine, modelArgs: e.target.value },
                });
              }}
            />
          </label>
        </div>
      ) : null}
      {settings.providerId === "http" ? (
        <div className="settings-warning" role="note">
          <p className="settings-note">
            Disabled until configured. Requests go only to the address above.
          </p>
          <label className="settings-row">
            Endpoint URL
            <input
              type="text"
              value={endpointUrl}
              placeholder="https://…"
              aria-label="HTTP endpoint URL"
              onChange={(e) => {
                setEndpointUrl(e.target.value);
                patchHttpProvider(e.target.value, safeParseHeaders(headersJson), parseTimeout(timeoutMs));
              }}
            />
          </label>
          <label className="settings-row">
            Headers (JSON)
            <textarea
              value={headersJson}
              rows={3}
              aria-label="HTTP headers as JSON"
              onChange={(e) => onHeadersChange(e.target.value)}
            />
          </label>
          {headersError ? (
            <p className="settings-status-fail" role="alert">
              {headersError}
            </p>
          ) : null}
          <label className="settings-row">
            Timeout (ms)
            <input
              type="number"
              min={1}
              value={timeoutMs}
              aria-label="HTTP timeout in milliseconds"
              onChange={(e) => {
                setTimeoutMs(e.target.value);
                patchHttpProvider(
                  endpointUrl,
                  safeParseHeaders(headersJson),
                  parseTimeout(e.target.value),
                );
              }}
            />
          </label>
        </div>
      ) : null}

      <h3 className="quiet-heading">Storage</h3>
      <p className="storage-path">{storageLocation}</p>
      <div className="settings-row">
        <button type="button" className="btn btn-outline" onClick={() => void reveal()}>
          Reveal
        </button>
        <button type="button" className="btn btn-outline" onClick={() => void changeStorage()}>
          Change
        </button>
      </div>
      {storageStatus ? (
        <p className={storageStatus.ok ? "settings-status-ok" : "settings-status-fail"} role="status">
          {storageStatus.text}
        </p>
      ) : null}
      <p className="settings-note">Takes effect after restart. The new folder must be empty.</p>
      {revealStatus ? (
        <p className={revealStatus.ok ? "settings-status-ok" : "settings-status-fail"} role="status">
          {revealStatus.text}
        </p>
      ) : null}

      <h3 className="quiet-heading">Global shortcut</h3>
      <div className="settings-row">
        <input
          type="text"
          value={shortcutDraft}
          aria-label="Global new-entry accelerator"
          onChange={(e) => setShortcutDraft(e.target.value)}
        />
        <button type="button" className="btn btn-outline" onClick={() => void applyShortcut()}>
          Apply
        </button>
      </div>
      {shortcutStatus ? (
        <p className={shortcutStatus.ok ? "settings-status-ok" : "settings-status-fail"} role="status">
          {shortcutStatus.text}
        </p>
      ) : null}

      <h3 className="quiet-heading">Encryption</h3>
      {!encryptionEnabled ? (
        <>
          <div className="settings-warning">
            <p className="settings-note">Before you turn this on, know exactly what it does:</p>
            <ul>
              <li>Protects files at rest only.</li>
              <li>Does not protect a running or unlocked system.</li>
              <li>A lost passphrase means permanently lost data.</li>
              <li>The implementation is unaudited.</li>
              <li>PBKDF2-SHA256, 650,000 iterations, AES-256-GCM.</li>
            </ul>
          </div>
          <label className="settings-row">
            Passphrase
            <input
              type="password"
              value={pass1}
              autoComplete="new-password"
              aria-label="New passphrase"
              onChange={(e) => setPass1(e.target.value)}
            />
          </label>
          <label className="settings-row">
            Confirm passphrase
            <input
              type="password"
              value={pass2}
              autoComplete="new-password"
              aria-label="Confirm passphrase"
              onChange={(e) => setPass2(e.target.value)}
            />
          </label>
          {pass2.length > 0 && !passwordsMatch ? (
            <p className="settings-status-fail" role="alert">
              Passphrases do not match.
            </p>
          ) : null}
          <label className="settings-row">
            Type “I understand” to confirm
            <input
              type="text"
              value={understandPhrase}
              aria-label='Type I understand to confirm'
              onChange={(e) => setUnderstandPhrase(e.target.value)}
            />
          </label>
          {encryptionError ? (
            <p className="settings-status-fail" role="alert">
              {encryptionError}
            </p>
          ) : null}
          <div className="settings-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!passwordsMatch || !understands || encryptionBusy}
              onClick={() => void enableEncryption()}
            >
              Enable encryption
            </button>
          </div>
        </>
      ) : (
        <>
      <p className="settings-note">Encryption is on.</p>
      {encryptionUnlocked ? (
        <>
          <div className="settings-row">
            <button type="button" className="btn btn-outline" onClick={onLock}>
              Lock now
            </button>
          </div>
          <h4 className="quiet-heading">Change passphrase</h4>
          <label className="settings-row">
            Current passphrase
            <input
              type="password"
              value={changeOld}
              autoComplete="current-password"
              aria-label="Current passphrase"
              onChange={(e) => setChangeOld(e.target.value)}
            />
          </label>
          <label className="settings-row">
            New passphrase
            <input
              type="password"
              value={changeNew}
              autoComplete="new-password"
              aria-label="New passphrase"
              onChange={(e) => setChangeNew(e.target.value)}
            />
          </label>
          <label className="settings-row">
            Confirm new passphrase
            <input
              type="password"
              value={changeConfirm}
              autoComplete="new-password"
              aria-label="Confirm new passphrase"
              onChange={(e) => setChangeConfirm(e.target.value)}
            />
          </label>
          <div className="settings-row">
            <button
              type="button"
              className="btn btn-outline"
              disabled={
                encryptionBusy ||
                changeOld.length === 0 ||
                changeNew.length === 0 ||
                changeNew !== changeConfirm
              }
              onClick={() => {
                setEncryptionBusy(true);
                setEncryptionError(null);
                void onChangePassphrase(changeOld, changeNew)
                  .then(() => {
                    setChangeOld("");
                    setChangeNew("");
                    setChangeConfirm("");
                  })
                  .catch((err: unknown) => setEncryptionError(messageOf(err)))
                  .finally(() => setEncryptionBusy(false));
              }}
            >
              Change passphrase
            </button>
          </div>
          <h4 className="quiet-heading">Turn off encryption</h4>
          <p className="settings-note">
            Decrypts every entry, attachment and recording on disk. The same warnings apply: this
            protects nothing while the journal is unlocked.
          </p>
          <label className="settings-row">
            Passphrase
            <input
              type="password"
              value={disablePass}
              autoComplete="current-password"
              aria-label="Passphrase to disable encryption"
              onChange={(e) => setDisablePass(e.target.value)}
            />
          </label>
          <label className="settings-row">
            Type “I understand” to confirm
            <input
              type="text"
              value={disablePhrase}
              aria-label="Type I understand to disable encryption"
              onChange={(e) => setDisablePhrase(e.target.value)}
            />
          </label>
          <div className="settings-row">
            <button
              type="button"
              className="btn btn-danger"
              disabled={encryptionBusy || disablePhrase.trim().toLowerCase() !== "i understand"}
              onClick={() => {
                setEncryptionBusy(true);
                setEncryptionError(null);
                void onDisableEncryption(disablePass)
                  .then(() => setDisablePass(""))
                  .catch((err: unknown) => setEncryptionError(messageOf(err)))
                  .finally(() => setEncryptionBusy(false));
              }}
            >
              Disable encryption
            </button>
          </div>
        </>
      ) : null}
        </>
      )}

      <h3 className="quiet-heading">Export</h3>
      <p className="settings-note">
        Exports are written inside your journal storage under exports/, one timestamped folder per
        export.
      </p>
      <div className="settings-row">
        <button type="button" className="btn btn-outline" onClick={() => void runExport("markdown")}>
          Markdown folder
        </button>
        <button type="button" className="btn btn-outline" onClick={() => void runExport("archive")}>
          JSON archive
        </button>
        <button
          type="button"
          className="btn btn-outline"
          onClick={() => void runExport("printable")}
        >
          Printable HTML
        </button>
      </div>
      {exportStatus ? (
        <p className={exportStatus.ok ? "settings-status-ok" : "settings-status-fail"} role="status">
          {exportStatus.text}
        </p>
      ) : null}

      <h3 className="quiet-heading">About</h3>
      <p className="settings-note">{`Quilljournal ${APP_VERSION}. MIT license.`}</p>
      <p className="settings-note">No telemetry: nothing about you or your writing leaves this machine.</p>
    </section>
  );
}

function safeParseHeaders(json: string): Record<string, string> | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "string") return null;
      out[key] = value;
    }
    return out;
  } catch {
    return null;
  }
}
