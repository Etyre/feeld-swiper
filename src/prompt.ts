import fs from "node:fs";
import path from "node:path";
import { CRITERIA_FILE, ROOT } from "./paths.js";

/**
 * System prompt for the profile classifier. Kept free of anything volatile
 * (timestamps, per-profile data) so it caches across every request.
 *
 * The criterion itself (what counts as evidence, how the user weighs fit) is personal, so it
 * lives outside git in data/criteria.md; criteria.example.md in the repo shows the shape.
 * Placeholders {{priorPct}} and {{neededLR}} are filled in here.
 */
export function buildSystemPrompt(prior: number, dateMePage = ""): string {
  prior = Math.min(0.99, Math.max(0.01, prior));
  const priorPct = Math.round(prior * 100);
  const neededLR = ((0.5 / 0.5) / (prior / (1 - prior))).toFixed(1);
  const body = loadCriteria().replaceAll("{{priorPct}}", String(priorPct)).replaceAll("{{neededLR}}", neededLR).trimEnd();
  return `${body}

${dateMePage.trim() ? `## The user's own description of what they are looking for (their date-me page)\n${dateMePage.trim()}` : "## The user's description\nNo description was given, so fit cannot be judged: set fit_probability to 0.1 and list no fit evidence."}`;
}

export interface FeedbackExample {
  name: string | null;
  age: number | null;
  modelProbability: number;
  fitProbability?: number | null;
  /** The fit score's rank against the pool, 0-100, when known. */
  fitPercentile?: number | null;
  verdict: "higher" | "about_right" | "lower" | null | undefined;
  userProbability: number | null | undefined;
  /** The user's grade of the fit call and their own fit percentile, if given. */
  fitVerdict?: "higher" | "about_right" | "lower" | null;
  userFitPercentile?: number | null;
  note: string | null | undefined;
  profileSnippet: string;
  /** The model's tier (recommend_ping / recommend_like / recommend_pass) and the tier the user chose. */
  recommendation?: string | null;
  review?: string | null;
  /** "veg", "fit" or "both": which criterion earned the recommendation. */
  likedFor?: string | null;
}

/**
 * Second system block: the user's standing guidance plus their recent grades and
 * notes on past calls. Changes only when they grade something, so it sits after
 * the cached main prompt.
 */
export function buildFeedbackPrompt(guidance: string, examples: FeedbackExample[], exemplars: { name: string | null; age: number | null; text: string }[] = []): string | null {
  const parts: string[] = [];
  if (guidance.trim()) {
    parts.push(`## Standing guidance from the user\n${guidance.trim()}`);
  }
  if (exemplars.length) {
    const lines = exemplars.map((e) => `### ${e.name ?? "?"}${e.age ? `, ${e.age}` : ""}\n${e.text.slice(0, 1200)}`);
    parts.push(`## Reference cases of a good fit\nThe user flagged these profiles as clear cases of a good fit for them. Use them to calibrate fit_probability: a profile at this level deserves 60% or more; most profiles fall far short of it.\n${lines.join("\n\n")}`);
  }
  if (examples.length) {
    const lines = examples.map((e) => {
      const who = `${e.name ?? "?"}${e.age ? `, ${e.age}` : ""}`;
      const gradeWord = (v: FeedbackExample["verdict"]) => (v === "higher" ? "should have been HIGHER" : v === "lower" ? "should have been LOWER" : v === "about_right" ? "about right" : "ungraded");
      const yours = typeof e.userProbability === "number" ? ` (user's estimate ${Math.round(e.userProbability * 100)}%)` : "";
      const yourFit = typeof e.userFitPercentile === "number" ? ` (user puts it at the ${ordinal(e.userFitPercentile)} percentile)` : "";
      const note = e.note?.trim() ? `\n  Note: ${e.note.trim()}` : "";
      const snip = e.profileSnippet ? `\n  Profile: ${e.profileSnippet}` : "";
      const fit =
        typeof e.fitPercentile === "number"
          ? `, fit ${Math.round((e.fitProbability ?? 0) * 100)}% (${ordinal(e.fitPercentile)} percentile of the pool)`
          : typeof e.fitProbability === "number"
            ? `, fit ${Math.round(e.fitProbability * 100)}%`
            : "";
      const basis = e.likedFor === "fit" ? " (recommended for fit)" : e.likedFor === "both" ? " (recommended for diet and fit)" : e.likedFor === "veg" ? " (recommended for diet)" : "";
      const tier = tierChange(e.recommendation, e.review) + basis;
      return `- ${who}: model said diet ${Math.round(e.modelProbability * 100)}%${fit}; user says the diet call was ${gradeWord(e.verdict)}${yours} and the fit call was ${gradeWord(e.fitVerdict)}${yourFit}${tier}.${note}${snip}`;
    });
    parts.push(
      `## Calibration feedback on your recent calls\nThe user reviewed these past profiles. Use them to correct systematic errors in how you weigh evidence, not to memorize individuals. The two calls are graded separately: HIGHER / LOWER on the diet call refer to the diet probability; HIGHER / LOWER on the fit call refer to where fit_probability ranked against the rest of the pool (its percentile), so a LOWER fit grade means this profile should have scored below more of the others. Where the user moved a profile to a higher tier than you recommended, you under-rated it on diet or on fit; moved lower, you over-rated it. Notes explain their reasoning and may speak to either score.\n${lines.join("\n")}`,
    );
  }
  return parts.length ? parts.join("\n\n") : null;
}

const ordinal = (n: number): string => {
  const v = Math.round(n) % 100;
  const s = v >= 11 && v <= 13 ? "th" : ["th", "st", "nd", "rd"][v % 10] ?? "th";
  return `${Math.round(n)}${s}`;
};

/** "; user moved it from like to PING" when the user's review landed in a different tier than the recommendation. */
function tierChange(recommendation: string | null | undefined, review: string | null | undefined): string {
  if (!recommendation || !review || review === "skip") return "";
  const rec = recommendation.replace(/^recommend_/, "");
  if (rec === review) return "";
  return `; user moved it from ${rec} to ${review.toUpperCase()}`;
}

function loadCriteria(): string {
  if (fs.existsSync(CRITERIA_FILE)) return fs.readFileSync(CRITERIA_FILE, "utf8");
  console.warn(`[prompt] ${CRITERIA_FILE} not found; using criteria.example.md. Copy and edit it to set your own criterion.`);
  return fs.readFileSync(path.join(ROOT, "criteria.example.md"), "utf8");
}
