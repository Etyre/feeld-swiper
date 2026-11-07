/**
 * Re-scores saved decisions from their stored profile text and screens, without the phone:
 * used when the criteria change (e.g. the fit score was added) so the queue reflects the
 * current prompt and thresholds. Ping-tier results without drafts get openers drafted.
 */
import { classifyProfile, recommend } from "./classifier.js";
import { draftPings, pastPingExamples, screensOf } from "./drafts.js";
import { ContactedEliError } from "./llm.js";
import { fitPercentileOf, fitPool, getDecision, pastPings, readDecisions, updateDecision, updateMany, type Decision } from "./store.js";
import type { Settings } from "./config.js";

/**
 * Recompute every scored profile's fit percentile against the current pool and, for profiles not yet acted on,
 * its tier under the current bars. No model calls. Returns the decisions that changed.
 */
export function retier(settings: Settings): Decision[] {
  const all = readDecisions(100_000);
  const pool = fitPool();
  const patches = new Map<string, Partial<Decision>>();
  for (const d of all) {
    const c = d.classification;
    if (!c || d.applied) continue;
    const pct = typeof c.fit_probability === "number" ? fitPercentileOf(c.fit_probability, pool) : null;
    const { action, likedFor } = recommend(c, settings, pct);
    const same =
      action === d.action && likedFor === d.likedFor && (pct ?? undefined) === d.fitPercentile && d.threshold === settings.threshold && d.fitLikePercentile === settings.fitLikePercentile;
    if (same) continue;
    patches.set(d.id, {
      action,
      likedFor,
      threshold: settings.threshold,
      fitPercentile: pct ?? undefined,
      fitLikePercentile: settings.fitLikePercentile,
      pingThreshold: settings.pingEnabled ? settings.pingThreshold : undefined,
      fitPingPercentile: settings.pingEnabled ? settings.fitPingPercentile : undefined,
    });
  }
  return updateMany(patches);
}

export async function rescoreDecisions(
  ids: string[],
  settings: Settings,
  log: (m: string) => void,
  emit: (d: Decision) => void,
  shouldStop: () => boolean = () => false,
): Promise<{ done: number; failed: number }> {
  let done = 0;
  let failed = 0;
  for (const id of ids) {
    if (shouldStop()) break;
    const d = getDecision(id);
    if (!d || !d.profileText || d.applied) continue;
    try {
      const screens = await screensOf(d, settings.maxScreens);
      const r = await classifyProfile({ text: d.profileText, screens: screens.map((data) => ({ data, mediaType: "image/jpeg" as const })) }, settings);
      const c = r.classification;
      const fitPercentile = c ? fitPercentileOf(c.fit_probability, [...fitPool(), c.fit_probability]) : null;
      const { action, likedFor } = recommend(c, settings, fitPercentile);
      const patch: Partial<Decision> = {
        classification: c,
        action,
        likedFor,
        threshold: settings.threshold,
        pingThreshold: settings.pingEnabled ? settings.pingThreshold : undefined,
        fitPercentile: fitPercentile ?? undefined,
        fitLikePercentile: settings.fitLikePercentile,
        fitPingPercentile: settings.pingEnabled ? settings.fitPingPercentile : undefined,
        model: settings.model,
        effort: /haiku/i.test(settings.model) ? undefined : settings.effort,
        quickPass: undefined,
        bioOnlyProbability: undefined,
        rescoredAt: new Date().toISOString(),
        usage: { input: (d.usage?.input ?? 0) + r.usage.input, output: (d.usage?.output ?? 0) + r.usage.output, cacheRead: (d.usage?.cacheRead ?? 0) + r.usage.cacheRead },
        error: r.refused ? "Model declined to evaluate this profile." : undefined,
      };
      if (action === "recommend_ping" && !d.pingDrafts?.length) {
        try {
          const dr = await draftPings(
            { name: d.name, age: d.age, profileText: d.profileText, screens: screens.slice(0, 3), evidence: c?.evidence, pastPings: pastPingExamples(pastPings().filter((p) => p.id !== id)) },
            settings,
          );
          patch.pingDrafts = dr.drafts;
          patch.draftsModel = settings.draftModel;
        } catch (e) {
          if (e instanceof ContactedEliError) throw e;
          log(`${d.name ?? "unknown"}: drafting failed (${(e as Error).message}); you can redraft from the card.`);
        }
      }
      const updated = updateDecision(id, patch);
      if (updated) emit(updated);
      done++;
      const why = likedFor ? ` for ${likedFor === "both" ? "diet and fit" : likedFor === "veg" ? "diet" : likedFor}` : "";
      log(`Re-scored ${d.name ?? "unknown"}: P=${c ? c.probability.toFixed(2) : "n/a"}, fit ${c ? c.fit_probability.toFixed(2) : "n/a"} (${fitPercentile ?? "?"}th pct) → ${action.replace("recommend_", "recommend ").toUpperCase()}${why}`);
    } catch (e) {
      failed++;
      log(`Re-score failed for ${d.name ?? id}: ${(e as Error).message}`);
      // Stop the whole run on auth failures, and when the model asked to talk to Eli (no retry).
      if (e instanceof ContactedEliError || /401|403|api key|authentication/i.test((e as Error).message)) break;
    }
  }
  return { done, failed };
}
