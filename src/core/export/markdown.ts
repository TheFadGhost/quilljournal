import type { FileSystemLike } from "../fslike.js";
import type { Entry, EntryAttachment } from "../types.js";

const MINUTE_MS = 60_000;
const MAX_SLUG_CHARS = 40;
const MEDIA_DIR = "media";

const encoder = new TextEncoder();

function joinPath(...parts: string[]): string {
  return parts.filter((part) => part.length > 0).join("/");
}

function truncateCodePoints(text: string, max: number): string {
  return [...text].slice(0, max).join("");
}

function slugOf(title: string): string {
  const collapsed = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-");
  let slug = collapsed.replace(/^-+/u, "").replace(/-+$/u, "");
  if ([...slug].length > MAX_SLUG_CHARS) {
    slug = truncateCodePoints(slug, MAX_SLUG_CHARS).replace(/-+$/u, "");
  }
  return slug.length > 0 ? slug : "entry";
}

function sanitizeFileName(name: string): string {
  const segments = name.split(/[/\\]/);
  const base = segments[segments.length - 1] ?? "";
  let cleaned = "";
  for (const ch of base) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) cleaned += ch;
  }
  cleaned = cleaned.replace(/[. ]+$/u, "");
  if (!cleaned || cleaned === "." || cleaned === "..") return "file";
  return cleaned;
}

function frontmatterLines(entry: Entry): string[] {
  return [
    "---",
    `id: ${entry.id}`,
    `date: ${entry.dateKey}`,
    `created: ${entry.createdAt}`,
    `updated: ${entry.updatedAt}`,
    `tags: ${JSON.stringify(entry.tags)}`,
    `markers: ${JSON.stringify(entry.markers)}`,
    `revisions: ${entry.revisions.length}`,
    `writing-time-min: ${Math.round(entry.writingTimeMs / MINUTE_MS)}`,
    "---",
  ];
}

export async function exportMarkdown(
  fs: FileSystemLike,
  outRoot: string,
  entries: Entry[],
  loaders: { readAttachment(att: EntryAttachment): Promise<Uint8Array> },
): Promise<string[]> {
  const written: string[] = [];
  const needsMediaDir = entries.some((entry) => entry.attachments.length > 0);
  if (needsMediaDir) await fs.mkdirp(joinPath(outRoot, MEDIA_DIR));
  for (const entry of entries) {
    const fileName = `${entry.dateKey}-${slugOf(entry.title)}-${entry.id.slice(-6)}.md`;
    const heading = entry.title.length > 0 ? entry.title : entry.dateKey;
    const lines = frontmatterLines(entry);
    lines.push("", `# ${heading}`, "", entry.body);
    const perEntryPaths: string[] = [fileName];
    const mediaLinks: string[] = [];
    for (const attachment of entry.attachments) {
      const mediaName = `${attachment.id}-${sanitizeFileName(attachment.fileName)}`;
      const bytes = await loaders.readAttachment(attachment);
      await fs.writeFileAtomic(joinPath(outRoot, MEDIA_DIR, mediaName), bytes);
      mediaLinks.push(`- ${MEDIA_DIR}/${mediaName}`);
      perEntryPaths.push(`${MEDIA_DIR}/${mediaName}`);
    }
    if (mediaLinks.length > 0) lines.push("", "Attachments:", ...mediaLinks);
    await fs.writeFileAtomic(joinPath(outRoot, fileName), encoder.encode(lines.join("\n")));
    written.push(...perEntryPaths);
  }
  return written;
}
