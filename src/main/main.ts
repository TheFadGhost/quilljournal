import { app, BrowserWindow, Menu, globalShortcut, ipcMain } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IPC_CHANNELS } from "../shared/ipc.js";
import { IndicatorWindow } from "./indicatorWindow.js";
import { registerIpc } from "./ipcImpl.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const devServerUrl = process.env["QUILL_VITE_URL"] ?? "";
const preloadPath = path.join(moduleDir, "..", "preload", "preload.cjs");
const rendererIndexPath = path.join(moduleDir, "..", "..", "dist", "renderer", "index.html");

let mainWindow: BrowserWindow | null = null;
let ipcApi: ReturnType<typeof registerIpc> | null = null;
let flushingBeforeQuit = false;
const indicator = new IndicatorWindow();

function sendNewEntryPush(): void {
  mainWindow?.webContents.send(IPC_CHANNELS.pushNewEntry);
}

function buildMenu(): void {
  const devToolsAllowed = devServerUrl.length > 0 || !app.isPackaged;
  const template: MenuItemConstructorOptions[] = [
    {
      label: "&File",
      submenu: [
        {
          label: "New Entry",
          accelerator: "Ctrl+N",
          click: () => sendNewEntryPush(),
        },
        { type: "separator" },
        { role: "quit", label: "Quit" },
      ],
    },
    {
      label: "&Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
  ];
  if (devToolsAllowed) {
    template.push({
      label: "&View",
      submenu: [{ role: "toggleDevTools", accelerator: "Ctrl+Shift+I" }],
    });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createMainWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 980,
    minHeight: 640,
    title: "Quilljournal",
    autoHideMenuBar: false,
    show: false,
    backgroundColor: "#faf7f2",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  if (devServerUrl.length > 0) {
    await mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    await mainWindow.loadFile(rendererIndexPath);
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      void createMainWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(async () => {
    buildMenu();
    ipcApi = registerIpc(ipcMain, {
      userDataPath: app.getPath("userData"),
      getWindow: () => mainWindow,
      indicator,
    });
    await createMainWindow();
    const settings = await ipcApi.getSettings();
    if (settings.globalNewEntryShortcut) {
      await ipcApi.registerGlobalShortcut(settings.globalNewEntryShortcut);
    }
  });

  app.on("before-quit", (event) => {
    const api = ipcApi;
    if (!api || flushingBeforeQuit || !api.hasActiveRecordings()) return;
    event.preventDefault();
    flushingBeforeQuit = true;
    void api.shutdown(2000).then(() => app.quit());
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    indicator.destroy();
  });

  app.on("window-all-closed", () => {
    app.quit();
  });
}
