import { createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { ZipArchive } from "archiver";
import yauzl from "yauzl";
import { ReleaseError } from "./errors.js";

const MAX_ENTRIES = 100;
const MAX_BYTES = 4 * 1024 * 1024 * 1024;

export async function extractZip(zipPath, dest) {
  let zip;
  try {
    zip = await yauzl.openPromise(zipPath, { lazyEntries: true, autoClose: true, decodeStrings: true });
  } catch (error) {
    throw new ReleaseError(`无法解压：${error.message}`);
  }
  const files = [];
  let total = 0;
  let settled = false;
  await new Promise((resolve, reject) => {
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error instanceof ReleaseError ? error : new ReleaseError(`无法解压：${error.message}`));
      zip.close();
    };
    zip.on("error", fail);
    zip.on("end", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zip.on("entry", (entry) => {
      if (settled) return;
      const normalized = String(entry.fileName || "").replaceAll("\\", "/");
      const base = path.posix.basename(normalized);
      if (!base || base === "." || normalized.endsWith("/")) {
        zip.readEntry();
        return;
      }
      if (normalized.split("/").includes("..")) {
        fail(new ReleaseError("压缩包包含不安全的路径。"));
        return;
      }
      total += Number(entry.uncompressedSize) || 0;
      const lower = base.toLowerCase();
      const keep = lower.endsWith(".nupkg") || lower.endsWith(".json") || lower.endsWith(".exe");
      if (!keep) {
        zip.readEntry();
        return;
      }
      if (files.length >= MAX_ENTRIES || total > MAX_BYTES) {
        fail(new ReleaseError("压缩包过大。"));
        return;
      }
      const target = path.join(dest, `${files.length}-${base}`);
      zip.openReadStream(entry, (error, stream) => {
        if (error) return fail(error);
        pipeline(stream, createWriteStream(target)).then(() => {
          files.push({ path: target, name: base });
          if (!settled) zip.readEntry();
        }, fail);
      });
    });
    zip.readEntry();
  });
  return files;
}

export function writeArchive(stream, entries) {
  return new Promise((resolve, reject) => {
    const archive = new ZipArchive({ zlib: { level: 0 } });
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    archive.on("error", fail);
    archive.on("end", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    archive.pipe(stream);
    for (const entry of entries) {
      if (entry.path) archive.file(entry.path, { name: entry.name });
      else archive.append(entry.content ?? "", { name: entry.name });
    }
    archive.finalize();
  });
}
