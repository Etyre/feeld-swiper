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
  /** Fit as a percentile of the pool scored so far (0-100), from the model's raw fit score. Recomputed as the pool grows. */
  fitPercentile?: number;
  /** Fit percentile bars in force at the time (like / ping). */
  fitLikePercentile?: number;
  fitPingPercentile?: number;
  /** Which criterion earned the recommendation: "veg" (diet), "fit" (your date-me page), or "both".
   *  "intellectual" is the retired exception, kept for old records. */
  likedFor?: "veg" | "fit" | "both" | "intellectual";
  /** Flagged by you as a reference example of a good fit; fed into the prompt. ("intellectual": old records.) */
  exemplar?: "fit" | "intellectual" | null;
  /** Re-scored from the saved text and screens after the first judgement (e.g. after the criteria changed). */
  rescoredAt?: string;
  name: string | null;
  age: number | null;
  photos: string[]; // relative URLs under /photos/
  /** Perceptual hashes (hex) of the profile photos, for recognising the profile again. */
  photoHashes?: string[];
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
  /** The ping message you picked or wrote (what will be sent). */
  pingMessage?: string | null;
  /** Which draft you started from (index into pingDrafts), or null if you wrote your own. */
  pingDraftIndex?: number | null;
  /** The draft as the model wrote it, before your edits. */
  pingDraftOriginal?: string | null;
  /** True when the message you queued differs from the draft you started from. */
  pingEdited?: boolean;
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
  /** Your grade of the model's fit call: should the fit percentile have been higher, lower, or was it about right? */
  fitVerdict?: Verdict | null;
  /** Your own fit percentile (0-100) for this profile, if you gave one. */
  userFitPercentile?: number | null;
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

/** Recent decisions that could be the profile on screen: everything awaiting action first, then the latest judged. Newest first. */
export function recognitionCandidates(limit = 1500): Decision[] {
  const all = readAll();
  const pending = all.filter((d) => d.review && d.review !== "skip" && !d.applied);
  const recent = all.slice(-limit);
  const seen = new Set<string>();
  const out: Decision[] = [];
  for (const d of [...pending.reverse(), ...recent.reverse()]) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    out.push(d);
  }
  return out;
}

/** The raw fit scores of every scored profile: the pool a percentile is measured against. */
export function fitPool(): number[] {
  return readAll()
    .map((d) => d.classification?.fit_probability)
    .filter((f): f is number => typeof f === "number");
}

/** Percentile (0-100) of a raw fit score within the pool: the share of scored profiles it beats, ties counted half. */
export function fitPercentileOf(score: number, pool: number[] = fitPool()): number {
  if (!pool.length) return 50;
  let below = 0;
  let ties = 0;
  for (const x of pool) {
    if (x < score) below++;
    else if (x === score) ties++;
  }
  // The profile itself is usually in the pool; a lone profile sits at the 50th.
  return Math.round((100 * (below + 0.5 * Math.max(ties, 1))) / Math.max(pool.length, 1));
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

/** Your grades and estimates on the diet call (verdict, userProbability) and the fit call (fitVerdict, userFitPercentile). Only the keys present are changed. */
export type VerdictPatch = Pick<Decision, "verdict" | "userProbability" | "fitVerdict" | "userFitPercentile">;
export function setVerdict(id: string, patch: VerdictPatch): Decision | null {
  return updateDecision(id, patch);
}

/** Graded or annotated decisions, newest first, for feeding back into the prompt. */
export function feedbackExamples(limit = 40): Decision[] {
  return readDecisions(100_000)
    .filter(
      (d) =>
        d.classification &&
        (d.verdict || d.fitVerdict || (d.note && d.note.trim()) || typeof d.userProbability === "number" || typeof d.userFitPercentile === "number" || (d.review && d.review !== "skip" && d.action !== "skipped")),
    )
    .slice(0, limit);
}

/** Pings you queued or sent, newest first: what the model drafted and what you actually said. Teaches the drafter your voice. */
export function pastPings(limit = 8): Decision[] {
  return readDecisions(100_000).filter((d) => (d.review === "ping" || d.applied === "ping") && d.pingMessage?.trim()).slice(0, limit);
}

/** Profiles you flagged as reference examples, newest first. */
export function exemplarProfiles(limit = 5): Decision[] {
  return readDecisions(100_000).filter((d) => (d.exemplar === "fit" || d.exemplar === "intellectual") && d.profileText).slice(0, limit);
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
  fitHigher: number;
  fitLower: number;
  fitAboutRight: number;
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
    fitHigher: all.filter((d) => d.fitVerdict === "higher").length,
    fitLower: all.filter((d) => d.fitVerdict === "lower").length,
    fitAboutRight: all.filter((d) => d.fitVerdict === "about_right").length,
    meanBias,
    biasCount: withEstimate.length,
    meanGutGap,
    gutGapCount: withArith.length,
  };
}
