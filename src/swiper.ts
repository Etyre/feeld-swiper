import { EventEmitter } from "node:events";
import { AdbClient } from "./android.js";
import { FeeldDriver, SELECTORS, jpegForModel } from "./feeld.js";
import { bootEmulator, runningEmulatorFor, stopEmulator } from "./emulator.js";
import { classifyProfile } from "./classifier.js";
import { draftPings } from "./drafts.js";
import { appendDecision, decisionsFor, queueSummary, updateDecision, type Action, type Decision } from "./store.js";
import { loadSettings, type Settings } from "./config.js";

export type Status = "idle" | "booting" | "setup_needed" | "awaiting_login" | "running" | "stopping" | "stopped" | "waiting" | "error";

export interface SwiperState {
  status: Status;
  /** Likes, pings and passes actually sent to Feeld in this batch. */
  swipesThisSession: number;
  lastError: string | null;
  current: { name: string | null; fingerprint: string; doing: "reading" | "judging" | "drafting" | "applying" | "moving on" } | null;
  /** The batch in progress: when it started, when it will end, how many profiles judged and how many reviews applied. */
  batch: { id: string; startedAt: string; endsAt: string; plannedMinutes: number; evaluated: number; applied: number } | null;
  /** When the next batch is scheduled to start (continuous mode). */
  nextBatchAt: string | null;
  /** Why the last batch ended. */
  lastBatchEnd: string | null;
  /** The phone we're driving. */
  device: { serial: string; model: string; size: { w: number; h: number } | null; avd: string | null } | null;
  /** What the phone is showing, as last seen by the loop. */
  deck: string | null;
}

/** "22 miles away" / "35 km away" from the profile text, in miles. */
function parseDistance(text: string): number | undefined {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(miles?|mi|km|kilomet\w+)\s+away/i);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  return /k/i.test(m[2]) ? Math.round(n * 0.621371) : n;
}

/** Move a timestamp forward to the next window between start and end hour (local time). */
function pushIntoActiveHours(t: Date, startHour: number, endHour: number): Date {
  const d = new Date(t);
  const h = d.getHours() + d.getMinutes() / 60;
  if (h >= startHour && h < endHour) return d;
  if (h >= endHour) d.setDate(d.getDate() + 1);
  d.setHours(startHour, Math.floor(rand(0, 45)), 0, 0);
  return d;
}

/** Evenly spaced sample of up to n items, always keeping the first. */
function sample<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.round((i * (items.length - 1)) / (n - 1))]);
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

function describeKnown(d: Decision): string {
  if (d.applied) return `${d.applied} already sent`;
  if (d.review === "skip") return "you chose to leave it";
  if (d.review) return `queued: ${d.review}`;
  return "awaiting your review";
}

export class Swiper extends EventEmitter {
  state: SwiperState = {
    status: "idle",
    swipesThisSession: 0,
    lastError: null,
    current: null,
    batch: null,
    nextBatchAt: null,
    lastBatchEnd: null,
    device: null,
    deck: null,
  };
  readonly client: AdbClient;
  readonly driver: FeeldDriver;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private stopRequested = false;
  private loopPromise: Promise<void> | null = null;
  private devicePromise: Promise<boolean> | null = null;
  /** Serial of the emulator this process booted (so it can be stopped on exit if asked). */
  private bootedSerial: string | null = null;
  /** Consecutive profiles where the card refused to move; the batch gives up at 4. */
  private stuck = 0;

  constructor() {
    super();
    this.client = new AdbClient();
    this.driver = new FeeldDriver(this.client, (m) => this.log(m));
  }

  log(message: string): void {
    this.emit("log", { at: new Date().toISOString(), message });
  }

  private setStatus(status: Status): void {
    this.state.status = status;
    this.emit("state", this.state);
  }

  private setDeck(deck: string | null): void {
    if (this.state.deck !== deck) {
      this.state.deck = deck;
      this.emit("state", this.state);
    }
  }

  private setCurrent(current: SwiperState["current"]): void {
    this.state.current = current;
    this.emit("state", this.state);
  }

  /**
   * Make sure a phone is connected: the configured serial, or the emulator (booting it if needed).
   * Safe to call repeatedly; concurrent callers share one attempt.
   */
  ensureDevice(): Promise<boolean> {
    if (this.devicePromise) return this.devicePromise;
    this.devicePromise = this.ensureDeviceInner().finally(() => {
      this.devicePromise = null;
    });
    return this.devicePromise;
  }

