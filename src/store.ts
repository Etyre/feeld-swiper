import fs from "node:fs";
import { DECISIONS_FILE } from "./paths.js";
import type { Classification } from "./classifier.js";

/** Something actually done on Feeld. */
export type Action = "like" | "ping" | "pass";
/** The model's provisional call. Nothing happens on Feeld until you review it. */
export type Recommendation = "recommend_like" | "recommend_ping" | "recommend_pass" | "skipped";
export type Verdict = "higher" | "about_right" | "lower";
export interface PingDraft {
  /** The angle the draft takes, e.g. "specific detail + question". */
  angle: string;
  text: string;
}

export interface Decision {
  id: string;
  at: string; // ISO timestamp
  /** Batch this decision belongs to (the batch's start time). */
  batchId?: string;
  /** Name-and-age fingerprint used to recognise the profile when it comes up again. */
  fingerprint: string;
  action: Recommendation;
  threshold: number;
  /** Ping threshold in force at the time, when pings were enabled. */
  pingThreshold?: number;
  /** Which criterion triggered the recommendation: "veg", "intellectual", or "both". */
  likedFor?: "veg" | "intellectual" | "both";
  /** Flagged by you as a reference example of the intellectual criterion; fed into the prompt. */
  exemplar?: "intellectual" | null;
  name: string | null;
  age: number | null;
  photos: string[]; // relative URLs under /photos/
  classification: Classification | null;
  error?: string;
  usage?: { input: number; output: number; cacheRead: number };
  /** Text-and-first-screen score from the first stage, when a second full-screen stage followed. */
  bioOnlyProbability?: number;
  /** Judged on the first-stage score alone, without looking at more screens. */
  quickPass?: boolean;
  /** Which model and effort level made the call. */
  model?: string;
  effort?: string;
  /** Screenshots of the whole profile as it scrolled by, relative URLs under /photos/. */
  screens?: string[];
  /** Profile text read from the accessibility tree so the dashboard can show the bio. */
  profileText?: string;
  /** Distance shown on the profile, in miles (km converted). */
  distanceMiles?: number;
  /** Your review: what to do on Feeld when this profile comes up again. "skip" = leave it alone. */
  review?: Action | "skip" | null;
  reviewedAt?: string | null;
  /** The ping message you picked or wrote. */
  pingMessage?: string | null;
  /** Openers drafted for you to pick from. */
  pingDrafts?: PingDraft[];
  draftsModel?: string;
  /** What was actually done on Feeld, once the profile came up again after your review. */
  applied?: Action | null;
  appliedAt?: string | null;
  /** E.g. "no pings left; sent a like instead". */
  applyNote?: string | null;
  /** Your grade of the model's probability: should it have been higher, lower, or was it about right? */
  verdict?: Verdict | null;
  /** Your own probability estimate for this profile, if you gave one. */
  userProbability?: number | null;
  /** Your free-text note about this call. Fed back to the model as a calibration example. */
  note?: string | null;
}

let cache: { key: string; list: Decision[] } | null = null;

/** Every decision in file order (oldest first). Re-parsed only when the file changes. */
function readAll(): Decision[] {
  if (!fs.existsSync(DECISIONS_FILE)) return [];
  const st = fs.statSync(DECISIONS_FILE);
  const key = `${st.mtimeMs}:${st.size}`;
  if (cache && cache.key === key) return cache.list;
  const list: Decision[] = [];
  for (const line of fs.readFileSync(DECISIONS_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      list.push(JSON.parse(line));
    } catch {
      /* skip corrupt line */
    }
  }
  cache = { key, list };
  return list;
}

export function appendDecision(d: Decision): void {
  fs.appendFileSync(DECISIONS_FILE, JSON.stringify(d) + "\n");
}

/** Newest first. */
export function readDecisions(limit = 200): Decision[] {
  return readAll().slice(-limit).reverse();
}

export function getDecision(id: string): Decision | null {
  return readAll().find((d) => d.id === id) ?? null;
}

/** Decisions recorded for a profile fingerprint, newest first. */
export function decisionsFor(fingerprint: string): Decision[] {
  return readAll()
    .filter((d) => d.fingerprint === fingerprint)
    .reverse();
}

