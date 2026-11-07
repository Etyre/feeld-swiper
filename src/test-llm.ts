/**
 * End-to-end check of the model path without the phone: scores one fake profile with the
 * current Settings (model, backend, thresholds, your date-me page and guidance) exactly the
 * way a batch would, and prints the result. Proves the API key or Claude login works, the
 * shared preamble and contact_eli tool are wired in, and the structured output parses.
 *
 *   npm run test:llm                       # one fake profile, current settings
 *   npm run test:llm -- --model claude-haiku-5-5 --backend api
 *   npm run test:llm -- --contact          # also asks the model to call contact_eli: a test
 *                                          # message lands in Eli's LLM inbox (llm-inbox list)
 *
 * Nothing is written to data/; the running dashboard is not touched. Costs one model call.
 */
import "dotenv/config";
import { classifyProfile, recommend } from "./classifier.js";
import { loadSettings, type Settings } from "./config.js";
import { ContactedEliError, backendLabel, structuredCall } from "./llm.js";
import { fitPercentileOf, fitPool } from "./store.js";
import { z } from "zod";

const FAKE_PROFILE = `Maya · 31 · Woman · Straight
Desires: Long-term, Friends
Interests: Hiking, Pottery, Live music
Bio: Vegan for ten years, mostly for the animals. Weekend hikes, weeknight pottery, always up for a gig. Looking for someone kind who reads. 🌱
Verified`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const base = loadSettings();
  const settings: Settings = {
    ...base,
    ...(arg("model") ? { model: arg("model") as Settings["model"] } : {}),
    ...(arg("backend") ? { backend: arg("backend") as Settings["backend"] } : {}),
  };
  console.log(`Backend: ${backendLabel(settings)} · screener ${settings.model} (${settings.effort})`);

  if (process.argv.includes("--contact")) {
    console.log("Asking the model to call contact_eli with a test message…");
    try {
      const r = await structuredCall(
        {
          model: settings.model,
          effort: "low",
          maxTokens: 500,
          system: ["This is a wiring test of the contact_eli tool run by Eli himself. Call the contact_eli tool once with the message 'Test message from feeld-swiper test:llm --contact'. Do not return anything else."],
          content: [{ type: "text", text: "Please run the wiring test now." }],
          schema: z.object({ ok: z.boolean() }),
        },
        settings,
      );
      console.log("The model did NOT contact Eli; it returned:", JSON.stringify(r.parsed));
      process.exitCode = 1;
    } catch (e) {
      if (e instanceof ContactedEliError) {
        console.log("OK: contact recorded and Eli notified. Record:\n" + e.record);
        return;
      }
      throw e;
    }
    return;
  }

  const started = Date.now();
  const r = await classifyProfile({ text: FAKE_PROFILE, screens: [] }, settings);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (r.refused) {
    console.log(`The model declined to evaluate the fake profile (${secs}s).`);
    process.exitCode = 1;
    return;
  }
  const c = r.classification;
  if (!c) throw new Error("No classification came back.");
  const pct = fitPercentileOf(c.fit_probability, [...fitPool(), c.fit_probability]);
  const rec = recommend(c, settings, pct);
  console.log(`OK in ${secs}s: ${c.name ?? "?"}${c.age ? `, ${c.age}` : ""} → P(veg*n)=${c.probability.toFixed(2)} (arithmetic ${c.arithmetic_probability}), fit=${c.fit_probability.toFixed(2)} (${pct}th pct) → ${rec.action}`);
  for (const e of c.evidence) console.log(`  ${e.criterion} ${e.direction.padEnd(7)} LR ${String(e.likelihood_ratio).padStart(5)}  ${e.observation}`);
  console.log(`Tokens: ${r.usage.input} in, ${r.usage.cacheRead} cached, ${r.usage.output} out.`);
  if (c.probability < 0.5) {
    console.log("Unexpected: the fake profile says 'Vegan for ten years' and should score well above 0.5.");
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof ContactedEliError ? e.message : e);
  process.exitCode = 1;
});
