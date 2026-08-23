import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const { app } = require("electron");

const pkg = require("../package.json");
app.setName(pkg.productName ?? pkg.name);

const require2 = createRequire(path.join(process.cwd(), "noop.js"));
void require2;
const { createNodeFsLike } = await import("../dist-electron/main/nodeFsLike.js");
const { JournalStore } = await import("../dist-electron/core/store/journalStore.js");

function storageRoot() {
  const pointer = path.join(app.getPath("userData"), "quill.json");
  try {
    const raw = require("node:fs").readFileSync(pointer, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.storageDir === "string") return parsed.storageDir;
  } catch {}
  return path.join(app.getPath("userData"), "journal");
}

const root = storageRoot();
const fs = createNodeFsLike(root);
const store = new JournalStore(fs);
await store.init();

if (!(await fs.exists("settings.json"))) {
  const { DEFAULT_SETTINGS } = await import("../dist-electron/core/types.js");
  await fs.writeFileAtomic(
    "settings.json",
    JSON.stringify({ ...DEFAULT_SETTINGS, onboardedAt: new Date().toISOString() }, null, 2),
  );
}

if (store.isEncrypted()) {
  console.error("refusing to seed an encrypted journal");
  process.exit(1);
}

const existing = await store.listEntries();
if (existing.length > 0) {
  console.log(`journal already has ${existing.length} entries; nothing seeded`);
  process.exit(0);
}

const days = [
  { offset: 0, title: "Rain on the kitchen window", body: "Wrote the first page of the notebook idea this morning.\n\nThe kettle took forever. I rewrote the opening twice and kept the second one.", tags: ["writing"], markers: ["focused"] },
  { offset: -1, title: "", body: "Long walk past the canal after dinner. Counted three herons and lost track of time.", tags: ["walks"], markers: [] },
  { offset: -3, title: "Errands and a good sandwich", body: "Fixed the squeaky hinge, finally. The bakery had the seeded rolls again.", tags: ["errands", "food"], markers: ["good day"] },
  { offset: -30, title: "", body: "Started keeping this journal. The plan is short entries most days rather than long ones rarely.", tags: [], markers: [] },
];

for (const day of days) {
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + day.offset);
  const entry = await store.createEntry({
    dateKey: base.toISOString().slice(0, 10),
    createdAt: base.toISOString(),
  });
  await store.putEntry({
    ...entry,
    title: day.title,
    body: day.body,
    tags: day.tags,
    markers: day.markers,
  });
}

console.log(`seeded ${days.length} synthetic entries into ${root}`);
process.exit(0);
