import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { buildSystemPrompt, buildFeedbackPrompt } from "./prompt.js";
import { feedbackExamples, exemplarProfiles } from "./store.js";
import { EXCEPTION_THRESHOLD, type Settings } from "./config.js";

const EvidenceSchema = z.object({
  criterion: z.enum(["veg", "intellectual"]),
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
  intellectual_probability: z.number().min(0).max(1),
  intellectual_exception: z.boolean(),
});
/** Same call without the reasoning paragraph: fewer output tokens, faster. */
export const TerseClassificationSchema = z.object({
  name: z.string().nullable(),
  age: z.number().int().nullable(),
  dietary_badge: z.string().nullable(),
  evidence: z.array(EvidenceSchema),
  probability: z.number().min(0).max(1),
  intellectual_probability: z.number().min(0).max(1),
  intellectual_exception: z.boolean(),
});
export type Classification = z.infer<typeof ClassificationSchema> & {
  /** Posterior from the prior and the listed diet ratios: prior odds × Π LR. Computed here, not by the model. */
  arithmetic_probability?: number;
};

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

const client = new Anthropic();

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
      ? "Estimate the diet probability and decide the intellectual exception for this profile. Follow the Bayesian procedure and return the JSON object."
      : "Estimate the diet probability and decide the intellectual exception for this profile. Follow the Bayesian procedure and return the JSON object. Keep it terse: at most 5 evidence items, each observation under 12 words, no prose.",
  });

  // Haiku 4.5 predates adaptive thinking and the effort parameter; every other
  // offered model (Opus 5, Sonnet 5, Opus 4.8, Fable 5.1) takes both.
  const isHaiku = /haiku/i.test(settings.model);
  // Stable prompt first (cached), then the user's guidance and graded examples, which change rarely.
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: buildSystemPrompt(settings.prior), cache_control: { type: "ephemeral" } },
  ];
  const feedback = buildFeedbackPrompt(
    settings.userGuidance,
    feedbackExamples(40).map((d) => ({
      name: d.name,
      age: d.age,
      modelProbability: d.classification!.probability,
      verdict: d.verdict,
      userProbability: d.userProbability,
      note: d.note,
      profileSnippet: (d.profileText ?? "").replace(/\s+/g, " ").slice(0, 220),
    })),
    exemplarProfiles().map((d) => ({ name: d.name, age: d.age, text: d.profileText ?? "" })),
  );
  if (feedback) system.push({ type: "text", text: feedback });

  const response = await client.messages.parse({
    model: settings.model,
    max_tokens: 4000,
    ...(isHaiku ? {} : { thinking: { type: "adaptive" as const } }),
    output_config: {
      ...(isHaiku ? {} : { effort: settings.effort }),
      format: zodOutputFormat(settings.captureReasoning ? ClassificationSchema : TerseClassificationSchema),
    },
    system,
    messages: [{ role: "user", content }],
  });

  const usage = {
    input: response.usage.input_tokens,
    output: response.usage.output_tokens,
    cacheRead: response.usage.cache_read_input_tokens ?? 0,
  };

  if (response.stop_reason === "refusal") {
    return { classification: null, refused: true, usage };
  }
  const parsed = response.parsed_output as Partial<Classification> | null | undefined;
  const classification: Classification | null = parsed ? ({ reasoning: "", ...parsed } as Classification) : null;
  if (classification) {
    // The exception is off by default; only positive evidence for it is meaningful.
    classification.evidence = classification.evidence.filter((e) => e.criterion !== "intellectual" || e.direction === "for");
    // Keep the model's own number ("gut check") untouched; the arithmetic posterior is recorded alongside it.
    classification.arithmetic_probability = arithmeticPosterior(settings.prior, classification.evidence);
    // The exception is exactly "probability at or above the threshold", whatever the model's own flag said.
    classification.intellectual_exception = classification.intellectual_probability >= EXCEPTION_THRESHOLD;
  }
  return { classification, refused: false, usage };
}
