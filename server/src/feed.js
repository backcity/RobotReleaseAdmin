import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { Marked } from "marked";
import { ReleaseError } from "./errors.js";
import { compareVersions } from "./versions.js";

export const FEED_NAME = "releases.win.json";
export const POLICY_NAME = "policy.json";

const parser = new Marked({ async: false, gfm: true, breaks: true });

export function toHtml(notes) {
  const safe = String(notes ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  if (!safe.trim()) return "";
  const html = parser.parse(safe);
  return typeof html === "string" ? html : "";
}

export function inRollout(deviceId, percent) {
  if (percent >= 100) return true;
  if (percent <= 0 || !deviceId) return false;
  return createHash("sha256").update(String(deviceId)).digest().readUInt32BE(0) % 100 < percent;
}

export function normalizeIp(ip) {
  const text = String(ip || "").trim();
  return text.startsWith("::ffff:") ? text.slice(7) : text;
}

export function packageName(app, version, kind) {
  return `${app.packId}-${version}-${kind}.nupkg`;
}

export function setupName(app, version) {
  return `${app.packId}-${version}-Setup.exe`;
}

export function isPublicName(fileName) {
  if (fileName === FEED_NAME || fileName === POLICY_NAME) return true;
  if (!fileName || fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) return false;
  if (/^[A-Za-z0-9._-]+-Setup\.exe$/i.test(fileName)) return true;
  return /^[A-Za-z0-9._-]+\.nupkg$/.test(fileName);
}

const NUPKG_NAME = /^(?<id>[A-Za-z0-9._-]+)-(?<version>(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?)-(?<kind>full|delta)\.nupkg$/i;

export function parseNupkgName(name) {
  const match = NUPKG_NAME.exec(String(name).split(/[/\\]/).pop());
  if (!match) return null;
  return { id: match.groups.id, version: match.groups.version, kind: match.groups.kind.toLowerCase() };
}

export async function inspectPackage(file, label) {
  const info = await stat(file);
  if (info.size < 22) throw new ReleaseError(`${label}是空文件。`);
  const handle = await open(file, "r");
  try {
    const header = Buffer.alloc(2);
    await handle.read(header, 0, 2, 0);
    if (header[0] !== 0x50 || header[1] !== 0x4b) throw new ReleaseError(`${label}不是 nupkg。`);
  } finally {
    await handle.close();
  }
  const sha1 = createHash("sha1");
  const sha256 = createHash("sha256");
  await new Promise((resolve, reject) => {
    const input = createReadStream(file);
    input.on("data", (chunk) => {
      sha1.update(chunk);
      sha256.update(chunk);
    });
    input.on("error", reject);
    input.on("end", resolve);
  });
  return { size: info.size, sha1: sha1.digest("hex").toUpperCase(), sha256: sha256.digest("hex").toUpperCase() };
}

export function buildAssets(app, version, notes, full, fullName, delta, deltaName, incoming) {
  const fullFromFeed = incoming.find((asset) => asset.Version === version && asset.Type === "Full") ?? null;
  const deltaFromFeed = incoming.find((asset) => asset.Version === version && asset.Type === "Delta") ?? null;
  if (deltaFromFeed && !delta) throw new ReleaseError("清单包含差分包，但没有上传差分文件。");
  const produced = [compose(app, version, "Full", fullName, full, notes, fullFromFeed)];
  if (delta && deltaName) produced.push(compose(app, version, "Delta", deltaName, delta, notes, deltaFromFeed));
  return produced;
}

export function parseFeed(json) {
  let root;
  try {
    root = JSON.parse(json);
  } catch (error) {
    throw new ReleaseError(`清单不是有效的 JSON：${error.message}`);
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) throw new ReleaseError("清单不是 Velopack 发布清单。");
  const assets = root.Assets ?? root.assets;
  if (!Array.isArray(assets)) return [];
  return assets.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const type = text(item, "Type", "type");
    if (type !== "Full" && type !== "Delta") return [];
    return [{
      PackageId: text(item, "PackageId", "packageId"),
      Version: text(item, "Version", "version"),
      Type: type,
      FileName: text(item, "FileName", "fileName"),
      Sha1: text(item, "SHA1", "sha1"),
      Sha256: text(item, "SHA256", "sha256"),
      Size: number(item.Size ?? item.size),
      NotesMarkdown: text(item, "NotesMarkdown", "notesMarkdown"),
      NotesHtml: text(item, "NotesHTML", "notesHtml") || text(item, "NotesHtml"),
    }];
  });
}

export function serializeFeed(assets) {
  const ordered = [...assets].sort((left, right) => {
    const byVersion = compareVersions(right.Version, left.Version);
    if (byVersion !== 0) return byVersion;
    return (left.Type === "Full" ? 0 : 1) - (right.Type === "Full" ? 0 : 1);
  });
  return `${JSON.stringify({
    Assets: ordered.map((asset) => ({
      PackageId: asset.PackageId,
      Version: asset.Version,
      Type: asset.Type,
      FileName: asset.FileName,
      SHA1: asset.Sha1,
      SHA256: asset.Sha256,
      Size: asset.Size,
      NotesMarkdown: asset.NotesMarkdown,
      NotesHTML: asset.NotesHtml,
    })),
  }, null, 2)}\n`;
}

function compose(app, version, type, fileName, pkg, notes, fromFeed) {
  if (fromFeed?.PackageId && fromFeed.PackageId !== app.packId) throw new ReleaseError("清单中的 PackageId 与该程序不一致。");
  requireMatch("SHA1", fromFeed?.Sha1, pkg.sha1);
  requireMatch("SHA256", fromFeed?.Sha256, pkg.sha256);
  if (fromFeed?.Size > 0 && fromFeed.Size !== pkg.size) throw new ReleaseError("清单中的 Size 与上传的文件不一致。");
  const markdown = notes ?? fromFeed?.NotesMarkdown ?? "";
  const html = notes == null ? (fromFeed?.NotesHtml || toHtml(markdown)) : toHtml(notes);
  return {
    PackageId: app.packId,
    Version: version,
    Type: type,
    FileName: fileName,
    Sha1: pkg.sha1,
    Sha256: pkg.sha256,
    Size: pkg.size,
    NotesMarkdown: markdown,
    NotesHtml: html,
  };
}

function requireMatch(label, expected, actual) {
  if (!expected || !String(expected).trim()) return;
  if (String(expected).trim().toUpperCase() !== actual.toUpperCase()) {
    throw new ReleaseError(`清单中的 ${label} 与上传的文件不一致。`);
  }
}

function text(item, ...names) {
  for (const name of names) if (typeof item[name] === "string") return item[name];
  return "";
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