  private async ensureDeviceInner(): Promise<boolean> {
    const settings = loadSettings();
    if (!this.client.adbPath) {
      this.log("adb was not found. Install it with: brew install --cask android-platform-tools");
      return false;
    }
    let serial: string | null = null;
    if (settings.deviceSerial) {
      serial = settings.deviceSerial;
    } else {
      serial = await runningEmulatorFor(this.client, settings.avdName);
      if (!serial) {
        const prev = this.state.status;
        this.setStatus("booting");
        serial = await bootEmulator({ client: this.client, avdName: settings.avdName, window: settings.emulatorWindow, log: (m) => this.log(m) });
        if (serial) this.bootedSerial = serial;
        if (this.state.status === "booting") this.setStatus(prev === "booting" ? "idle" : prev);
      }
    }
    this.client.pin(serial);
    const dev = await this.client.ensureDevice();
    if (!dev) {
      this.state.device = null;
      this.emit("state", this.state);
      return false;
    }
    const avd = await this.client.avdNameOf(dev.serial);
    const changed = this.state.device?.serial !== dev.serial;
    this.state.device = { serial: dev.serial, model: dev.model, size: this.client.size, avd };
    if (changed) {
      this.log(`Device: ${dev.serial}${dev.model ? ` (${dev.model})` : ""}${avd ? `, AVD "${avd}"` : ""}, screen ${this.client.size?.w}x${this.client.size?.h}`);
      this.emit("state", this.state);
    }
    return true;
  }

  /**
   * Start a batch now (cancels any scheduled one). A batch browses Discover for a random
   * human-length session: profiles you've reviewed get your like / ping / pass when they
   * come up; new profiles are judged provisionally and browsed past without a vote.
   */
  async start(): Promise<void> {
    if (this.loopPromise) return;
    this.cancelSchedule();
    this.stopRequested = false;
    this.state.swipesThisSession = 0;
    this.state.lastError = null;
    this.state.lastBatchEnd = null;
    const settings = loadSettings();
    const minutes = Math.round(rand(settings.batchMinMinutes, settings.batchMaxMinutes));
    const startedAt = new Date();
    this.state.batch = {
      id: startedAt.toISOString(),
      startedAt: startedAt.toISOString(),
      endsAt: new Date(startedAt.getTime() + minutes * 60_000).toISOString(),
      plannedMinutes: minutes,
      evaluated: 0,
      applied: 0,
    };
    const q = queueSummary();
    const queued = q.like + q.ping + q.pass;
    this.log(
      `Starting a ${minutes}-minute batch. ${queued ? `Queued from your reviews: ${q.like} like${q.like === 1 ? "" : "s"}, ${q.ping} ping${q.ping === 1 ? "" : "s"}, ${q.pass} pass${q.pass === 1 ? "" : "es"}` : "Nothing queued from reviews"}; new profiles are judged and left for you to review${q.pending ? ` (${q.pending} already waiting)` : ""}.`,
    );
    this.loopPromise = this.run()
      .finally(() => {
        this.loopPromise = null;
      })
      .then(() => this.afterBatch());
  }

  private cancelSchedule(): void {
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    this.scheduleTimer = null;
    this.state.nextBatchAt = null;
  }

  /** Continuous mode: pick a break, push it into active hours, and schedule the next batch. */
  private afterBatch(): void {
    const settings = loadSettings();
    const endedByUser = this.stopRequested;
    if (endedByUser || this.state.status === "error" || !settings.continuous) return;
    const breakMs = rand(settings.breakMinMinutes, settings.breakMaxMinutes) * 60_000;
    let next = new Date(Date.now() + breakMs);
    next = pushIntoActiveHours(next, settings.activeStartHour, settings.activeEndHour);
    this.state.nextBatchAt = next.toISOString();
    this.setStatus("waiting");
    this.log(`Next batch scheduled for ${next.toLocaleString()}.`);
    this.scheduleTimer = setTimeout(() => {
      this.scheduleTimer = null;
      void this.start();
    }, Math.max(1000, next.getTime() - Date.now()));
  }

  private endBatch(reason: string): void {
    this.state.lastBatchEnd = reason;
    this.log(`Batch over: ${reason}`);
  }

  async stop(): Promise<void> {
    this.cancelSchedule();
    if (!this.loopPromise) {
      if (this.state.status === "waiting") this.setStatus("stopped");
      return;
    }
    this.stopRequested = true;
    this.setStatus("stopping");
    await this.loopPromise;
  }

