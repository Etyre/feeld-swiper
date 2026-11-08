import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { structuredCall } from "./llm.js";
import { buildSystemPrompt, buildFeedbackPrompt } from "./prompt.js";
import { feedbackExamples, exemplarProfiles } from "./store.js";
import type { Settings } from "./config.js";

const EvidenceSchema = z.object({
  criterion: z.enum(["veg", "fit"]),
  observation: z.string(),
  direction: z.enum(["for", "against", "neutral"]),
  likelihood_ratio: z.number(),
});
export const ClassificationSchema = z.object({
  name: z.string().nullable(),
  age: z.number().int().nullable(),
  dietary_badge: z.string().nullable(),
  evidence: z.array(EvidenceSchema),
  reasoning: z.string(),
  probability: z.number().min(0).max(1),
  fit_probability: z.number().min(0).max(1),
});
/** Same call without the reasoning paragraph: fewer output tokens, faster. */
export const TerseClassificationSchema = z.object({
  name: z.string().nullable(),
  age: z.number().int().nullable(),
  dietary_badge: z.string().nullable(),
  evidence: z.array(EvidenceSchema),
  probability: z.number().min(0).max(1),
  fit_probability: z.number().min(0).max(1),
});
export type Classification = z.infer<typeof ClassificationSchema> & {
  /** Posterior from the prior and the listed diet ratios: prior odds × Π LR. Computed here, not by the model. */
  arithmetic_probability?: number;
  /** The retired "intellectual exception", present on old records only. */
  intellectual_probability?: number;
  intellectual_exception?: boolean;
};

/** Which tier a scored profile lands in under the current thresholds, and which criterion put it there. */
export function recommend(c: Classification | null, settings: Settings, fitPercentile: number | null): { action: "recommend_ping" | "recommend_like" | "recommend_pass" | "skipped"; likedFor?: "veg" | "fit" | "both" } {
  if (!c) return { action: "skipped" };
  const fit = typeof fitPercentile === "number" ? fitPercentile : -1;
  const vegPing = settings.pingEnabled && c.probability >= settings.pingThreshold;
  const fitPing = settings.pingEnabled && fit >= settings.fitPingPercentile;
  const vegLike = c.probability >= settings.threshold;
  const fitLike = fit >= settings.fitLikePercentile;
  if (vegPing || fitPing) return { action: "recommend_ping", likedFor: vegPing && fitPing ? "both" : vegPing ? "veg" : "fit" };
  if (vegLike || fitLike) return { action: "recommend_like", likedFor: vegLike && fitLike ? "both" : vegLike ? "veg" : "fit" };
  return { action: "recommend_pass" };
}

/** Multiply the prior odds by every listed diet likelihood ratio. */
export function arithmeticPosterior(prior: number, evidence: { criterion: string; likelihood_ratio: number }[]): number {
  const p = Math.min(0.99, Math.max(0.01, prior));
  let odds = p / (1 - p);
  for (const e of evidence) {
    if (e.criterion !== "veg") continue;
    if (!(e.likelihood_ratio > 0)) continue;
    odds *= e.likelihood_ratio;
  }
  return Math.round((odds / (1 + odds)) * 1000) / 1000;
}

export interface ProfileInput {
  text: string;
  /** Screenshots of the profile, top to bottom, as JPEG or PNG. */
  screens: { data: Buffer; mediaType: "image/jpeg" | "image/png" }[];
}

export interface ClassifyResult {
  classification: Classification | null;
  refused: boolean;
  usage: { input: number; output: number; cacheRead: number };
}

export async function classifyProfile(profile: ProfileInput, settings: Settings): Promise<ClassifyResult> {
  const content: Anthropic.ContentBlockParam[] = [];

  content.push({
    type: "text",
    text: `PROFILE TEXT (read from the app's accessibility tree; may include UI noise):\n\n${profile.text.slice(0, 12_000)}`,
  });

  profile.screens.forEach((s, i) => {
    content.push({ type: "text", text: `Screen ${i + 1} of ${profile.screens.length} (the profile scrolled from the top):` });
    content.push({
      type: "image",
      source: { type: "base64", media_type: s.mediaType, data: s.data.toString("base64") },
    });
  });

  content.push({
    type: "text",
    text: settings.captureReasoning
      ? "Estimate the diet probability and the fit probability for this profile. Follow the Bayesian procedure for diet and the fit guidance, and return the JSON object."
      : "Estimate the diet probability and the fit probability for this profile. Follow the Bayesian procedure for diet and the fit guidance, and return the JSON object. Keep it terse: at most 4 diet and 4 fit evidence items, each observation under 12 words, no prose.",
  });

  // Stable prompt first (cached), then the user's guidance and graded examples, which change rarely.
  const system: string[] = [buildSystemPrompt(settings.prior, settings.dateMePage)];
  const feedback = buildFeedbackPrompt(
    settings.userGuidance,
    feedbackExamples(40).map((d) => ({
      name: d.name,
      age: d.age,
      modelProbability: d.classification!.probability,
      fitProbability: d.classification!.fit_probability,
      fitPercentile: d.fitPercentile,
      verdict: d.verdict,
      userProbability: d.userProbability,
      fitVerdict: d.fitVerdict,
      userFitPercentile: d.userFitPercentile,
      note: d.note,
      profileSnippet: (d.profileText ?? "").replace(/\s+/g, " ").slice(0, 220),
      recommendation: d.action,
      review: d.review,
      likedFor: d.likedFor,
    })),
    exemplarProfiles().map((d) => ({ name: d.name, age: d.age, text: d.profileText ?? "" })),
  );
  if (feedback) system.push(feedback);

  const response = await structuredCall(
    {
      model: settings.model,
      effort: settings.effort,
      maxTokens: 4000,
      system,
      content,
      schema: settings.captureReasoning ? ClassificationSchema : TerseClassificationSchema,
    },
    settings,
  );
  const usage = response.usage;

  if (response.refused) {
    return { classification: null, refused: true, usage };
  }
  const parsed = response.parsed as Partial<Classification> | null;
  const classification: Classification | null = parsed ? ({ reasoning: "", ...parsed } as Classification) : null;
  if (classification) {
    // Keep the model's own number ("gut check") untouched; the arithmetic posterior is recorded alongside it.
    classification.arithmetic_probability = arithmeticPosterior(settings.prior, classification.evidence);
    if (!settings.dateMePage.trim()) classification.fit_probability = Math.min(classification.fit_probability, 0.1);
  }
  return { classification, refused: false, usage };
}
