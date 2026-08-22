import { BrowserWindow, screen } from "electron";

const INDICATOR_WIDTH = 260;
const INDICATOR_HEIGHT = 64;
const SCREEN_MARGIN = 16;
const BACKGROUND = "#1d1a17";
const DANGER = "#d64541";
const INK = "#f5efe6";
const LABEL_MAX_WIDTH = 190;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function indicatorHtml(label: string): string {
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\"><style>",
    "html,body{margin:0;width:100%;height:100%;background:" + BACKGROUND + ";overflow:hidden}",
    "body{display:flex;align-items:center;justify-content:center;gap:10px;",
    "font-family:'Segoe UI',system-ui,sans-serif;color:" + INK + "}",
    ".dot{width:12px;height:12px;border-radius:50%;background:" + DANGER + ";flex:none}",
    ".label{font-size:13px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
    "max-width:" + LABEL_MAX_WIDTH + "px;-webkit-user-select:none;user-select:none}",
    "</style></head><body><div class=\"dot\"></div><div class=\"label\">" + escapeHtml(label) + "</div></body></html>",
  ].join("");
}

export class IndicatorWindow {
  private win: BrowserWindow | null = null;

  show(label: string): void {
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(indicatorHtml(String(label)))}`;
    const existing = this.win;
    if (existing && !existing.isDestroyed()) {
      existing.loadURL(url).catch(() => undefined);
      return;
    }
    const workArea = screen.getPrimaryDisplay().workArea;
    const win = new BrowserWindow({
      width: INDICATOR_WIDTH,
      height: INDICATOR_HEIGHT,
      x: workArea.x + workArea.width - INDICATOR_WIDTH - SCREEN_MARGIN,
      y: workArea.y + workArea.height - INDICATOR_HEIGHT - SCREEN_MARGIN,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      show: false,
      backgroundColor: BACKGROUND,
      title: "Quilljournal",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setMenu(null);
    win.once("ready-to-show", () => {
      if (!win.isDestroyed()) win.showInactive();
    });
    win.loadURL(url).catch(() => undefined);
    this.win = win;
  }

  hide(): void {
    const win = this.win;
    this.win = null;
    if (win && !win.isDestroyed()) {
      win.destroy();
    }
  }

  destroy(): void {
    this.hide();
  }
}
