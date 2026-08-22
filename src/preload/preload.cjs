"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const ALLOWED_CHANNELS = new Set([
  "fs:write-atomic",
  "fs:read-file",
  "fs:exists",
  "fs:stat",
  "fs:unlink",
  "fs:mkdirp",
  "fs:list-dir",
  "fs:rename",
  "fs:remove-dir",
  "rec:start",
  "rec:append",
  "rec:finish",
  "rec:abort",
  "app:pick-dir",
  "app:get-storage",
  "app:set-storage",
  "app:get-settings",
  "app:save-settings",
  "app:get-manifest",
  "app:reveal-storage",
  "app:set-indicator",
  "shortcut:register",
  "shortcut:unregister",
  "push:new-entry",
  "push:open-entry",
]);

contextBridge.exposeInMainWorld("quill", {
  invoke(channel, payload) {
    if (typeof channel !== "string" || !ALLOWED_CHANNELS.has(channel)) {
      return Promise.reject(new Error(`channel not allowed: ${String(channel)}`));
    }
    return ipcRenderer.invoke(channel, payload);
  },
  on(channel, callback) {
    if (typeof callback !== "function") return;
    if (typeof channel !== "string" || !ALLOWED_CHANNELS.has(channel)) return;
    ipcRenderer.on(channel, (_event, data) => {
      callback(data);
    });
  },
});
