// @fork-seam U12 — upstream release detection source (feeds `consider()`).
//
// The "current" ref is read from the real OpenClaw version marker (single
// source of truth: `src/version.ts` VERSION); the set of known upstream
// releases is read from a local release-feed file (a checked-in fixture that
// represents the upstream release channel). Both readers are FAIL-CLOSED: a
// missing/unreadable/invalid/empty feed yields `null`, which `checkUpstream()`
// treats as "nothing safe to promote" — never a promotion from a bad source.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../../version.js";
import { compareVersions } from "./detect.js";

/** A release feed: the ordered set of upstream releases known to the tracker. */
export interface UpstreamReleaseFeed {
  releases: string[];
}

/** The checked-in feed file name (relative to this module's directory). */
export const UPSTREAM_FEED_FILE = "upstream-releases.json";

/** Absolute path to the checked-in default upstream release feed. */
export function defaultUpstreamFeedPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), UPSTREAM_FEED_FILE);
}

/**
 * Parse a release feed. Format: `{ "releases": ["2026.8.1", ...] }`.
 * Fail-closed: malformed JSON, a missing `releases` array, or an empty/non-string
 * list yields `null` (a bad source must never produce a candidate).
 */
export function parseUpstreamFeed(content: string): UpstreamReleaseFeed | null {
  try {
    const parsed = JSON.parse(content) as { releases?: unknown };
    if (!parsed || !Array.isArray(parsed.releases)) {
      return null;
    }
    const releases = parsed.releases
      .filter((r): r is string => typeof r === "string" && r.trim().length > 0)
      .map((r) => r.trim());
    if (releases.length === 0) {
      return null;
    }
    return { releases };
  } catch {
    return null;
  }
}

/** Read + parse a release feed file. Fail-closed: missing/unreadable → null. */
export function readUpstreamFeedFile(filePath: string): UpstreamReleaseFeed | null {
  try {
    return parseUpstreamFeed(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/** The newest release strictly newer than `current`; null when none (stale). */
export function newestNewer(releases: readonly string[], current: string): string | null {
  let best: string | null = null;
  for (const release of releases) {
    if (compareVersions(release, current) > 0) {
      if (best === null || compareVersions(release, best) > 0) {
        best = release;
      }
    }
  }
  return best;
}

/** The installed OpenClaw version marker (single source of truth). */
export function resolveInstalledVersion(): string {
  return VERSION || "0.0.0";
}

/**
 * The real upstream detection source: read the installed OpenClaw version
 * marker and the local release feed, and return the newest strictly-newer
 * upstream release (or null when the feed is missing/invalid/empty or nothing
 * is newer). Fail-closed: a bad source never yields a candidate.
 */
export function detectUpstreamRelease(
  opts: {
    current?: string;
    feedPath?: string;
  } = {},
): { available: string } | null {
  const current = opts.current ?? resolveInstalledVersion();
  const feed = readUpstreamFeedFile(opts.feedPath ?? defaultUpstreamFeedPath());
  if (!feed) {
    return null;
  }
  const newer = newestNewer(feed.releases, current);
  if (!newer) {
    return null;
  }
  return { available: newer };
}
