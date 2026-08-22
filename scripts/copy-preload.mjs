import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(projectRoot, "src", "preload", "preload.cjs");
const destinationDir = path.join(projectRoot, "dist-electron", "preload");

await mkdir(destinationDir, { recursive: true });
await copyFile(source, path.join(destinationDir, "preload.cjs"));