  /** Get the phone up, Feeld installed and on Discover, and wait for a login if there isn't one. */
  private async openDeck(): Promise<boolean> {
    if (!(await this.ensureDevice())) {
      this.log("No Android device. Check the emulator (Settings → Device) or plug in a phone.");
      return false;
    }
    this.driver.forgetInstalled();
    if (!(await this.driver.isInstalled())) {
      this.setStatus("setup_needed");
      this.log("Feeld is not installed on the phone. Use the Setup panel (Google sign-in + Play Store install).");
      return false;
    }
    await this.driver.goToDiscover();
    const { state } = await this.driver.observe();
    this.setDeck(state);
    if (state === "logged-out" || state === "unknown" || state === "off-app") {
      this.setStatus("awaiting_login");
      this.log("Not logged in to Feeld (or not on Discover). Log in on the phone panel; waiting up to 15 minutes…");
      const ok = await this.driver.waitForLogin(15 * 60_000, () => this.stopRequested);
      if (!ok) {
        this.log(this.stopRequested ? "Stopped while waiting for login." : "Timed out waiting for login.");
        return false;
      }
      this.log("Feeld is on Discover.");
    }
    return true;
  }

  /**
   * Is the profile on screen one we've judged before? Matched by the name-and-age fingerprint,
   * and, to tell apart two people with the same name and age, the visible text has to agree
   * with what was read the first time.
   */
  private recognise(fingerprint: string, strings: string[]): Decision | null {
    const cands = decisionsFor(fingerprint);
    if (!cands.length) return null;
    const probe = strings.filter((s) => s.length >= 8 && !SELECTORS.chrome.test(s));
    return (
      cands.find((d) => {
        if (!probe.length || !d.profileText) return true;
        const hits = probe.filter((s) => d.profileText!.includes(s)).length;
        return hits >= Math.ceil(probe.length * 0.5);
      }) ?? null
    );
  }

  /**
   * Browse past the profile on screen without voting. Returns false when the batch should end
   * (the gesture turned out to be a like, or the card won't move).
   */
  private async moveOn(settings: Settings): Promise<boolean> {
    const r = await this.driver.advance(settings.advanceGesture);
    if (r === "match") {
      await this.driver.dismissPopups().catch(() => null);
      this.endBatch(`the "${settings.advanceGesture}" gesture produced a match screen, so on this build it counts as a like. Pick another "Next profile gesture" in Settings and test it with the Next (no vote) button before running again.`);
      return false;
    }
    if (r === "blocked") return true; // the loop's screen check deals with it
    if (r === "stuck") {
      this.stuck++;
      const { state: now } = await this.driver.observe();
      this.setDeck(now);
      this.log(`The card didn't move on after the "${settings.advanceGesture}" gesture${now !== "discover" ? ` (screen: ${now})` : ""}.`);
      if (this.stuck >= 4) {
        const shot = await this.driver.saveErrorScreenshot("stuck");
        this.endBatch(`the card didn't move 4 times in a row${shot ? ` (screenshot: ${shot})` : ""}. Try another "Next profile gesture" in Settings.`);
        return false;
      }
      await sleep(2000);
      return true;
    }
    this.stuck = 0;
    return true;
  }

  /** The profile on screen has your review: do it on Feeld. Returns false when the batch should end. */
  private async applyReview(d: Decision, settings: Settings): Promise<boolean> {
    const want = d.review as Action;
    this.setCurrent({ name: d.name, fingerprint: d.fingerprint, doing: "applying" });
    this.log(`${d.name ?? "unknown"}: applying your review → ${want}${want === "ping" ? ` ("${(d.pingMessage ?? "").slice(0, 60)}${(d.pingMessage ?? "").length > 60 ? "…" : ""}")` : ""}.`);
    if (settings.humanize) await this.driver.skim();
    let applied: Action | null = null;
    let note: string | null = null;
    if (want === "ping" && d.pingMessage?.trim()) {
      const r = await this.driver.ping(d.pingMessage.trim());
      if (r === "ping") applied = "ping";
      else {
        note = r === "unavailable" ? "No ping available (out of pings, or no Ping button); sent a like instead." : "The ping didn't go through; sent a like instead.";
        this.log(note);
        if (await this.driver.vote("like")) applied = "like";
      }
    } else {
      const kind: "like" | "pass" = want === "pass" ? "pass" : "like";
      if (want === "ping") note = "No ping message was saved; sent a like instead.";
      if (kind === "like" && settings.humanize) await this.driver.lingerBeforeLike();
      if (await this.driver.vote(kind)) applied = kind;
    }
    if (!applied) {
      this.stuck++;
      const { state: now } = await this.driver.observe();
      this.setDeck(now);
      if (now === "out-of-likes") {
        this.endBatch("Feeld says you're out of likes.");
        return false;
      }
      this.log(`The card didn't advance after the ${want}${now !== "discover" ? ` (screen: ${now})` : ""}.`);
      if (this.stuck >= 4) {
        const shot = await this.driver.saveErrorScreenshot("stuck");
        this.endBatch(`the card didn't advance 4 times in a row${shot ? ` (screenshot: ${shot})` : ""}.`);
        return false;
      }
      await sleep(2000);
      return true;
    }
    this.stuck = 0;
    const updated = updateDecision(d.id, { applied, appliedAt: new Date().toISOString(), applyNote: note });
    if (updated) this.emit("decision", updated);
    this.state.swipesThisSession++;
    if (this.state.batch) this.state.batch.applied++;
    this.emit("state", this.state);
    await sleep(rand(settings.minDelayMs, settings.maxDelayMs));
    return true;
  }

