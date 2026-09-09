/**
 * Drafts ping openers. A ping on Feeld is a like that carries a message, so when the
 * screener recommends one (or you decide to ping someone), a stronger model writes
 * three openers in your voice for you to pick from, or reject and write your own.
 */
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { PHOTOS_DIR } from "./paths.js";
import { jpegForModel } from "./feeld.js";
import type { Settings } from "./config.js";
import type { Decision, PingDraft } from "./store.js";

const DraftsSchema = z.object({
  drafts: z.array(z.object({ angle: z.string(), text: z.string() })),
});

/** Feeld caps ping messages; keep drafts comfortably under it. */
export const MAX_PING_CHARS = 280;

export interface DraftInput {
  name: string | null;
  age: number | null;
  profileText: string;
  /** JPEG screenshots of the profile, top to bottom; a few are enough. */
  screens: Buffer[];
  /** What the screener noticed, so the drafts can build on it. */
  evidence?: { criterion: string; observation: string; direction: string }[];
}

export interface DraftResult {
  drafts: PingDraft[];
  usage: { input: number; output: number; cacheRead: number };
}

const client = new Anthropic();

function systemPrompt(persona: string): string {
  const about = persona.trim()
    ? `## About the person sending the message\n${persona.trim()}`
    : "## About the person sending the message\nNo notes were given. Keep the messages about the other person's profile and end with a question; do not invent facts about the sender.";
  return `You write the opening message for a "ping" on the dating app Feeld: a like that carries a message, delivered before the two people have matched. It is the first thing the recipient reads from the sender, so it has to earn a reply.

${about}

## What to write
Write exactly three openers, each taking a different angle:
1. "detail + question": pick one specific, non-physical detail from their profile (a line in the bio, an Interest or Desire, a prompt answer, a place or activity in a photo) and ask a light, genuine question about it.
2. "playful": warm and a little teasing about something they wrote, never at their expense, ending with an easy hook to reply to.
3. "sincere": direct and unshowy about what made the sender want to reach out, with one specific reason drawn from the profile.

## Rules
- One to three sentences each, at most ${MAX_PING_CHARS} characters. Plain text, no hashtags, no sign-off.
- Sound like a specific real person typing on a phone, in the sender's voice from the notes above (register, humour, punctuation habits). Not a copywriter, not a chatbot.
- No comments on looks, body, or photos of their appearance. No pickup lines, no "hey beautiful", no flattery about how "amazing" the profile is.
- Do not mention screening, algorithms, probabilities, or anything about how the profile was found. If their profile shows a diet or animal-ethics stance that the sender's notes share, connecting over it is welcome; otherwise do not raise diet.
- Do not claim things about the sender that are not in the notes. Do not claim to have met them or to know them.
- Match the language of their profile. Use emojis only if the sender's notes suggest it.
- If the profile is a couple, address them as a couple.
- Each draft must be usable as-is: no placeholders, no brackets, no options inside the text.

Return a JSON object with "drafts": three items, each with "angle" (one of "detail + question", "playful", "sincere") and "text".`;
}

export async function draftPings(input: DraftInput, settings: Settings): Promise<DraftResult> {
  const content: Anthropic.ContentBlockParam[] = [];
  const who = `${input.name ?? "Unknown"}${input.age ? `, ${input.age}` : ""}`;
  content.push({ type: "text", text: `THEIR PROFILE (${who}), text read from the app; may include UI noise:\n\n${input.profileText.slice(0, 8000)}` });
  if (input.evidence?.length) {
    const lines = input.evidence.filter((e) => e.direction === "for").map((e) => `- ${e.observation}`);
    if (lines.length) content.push({ type: "text", text: `Things a screener noticed in the profile (possible hooks):\n${lines.join("\n")}` });
  }
  input.screens.forEach((s, i) => {
    content.push({ type: "text", text: `Screen ${i + 1} of ${input.screens.length}:` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: s.toString("base64") } });
  });
  content.push({ type: "text", text: "Write the three openers and return the JSON object." });

  const isHaiku = /haiku/i.test(settings.draftModel);
  const response = await client.messages.parse({
    model: settings.draftModel,
    max_tokens: 2000,
    ...(isHaiku ? {} : { thinking: { type: "adaptive" as const } }),
    output_config: {
      ...(isHaiku ? {} : { effort: "high" as const }),
      format: zodOutputFormat(DraftsSchema),
    },
    system: [{ type: "text", text: systemPrompt(settings.pingPersona), cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content }],
  });
  const usage = {
    input: response.usage.input_tokens,
    output: response.usage.output_tokens,
    cacheRead: response.usage.cache_read_input_tokens ?? 0,
  };
  if (response.stop_reason === "refusal") throw new Error("The model declined to draft messages for this profile.");
  const parsed = response.parsed_output as z.infer<typeof DraftsSchema> | null | undefined;
  const drafts = (parsed?.drafts ?? [])
    .map((d) => ({ angle: d.angle.trim(), text: d.text.trim().slice(0, MAX_PING_CHARS) }))
    .filter((d) => d.text)
    .slice(0, 3);
  if (!drafts.length) throw new Error("The model returned no drafts.");
  return { drafts, usage };
}

/** Load a few of a decision's saved screens from disk, sized for the model. */
export async function screensOf(d: Decision, n = 3): Promise<Buffer[]> {
  const urls = (d.screens?.length ? d.screens : d.photos).slice(0, n);
  const out: Buffer[] = [];
  for (const url of urls) {
    const rel = url.replace(/^\/photos\//, "");
    const file = path.join(PHOTOS_DIR, rel);
    if (!fs.existsSync(file)) continue;
    try {
      out.push(await jpegForModel(fs.readFileSync(file)));
    } catch {
      /* unreadable image; skip */
    }
  }
  return out;
}
