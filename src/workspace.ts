import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function resolveExistingPath(input: string): string {
  const resolved = path.resolve(input);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Path does not exist: ${resolved}`);
  }
  return resolved;
}

export function findPackRoot(startPath: string): string {
  let dir = resolveExistingPath(startPath);
  if (fs.statSync(dir).isFile()) {
    dir = path.dirname(dir);
  }

  let current = dir;
  while (true) {
    if (fs.existsSync(path.join(current, "pack.mcmeta"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return dir;
}

export function languageIdFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".mcfunction":
      return "mcfunction";
    case ".mcdoc":
      return "mcdoc";
    case ".snbt":
      return "snbt";
    case ".mcmeta":
      return "mcmeta";
    case ".json":
      return "json";
    default:
      throw new Error(
        `Unsupported datapack file type: ${ext || "(no extension)"} (${filePath})`,
      );
  }
}

export function toFileUri(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).href;
}

export function toFolderUri(dirPath: string): string {
  const uri = toFileUri(dirPath);
  return uri.endsWith("/") ? uri : `${uri}/`;
}

export function uriKey(uri: string): string {
  return uri.replaceAll("\\", "/").toLowerCase();
}

export function uriToFsPath(uri: string): string {
  return fileUrlToPath(uri);
}

function fileUrlToPath(uri: string): string {
  const url = new URL(uri);
  if (url.protocol !== "file:") {
    return uri;
  }
  let pathname = decodeURIComponent(url.pathname);
  if (/^\/[a-zA-Z]:\//.test(pathname)) {
    pathname = pathname.slice(1);
  }
  return path.normalize(pathname);
}

export function sameRoot(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "Cache", "__pycache__"]);

export function listDatapackFiles(root: string): string[] {
  const files: string[] = [];

  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          walk(full);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === ".mcfunction" || ext === ".mcdoc" || ext === ".snbt" || ext === ".mcmeta") {
        files.push(full);
        continue;
      }
      if (ext === ".json") {
        const normalized = full.replaceAll("\\", "/").toLowerCase();
        if (normalized.includes("/data/") || normalized.includes("/assets/")) {
          files.push(full);
        }
      }
    }
  };

  walk(root);
  return files.sort();
}
