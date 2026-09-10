// U5 — tiny durable-file helpers. Local, dependency-light, NO-DELETE.
import fs from "node:fs";
import path from "node:path";

/** Read + parse JSON, returning undefined when the file does not exist. */
export function readJsonFile<T>(file: string | undefined): T | undefined {
  if (!file) {
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

/** Atomically write JSON (temp file + rename) so a crash never truncates state. */
export function writeJsonAtomic(file: string | undefined, value: unknown): void {
  if (!file) {
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Atomically write a text file (temp file + rename). */
export function writeTextAtomic(file: string | undefined, text: string): void {
  if (!file) {
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Append-only NDJSON sink (opened with the append flag — never truncated). */
export function appendNdjson(file: string | undefined, entry: unknown): void {
  if (!file) {
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
}
