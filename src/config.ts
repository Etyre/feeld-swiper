import fs from "node:fs";
import { z } from "zod";
import { SETTINGS_FILE } from "./paths.js";

export const ModelSchema = z.enum(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5", "claude-sonnet-5", "claude-fable-5-1", "claude-opus-4-8", "claude-haiku-4-5"]);

export const SettingsSchema = z.object({
  /** Recommend a like when P(veg*n) >= threshold. Nothing is sent to Feeld until you review. */
  threshold: z.number().min(0).max(1).default(0.5),
  /** Your date-me page: what you're looking for. The screener scores "fit" against it, separately from diet,
   *  and the ping drafter writes with it in mind. */
  dateMePage: z.string().max(40_000).default(""),
  /** Fit is a percentile within everything scored so far (99 = a better fit than 99% of the pool).
   *  Recommend a like when the fit percentile >= this, whatever the diet score. */
  fitLikePercentile: z.number().min(0).max(100).default(80),
  /** Recommend a ping when the fit percentile >= this. Either the diet ping bar or this one earns a ping. */
  fitPingPercentile: z.number().min(0).max(100).default(95),
  /** Recommend a ping (Feeld's super like: a message sent before matching) instead of a like when P >= this.
   *  Three openers are drafted for you to pick from at review time. */
  pingEnabled: z.boolean().default(true),
  pingThreshold: z.number().min(0).max(1).default(0.9),
  /** Notes about you for the model that drafts ping messages: who you are, what you're into, how you write. */
  pingPersona: z.string().max(4000).default(""),
  /** Model that drafts ping openers. Sonnet by default: cheap, and you edit every message anyway. */
  draftModel: ModelSchema.default("claude-sonnet-5-5"),
  /** Prior probability (0-1) that a random profile in your pool meets the criteria. */
  prior: z.number().min(0.01).max(0.99).default(0.1),
  /** Each run is a "batch": a random session length like a person browsing for a while, then stopping. */
  batchMinMinutes: z.number().min(1).max(600).default(10),
  batchMaxMinutes: z.number().min(1).max(600).default(150),
  /** After a batch, wait a random break and start the next one automatically. */
  continuous: z.boolean().default(false),
  breakMinMinutes: z.number().min(1).max(10_000).default(90),
  breakMaxMinutes: z.number().min(1).max(10_000).default(360),
  /** Only start batches between these local hours (24h). Start 9, end 23 = 9:00-22:59. */
  activeStartHour: z.number().int().min(0).max(23).default(9),
  activeEndHour: z.number().int().min(1).max(24).default(23),
  /** Stop a batch after this many profiles, judged or acted on. */
  maxProfilesPerBatch: z.number().int().min(1).max(1000).default(100),
  /** Random human-like delay between profiles, in ms. */
  minDelayMs: z.number().int().min(500).default(2500),
  maxDelayMs: z.number().int().min(500).default(7000),
  /** Browse like a person: scroll through the profile with uneven pauses, occasionally scroll back,
   *  take a longer look at profiles you're about to like. */
  humanize: z.boolean().default(true),
  /** Two-stage judging. First the profile text and the first screen. If that scores below this,
   *  recommend a pass right away without sending the other screens. Otherwise send every screen and re-score. */
  quickPassBelow: z.number().min(0).max(1).default(0.15),
  /** How many screenshots of the profile to send to the classifier (evenly spaced through the profile). */
  maxScreens: z.number().int().min(1).max(12).default(6),
  /** How to move on to the next profile WITHOUT liking or passing. Feeld lets you browse past a profile;
   *  check with the "Next (no vote)" button on the phone panel which gesture does it on your build. */
  advanceGesture: z.enum(["swipe-left", "swipe-right", "scroll-down"]).default("swipe-left"),
  /** How many screens to scroll through per profile while reading it. */
  maxProfileScrolls: z.number().int().min(1).max(30).default(12),
  model: ModelSchema.default("claude-opus-5"),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  /** How calls reach Claude. "api": the Claude API with the key in .env. "agent-sdk": the Claude Agent SDK
   *  (Claude Code as a library) with all its tools off; one prompt in, one JSON object out. */
  backend: z.enum(["api", "agent-sdk"]).default("api"),
  /** Agent SDK only. "login": drop the API key so the harness uses this machine's Claude Code sign-in.
   *  "api-key": keep the key and bill the API through the harness. */
  agentSdkAuth: z.enum(["login", "api-key"]).default("login"),
  /** Ask the model for a written reasoning paragraph on each card. Slower; the evidence list is kept either way. */
  captureReasoning: z.boolean().default(false),
  /** Free-text guidance for the model, e.g. how you want borderline diets treated. Goes into every prompt. */
  userGuidance: z.string().max(4000).default(""),
  // --- device ---
  /** Android virtual device to boot when no device is connected (created by `npm run emulator`). */
  avdName: z.string().max(60).default("feeld"),
  /** Show the emulator's own window. Normally it runs hidden and you use the phone panel in the dashboard. */
  emulatorWindow: z.boolean().default(false),
  /** Shut the emulator down when this app exits. Off keeps the phone (and your Feeld login) running between restarts. */
  stopEmulatorOnExit: z.boolean().default(false),
  /** Use a specific device (an `adb devices` serial, e.g. a real phone over USB). Empty = the emulator above. */
  deviceSerial: z.string().max(80).default(""),
  /** Where the emulator says it is. Feeld's Discover feed follows the phone's GPS. */
  city: z.enum(["berkeley", "sf", "dc", "nyc", "custom"]).default("berkeley"),
  /** Coordinates used when city is "custom". */
  latitude: z.number().min(-90).max(90).nullable().default(null),
  longitude: z.number().min(-180).max(180).nullable().default(null),
});
export type Settings = z.infer<typeof SettingsSchema>;

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    return SettingsSchema.parse(raw);
  } catch {
    const s = SettingsSchema.parse({});
    saveSettings(s);
    return s;
  }
}

export function saveSettings(s: Settings): void {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

export function updateSettings(patch: unknown): Settings {
  const merged = { ...loadSettings(), ...(patch as object) };
  const s = SettingsSchema.parse(merged);
  if (s.minDelayMs > s.maxDelayMs) s.maxDelayMs = s.minDelayMs;
  if (s.batchMinMinutes > s.batchMaxMinutes) s.batchMaxMinutes = s.batchMinMinutes;
  if (s.breakMinMinutes > s.breakMaxMinutes) s.breakMaxMinutes = s.breakMinMinutes;
  saveSettings(s);
  return s;
}