/** Apply patches to several decisions in one rewrite of the file. Returns the updated decisions. */
export function updateMany(patches: Map<string, Partial<Decision>>): Decision[] {
  if (!fs.existsSync(DECISIONS_FILE) || !patches.size) return [];
  const lines = fs.readFileSync(DECISIONS_FILE, "utf8").split("\n");
  const updated: Decision[] = [];
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    try {
      const d = JSON.parse(line) as Decision;
      const patch = patches.get(d.id);
      if (!patch) return line;
      const next = { ...d, ...patch };
      updated.push(next);
      return JSON.stringify(next);
    } catch {
      return line;
    }
  });
  if (updated.length) fs.writeFileSync(DECISIONS_FILE, out.join("\n"));
  return updated;
}

export function updateDecision(id: string, patch: Partial<Decision>): Decision | null {
  return updateMany(new Map([[id, patch]]))[0] ?? null;
}

export function setVerdict(id: string, verdict: Verdict | null, userProbability?: number | null): Decision | null {
  const patch: Partial<Decision> = { verdict };
  if (userProbability !== undefined) patch.userProbability = userProbability;
  return updateDecision(id, patch);
}

/** Graded or annotated decisions, newest first, for feeding back into the prompt. */
export function feedbackExamples(limit = 40): Decision[] {
  return readDecisions(100_000)
    .filter((d) => d.classification && (d.verdict || (d.note && d.note.trim()) || typeof d.userProbability === "number"))
    .slice(0, limit);
}

/** Profiles you flagged as reference examples, newest first. */
export function exemplarProfiles(limit = 5): Decision[] {
  return readDecisions(100_000).filter((d) => d.exemplar === "intellectual" && d.profileText).slice(0, limit);
}

/** What the next batch will do on Feeld: reviewed decisions not yet applied, by action. */
export function queueSummary(): { pending: number; like: number; ping: number; pass: number } {
  const all = readAll();
  const q = { pending: 0, like: 0, ping: 0, pass: 0 };
  for (const d of all) {
    if (d.applied) continue;
    if (!d.review) {
      if (d.action !== "skipped") q.pending++;
    } else if (d.review !== "skip") q[d.review]++;
  }
  return q;
}

export function stats(): {
  seen: number;
  /** Judged, waiting for your review. */
  pending: number;
  /** Reviewed, waiting for the profile to come up again. */
  queued: { like: number; ping: number; pass: number };
  /** Left alone by you: no like, no pass. */
  leftAlone: number;
  /** Actually done on Feeld. */
  liked: number;
  pinged: number;
  passed: number;
  recommendedLike: number;
  higher: number;
  lower: number;
  aboutRight: number;
  /** Mean of (your estimate - model's probability) where you gave an estimate; positive = model too low. */
  meanBias: number | null;
  biasCount: number;
  /** Mean of (gut check − arithmetic posterior) across scored profiles; positive = gut runs higher. */
  meanGutGap: number | null;
  gutGapCount: number;
} {
  const all = readAll();
  const withEstimate = all.filter((d) => typeof d.userProbability === "number" && d.classification);
  const meanBias = withEstimate.length
    ? withEstimate.reduce((acc, d) => acc + (d.userProbability! - d.classification!.probability), 0) / withEstimate.length
    : null;
  const withArith = all.filter((d) => d.classification && typeof d.classification.arithmetic_probability === "number");
  const meanGutGap = withArith.length
    ? withArith.reduce((acc, d) => acc + (d.classification!.probability - d.classification!.arithmetic_probability!), 0) / withArith.length
    : null;
  const q = queueSummary();
  return {
    seen: all.length,
    pending: q.pending,
    queued: { like: q.like, ping: q.ping, pass: q.pass },
    leftAlone: all.filter((d) => d.review === "skip" && !d.applied).length,
    liked: all.filter((d) => d.applied === "like").length,
    pinged: all.filter((d) => d.applied === "ping").length,
    passed: all.filter((d) => d.applied === "pass").length,
    recommendedLike: all.filter((d) => d.action === "recommend_like" || d.action === "recommend_ping").length,
    higher: all.filter((d) => d.verdict === "higher").length,
    lower: all.filter((d) => d.verdict === "lower").length,
    aboutRight: all.filter((d) => d.verdict === "about_right").length,
    meanBias,
    biasCount: withEstimate.length,
    meanGutGap,
    gutGapCount: withArith.length,
  };
}