  /** A profile we haven't seen: read it, judge it provisionally, draft pings if it's a ping, and record it. */
  private async judgeNew(settings: Settings): Promise<"ok" | "no-card" | "stop"> {
    this.setCurrent({ name: null, fingerprint: "", doing: "reading" });
    const profile = await this.driver.readProfile(settings);
    if (!profile) return "no-card";
    if (this.state.batch) this.state.batch.evaluated++;
    this.setCurrent({ name: profile.name, fingerprint: profile.fingerprint, doing: "judging" });
    this.log(`Evaluating ${profile.name ?? "unknown"}${profile.age ? `, ${profile.age}` : ""} (${profile.screens.length} screens, ${profile.photos.length} photos)…`);

    const id = `${Date.now().toString(36)}-${profile.fingerprint}`;
    const screenUrls = this.driver.saveImages(id, profile.screens, "s");
    const photoUrls = profile.photos.length ? this.driver.saveImages(id, profile.photos) : screenUrls;
    const distance = parseDistance(profile.text);
    const base = {
      id,
      at: new Date().toISOString(),
      ...(this.state.batch ? { batchId: this.state.batch.id } : {}),
      fingerprint: profile.fingerprint,
      threshold: settings.threshold,
      name: profile.name,
      age: profile.age,
      photos: photoUrls,
      screens: screenUrls,
      profileText: profile.text,
      ...(distance !== undefined ? { distanceMiles: distance } : {}),
    };

    let decision: Decision;
    let forModel: Buffer[] = [];
    try {
      forModel = await Promise.all(sample(profile.screens, settings.maxScreens).map(jpegForModel));
      const asInput = (bufs: Buffer[]) => ({ text: profile.text, screens: bufs.map((data) => ({ data, mediaType: "image/jpeg" as const })) });
      // Stage 1: the text plus the first screen only.
      const first = await classifyProfile(asInput(forModel.slice(0, 1)), settings);
      let c = first.classification;
      const usage = { ...first.usage };
      let bioOnlyProbability: number | undefined;
      let quickPass = false;
      const intEarnsLike = !!c && settings.intellectualEnabled && c.intellectual_exception;
      if (c && (settings.quickPassBelow >= 1 || c.probability < settings.quickPassBelow) && !intEarnsLike) {
        quickPass = true;
        this.log(`${c.name ?? profile.name ?? "unknown"}: text-and-first-screen P=${c.probability.toFixed(2)}${c.probability < settings.threshold ? " → quick pass." : ", no further look needed."}`);
      } else if (c && forModel.length > 1) {
        // Stage 2: worth a proper look. Send every screen and re-score with the full set.
        bioOnlyProbability = c.probability;
        this.log(`${c.name ?? profile.name ?? "unknown"}: text-and-first-screen P=${c.probability.toFixed(2)}, looking at all ${forModel.length} screens…`);
        const second = await classifyProfile(asInput(forModel), settings);
        if (second.classification) c = second.classification;
        usage.input += second.usage.input;
        usage.output += second.usage.output;
        usage.cacheRead += second.usage.cacheRead;
      }
      const vegLike = !!c && c.probability >= settings.threshold;
      const intLike = !!c && settings.intellectualEnabled && c.intellectual_exception;
      const likes = vegLike || intLike;
      const likedFor: Decision["likedFor"] | undefined = vegLike && intLike ? "both" : vegLike ? "veg" : intLike ? "intellectual" : undefined;
      const pings = likes && settings.pingEnabled && c!.probability >= settings.pingThreshold;
      const action: Decision["action"] = !c ? "skipped" : pings ? "recommend_ping" : likes ? "recommend_like" : "recommend_pass";
      decision = {
        ...base,
        action,
        ...(settings.pingEnabled ? { pingThreshold: settings.pingThreshold } : {}),
        ...(likedFor ? { likedFor } : {}),
        name: c?.name ?? profile.name,
        age: c?.age ?? profile.age,
        classification: c,
        usage,
        ...(bioOnlyProbability !== undefined ? { bioOnlyProbability } : {}),
        ...(quickPass ? { quickPass } : {}),
        model: settings.model,
        ...(/haiku/i.test(settings.model) ? {} : { effort: settings.effort }),
        ...(first.refused ? { error: "Model declined to evaluate this profile." } : {}),
      };
    } catch (e) {
      const msg = (e as Error).message;
      this.log(`Classifier error: ${msg}`);
      decision = { ...base, action: "skipped", classification: null, error: msg };
      if (/401|403|api key|authentication/i.test(msg)) {
        appendDecision(decision);
        this.emit("decision", decision);
        this.state.lastError = msg;
        this.setStatus("error");
        return "stop";
      }
    }

    if (decision.action === "recommend_ping") {
      this.setCurrent({ name: decision.name, fingerprint: profile.fingerprint, doing: "drafting" });
      this.log(`${decision.name ?? "unknown"}: drafting three ping openers with ${settings.draftModel}…`);
      try {
        const r = await draftPings(
          { name: decision.name, age: decision.age, profileText: profile.text, screens: forModel.slice(0, 3), evidence: decision.classification?.evidence },
          settings,
        );
        decision.pingDrafts = r.drafts;
        decision.draftsModel = settings.draftModel;
      } catch (e) {
        this.log(`Drafting failed: ${(e as Error).message}. You can retry from the review card.`);
      }
    }

    appendDecision(decision);
    this.emit("decision", decision);
    const p = decision.classification?.probability;
    const ex = decision.classification?.intellectual_exception ? " 🧠 EXCEPTION" : "";
    this.log(`${decision.name ?? "unknown"}: P=${p === undefined ? "n/a" : p.toFixed(2)}${ex} → ${decision.action.replace("recommend_", "recommend ").toUpperCase()} (waiting for your review)`);
    return "ok";
  }

