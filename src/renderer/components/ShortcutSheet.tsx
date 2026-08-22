import { useEffect, useRef } from "react";

interface ShortcutSheetProps {
  globalAccelerator: string;
  onClose: () => void;
}

export function ShortcutSheet({ globalAccelerator, onClose }: ShortcutSheetProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  return (
    <div
      className="overlay-region"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-sheet-title"
        className="modal-panel"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <h2 id="shortcut-sheet-title" className="modal-title">
          Keyboard shortcuts
        </h2>
        <table className="shortcut-table">
          <tbody>
            <tr>
              <td>New entry today</td>
              <td>
                <kbd>Ctrl+N</kbd>
              </td>
            </tr>
            <tr>
              <td>New entry from anywhere (global)</td>
              <td>
                <kbd>{globalAccelerator}</kbd>
              </td>
            </tr>
            <tr>
              <td>Save now</td>
              <td>
                <kbd>Ctrl+S</kbd>
              </td>
            </tr>
            <tr>
              <td>Toggle markdown preview</td>
              <td>
                <kbd>Ctrl+E</kbd>
              </td>
            </tr>
            <tr>
              <td>Focus mode</td>
              <td>
                <kbd>Ctrl+Shift+F</kbd>
              </td>
            </tr>
            <tr>
              <td>Focus search</td>
              <td>
                <kbd>/</kbd>
              </td>
            </tr>
            <tr>
              <td>Open or close this sheet</td>
              <td>
                <kbd>?</kbd>
              </td>
            </tr>
            <tr>
              <td>Close overlay / leave focus mode</td>
              <td>
                <kbd>Esc</kbd>
              </td>
            </tr>
          </tbody>
        </table>
        <div style={{ marginTop: "var(--space-4)", textAlign: "end" }}>
          <button type="button" className="btn btn-outline" onClick={onClose} ref={closeRef}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
