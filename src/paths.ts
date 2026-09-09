import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = path.join(ROOT, "data");
export const PUBLIC_DIR = path.join(ROOT, "public");
export const PHOTOS_DIR = path.join(DATA_DIR, "photos");
export const ERRORS_DIR = path.join(DATA_DIR, "errors");
export const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
export const DECISIONS_FILE = path.join(DATA_DIR, "decisions.jsonl");

for (const d of [DATA_DIR, PHOTOS_DIR, ERRORS_DIR]) fs.mkdirSync(d, { recursive: true });