  /** One batch: apply reviews, judge new profiles, browse past the rest, until the batch ends. */
  private async batchLoop(): Promise<void> {
    let consecutiveFailures = 0;
    let offAppSince = 0;
    this.stuck = 0;
    /** How often each already-judged profile has come round in this batch; a feed that loops means nothing new is coming. */
    const seenAgain = new Map<string, number>();

    while (!this.stopRequested) {
      const settings = loadSettings();
      if (this.state.batch && Date.now() >= new Date(this.state.batch.endsAt).getTime()) {
        this.endBatch(`${this.state.batch.plannedMinutes}-minute batch finished (${this.state.batch.evaluated} judged, ${this.state.batch.applied} reviews applied).`);
        break;
      }
      const handled = (this.state.batch?.evaluated ?? 0) + (this.state.batch?.applied ?? 0);
      if (handled >= settings.maxProfilesPerBatch) {
        this.endBatch(`reached the cap of ${settings.maxProfilesPerBatch} profiles.`);
        break;
      }

      const { state, nodes, strings } = await this.driver.observe();
      this.setDeck(state);
      if (state === "no-device") {
        this.endBatch("the phone went away.");
        break;
      }
      if (state === "not-installed") {
        this.endBatch("Feeld is no longer installed.");
        break;
      }
      if (state === "off-app" || state === "off-limits" || state === "unknown") {
        // Someone (or a popup) took us off Discover. Go back without tapping anything but Back / the Discover tab.
        if (!offAppSince) offAppSince = Date.now();
        if (Date.now() - offAppSince > 120_000) {
          const shot = await this.driver.saveErrorScreenshot("off-deck");
          this.endBatch(`could not get back to Discover for 2 minutes${shot ? ` (screenshot: ${shot})` : ""}.`);
          break;
        }
        this.log(`Feeld is ${state === "off-app" ? "not the app in front" : state === "off-limits" ? "on a settings/profile screen" : "on an unrecognised screen"}; going back to Discover.`);
        await this.driver.goToDiscover();
        await sleep(2500);
        continue;
      }
      offAppSince = 0;
      if (state === "match") {
        this.log("It's a match! Dismissing the match screen.");
        await this.driver.dismissPopups();
        await sleep(1500);
        continue;
      }
      if (state === "out-of-likes") {
        this.endBatch("Feeld says you're out of likes.");
        break;
      }
      if (state === "no-more-profiles") {
        this.endBatch("Feeld has no more profiles to show right now.");
        break;
      }
      if (state === "logged-out") {
        this.endBatch("Feeld logged out.");
        break;
      }

      // Who's on screen? A profile we've judged gets your review applied, or is browsed past.
      const hdr = this.driver.header(nodes);
      const fp = hdr ? this.driver.fingerprintOf(hdr.name, hdr.age, "") : null;
      const known = fp ? this.recognise(fp, strings) : null;
      if (known && fp) {
        consecutiveFailures = 0;
        if (known.review && known.review !== "skip" && !known.applied) {
          if (!(await this.applyReview(known, settings))) break;
          continue;
        }
        const n = (seenAgain.get(fp) ?? 0) + 1;
        seenAgain.set(fp, n);
        if (n >= 3) {
          this.endBatch(`Feeld keeps showing ${known.name ?? "the same profile"} (${describeKnown(known)}); nothing new is coming up.`);
          break;
        }
        this.setCurrent({ name: known.name, fingerprint: fp, doing: "moving on" });
        this.log(`${known.name ?? "unknown"}: already judged (${describeKnown(known)}); moving on without voting.`);
        if (!(await this.moveOn(settings))) break;
        await sleep(rand(800, 2500));
        continue;
      }

      const r = await this.judgeNew(settings);
      if (r === "stop") return;
      if (r === "no-card") {
        consecutiveFailures++;
        if (consecutiveFailures >= 5) {
          const shot = await this.driver.saveErrorScreenshot("no-card");
          this.endBatch(`no profile could be read 5 times in a row${shot ? ` (screenshot: ${shot})` : ""}.`);
          break;
        }
        this.log("No profile on screen; retrying…");
        await sleep(3000);
        continue;
      }
      consecutiveFailures = 0;
      this.setCurrent({ ...this.state.current!, doing: "moving on" });
      if (!(await this.moveOn(settings))) break;
      await sleep(rand(settings.minDelayMs, settings.maxDelayMs));
    }
  }

