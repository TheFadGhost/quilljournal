import { useState } from "react";

interface BackupReminderProps {
  lastExportAt: string | null;
  reminderDays: number | null;
  onGoToExport(): void;
}

const DAY_MS = 86_400_000;

export function BackupReminder({ lastExportAt, reminderDays, onGoToExport }: BackupReminderProps) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || reminderDays === null || reminderDays <= 0) return null;

  let days: number | null = null;
  if (lastExportAt !== null) {
    const then = Date.parse(lastExportAt);
    if (!Number.isNaN(then)) days = Math.floor((Date.now() - then) / DAY_MS);
  }
  const overdue = lastExportAt === null || days === null || days >= reminderDays;
  if (!overdue) return null;

  const text =
    lastExportAt !== null && days !== null
      ? `Last export ${days} ${days === 1 ? "day" : "days"} ago. Export creates a backup file.`
      : "You have not exported a backup yet. Export creates a backup file.";

  return (
    <div className="backup-banner" role="status">
      <span className="backup-banner-text">{text}</span>
      <button type="button" className="btn btn-outline" onClick={onGoToExport}>
        Open export settings
      </button>
      <button
        type="button"
        className="btn btn-outline"
        aria-label="Dismiss backup reminder for this session"
        onClick={() => setDismissed(true)}
      >
        Dismiss
      </button>
    </div>
  );
}