  private async run(): Promise<void> {
    try {
      this.setStatus("booting");
      if (!(await this.openDeck())) {
        if (this.state.status !== "setup_needed") this.setStatus("stopped");
        return;
      }
      this.setStatus("running");
      await this.batchLoop();
      if (this.stopRequested && !this.state.lastBatchEnd) this.state.lastBatchEnd = "stopped by you.";
      this.setStatus("stopped");
    } catch (e) {
      const msg = (e as Error).message;
      this.state.lastError = msg;
      this.log(`Error: ${msg}`);
      await this.driver.saveErrorScreenshot("crash").catch(() => null);
      this.setStatus("error");
    } finally {
      this.state.batch = null;
      this.state.current = null;
      this.emit("state", this.state);
    }
  }

  /** Diagnostic: what does the phone show right now? */
  async inspect(): Promise<unknown> {
    await this.ensureDevice();
    return this.driver.inspect();
  }

  /** Manual controls from the dashboard. */
  async phoneAction(action: string, settings: Settings): Promise<string | null> {
    await this.ensureDevice();
    switch (action) {
      case "like":
      case "pass":
        return (await this.driver.vote(action)) ? `${action}: card advanced` : `${action}: card did not advance`;
      case "next": {
        const r = await this.driver.advance(settings.advanceGesture);
        return r === "advanced"
          ? `next profile via "${settings.advanceGesture}": card advanced. Check on the phone panel that no like or pass was registered.`
          : r === "match"
            ? `WARNING: the "${settings.advanceGesture}" gesture produced a match screen, so it counts as a like. Choose another gesture in Settings.`
            : `next profile via "${settings.advanceGesture}": ${r}`;
      }
      case "dismiss":
        return await this.driver.dismissPopups();
      case "discover":
        return (await this.driver.goToDiscover()) ? "on Discover" : "could not open Feeld";
      case "restart":
        await this.driver.restart();
        return "restarted Feeld";
      default:
        throw new Error("unknown action");
    }
  }

  async shutdown(): Promise<void> {
    await this.stop();
    const settings = loadSettings();
    if (settings.stopEmulatorOnExit && this.bootedSerial) await stopEmulator(this.client, this.bootedSerial, (m) => this.log(m));
  }
}
