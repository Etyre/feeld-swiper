/**
 * Drives the Feeld Android app through ADB. Reads each profile from the accessibility
 * tree plus screenshots while scrolling, and likes/passes with the on-screen buttons.
 *
 * Safety: every tap and swipe the driver makes is gated on Feeld being the foreground
 * app and the screen not being one of the off-limits ones (your own profile, settings,
 * membership, payment). Off-limits screens are only ever left with the Back key.
 * Popup dismissal matches an explicit allowlist of "decline" labels, never generic ones.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { area, center, type AdbClient, type UiNode } from "./android.js";
import { ERRORS_DIR, PHOTOS_DIR } from "./paths.js";
import type { Settings } from "./config.js";

export const FEELD_PACKAGE = "co.feeld";

/** Everything used to recognise Feeld's screens. Use "Inspect screen" on the dashboard to see real labels. */
export const SELECTORS = {
  like: { label: /^(like|heart|yes|send (a )?like|like (this )?(profile|person|human)|like button)$/i, id: /(^|[_.:/-])(like|heart|yes)([_.-]|$)/i },
  pass: { label: /^(pass|skip|dislike|no|nope|next|not interested|skip (this )?(profile|person|human)|pass button|x)$/i, id: /(^|[_.:/-])(pass|skip|dislike|nope)([_.-]|$)/i },
  /** Ping: Feeld's super like, a message sent before matching. Opens a composer. */
  ping: { label: /^(ping|send (a )?ping|ping (them|button))$/i, id: /(^|[_.:/-])ping([_.-]|$)/i },
  send: { label: /^(send|send ping|send message)$/i, id: /(^|[_.:/-])send([_.-]|$)/i },
  outOfPings: [/out of pings/i, /no pings (left|remaining)/i, /get more pings/i, /pings? (will )?(reset|refresh|renew)/i, /\d+ pings? (left|remaining)/i],
  readMore: /^(read|see|show) more$/i,
  /** Bottom navigation entry for the swipe screen. Matched as a prefix: RN often reports "Discover, tab, 1 of 4". */
  nav: /^(discover|explore|home|browse)\b/i,
  match: [/it.?s a (match|connection)/i, /you.?ve (matched|connected)/i, /new (match|connection)/i, /you (both )?liked each other/i, /say (hi|hello) to/i],
  outOfLikes: [/out of likes/i, /no (more )?likes left/i, /reached your (daily )?(like )?limit/i, /come back (tomorrow|later|in \d)/i, /likes? (will )?(reset|refresh|renew)/i, /more likes (in|tomorrow)/i],
  noMoreProfiles: [/no (more|new) (people|profiles|humans|members)/i, /you.?ve seen everyone/i, /that.?s everyone/i, /come back later for more/i, /widen your (search|filters)/i, /expand your (search|filters|distance)/i, /nobody new/i],
  loggedOut: [/continue with (apple|google|facebook|email|phone)/i, /^(log in|sign in|sign up|create (an )?account|get started|join feeld)$/im, /welcome to feeld/i, /enter your (phone|email|number)/i, /verification code/i, /log in with/i],
  /** Screens the driver must never tap on. Left with Back only. */
  offLimits: [/edit profile/i, /^settings$/im, /account settings/i, /manage (membership|subscription)/i, /payment method/i, /^subscribe$/im, /google play/i, /\bbuy\b/i, /1-tap buy/i, /delete account/i, /pause (my )?(profile|account)/i, /log out/i, /change (email|phone|password)/i],
  /** Upsell overlays: only here may an X labelled "Close" be tapped. */
  upsell: [/majestic/i, /upgrade/i, /premium/i, /\bunlock\b/i, /go majestic/i, /free trial/i, /pings?\b/i, /see who likes you/i, /incognito/i],
  /** Only labels that unambiguously decline something. "Skip" is excluded: it may be the pass button. */
  dismiss: /^(not now|maybe later|no,? thanks|no thanks|keep (swiping|exploring|browsing|discovering)|continue (swiping|exploring|browsing)|back to (discover|browsing|explore|feed)|i.ll pass|dismiss|remind me later|not interested)$/i,
  /** App chrome to strip out of the profile text sent to the model. */
  chrome: /^(discover|explore|likes|connections|chats|messages|me|profile|like|pass|skip|dislike|report|block|hide|share|ping|send (a )?ping|more|read more|see more|show more|tab|\d+ of \d+|[a-z]+, tab, \d+ of \d+)$/i,
};

export interface ScrapedProfile {
  fingerprint: string;
  name: string | null;
  age: number | null;
  text: string;
  /** Full-resolution JPEG screenshots of the profile, top to bottom. */
  screens: Buffer[];
  /** JPEG crops of the large images found on those screens (the profile photos), deduplicated. */
  photos: Buffer[];
}

export type DeckState =
  | "no-device"
  | "not-installed"
  | "off-app"
  | "off-limits"
  | "logged-out"
  | "match"
  | "out-of-likes"
  | "no-more-profiles"
  | "discover"
  | "unknown";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const randInt = (a: number, b: number) => Math.floor(rand(a, b + 1));
const chance = (p: number) => Math.random() < p;
/** Right-skewed dwell time: mostly short glances, occasionally a long look. */
const dwell = (base: number) => Math.round(base * Math.exp(rand(-0.6, 0.9)));

/** 64-bit average hash of an image, for near-duplicate detection. */
async function ahash(img: Buffer): Promise<bigint> {
  const raw = await sharp(img).resize(8, 8, { fit: "fill" }).grayscale().raw().toBuffer();
  let sum = 0;
  for (const v of raw) sum += v;
  const mean = sum / raw.length;
  let bits = 0n;
  for (let i = 0; i < raw.length; i++) bits = (bits << 1n) | (raw[i] > mean ? 1n : 0n);
  return bits;
}
function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

export async function jpegForModel(img: Buffer): Promise<Buffer> {
  return sharp(img).resize({ width: 640, withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
}

export class FeeldDriver {
  private installedAt = 0;
  private installed = false;
  /** Set when waitForCardChange had to dismiss a match screen (advance() uses it to detect an accidental like). */
  private matchSeen = false;
  /** Called with true while the driver is working the phone, so the live stream backs off. */
  onBusy: (busy: boolean) => void = () => {};

  constructor(public client: AdbClient, private log: (m: string) => void) {}

  get size(): { w: number; h: number } {
    return this.client.size ?? { w: 1080, h: 2400 };
  }

  // ---------- reading the screen ----------

  appNodes(nodes: UiNode[]): UiNode[] {
    return nodes.filter((n) => n.pkg === FEELD_PACKAGE);
  }

  /** Visible strings (text + content descriptions) from Feeld's own nodes, in reading order. */
  texts(nodes: UiNode[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const n of this.appNodes(nodes)) {
      for (const s of [n.text, n.desc]) {
        if (s && !seen.has(s)) {
          seen.add(s);
          out.push(s);
        }
      }
    }
    return out;
  }

  /** Name and age from the strings on screen ("Ada, 29", "Ada 29", or "Ada" followed by "29"). */
  header(nodes: UiNode[]): { name: string; age: number } | null {
    const strings = this.texts(nodes).filter((s) => !SELECTORS.chrome.test(s));
    for (const s of strings) {
      const m = /^([^\d\n]{1,40}?)[,\s·]+(\d{2})(?:\b|$)/.exec(s);
      if (m && +m[2] >= 18 && +m[2] <= 99) return { name: m[1].trim(), age: +m[2] };
    }
    for (let i = 1; i < strings.length; i++) {
      if (/^\d{2}$/.test(strings[i]) && +strings[i] >= 18 && +strings[i] <= 99 && /^[^\d]{1,40}$/.test(strings[i - 1]) && !SELECTORS.nav.test(strings[i - 1])) {
        return { name: strings[i - 1].trim(), age: +strings[i] };
      }
    }
    return null;
  }

  private findVoteButton(nodes: UiNode[], kind: "like" | "pass" | "ping"): UiNode | null {
    const { w, h } = this.size;
    const spec = SELECTORS[kind];
    // The vote buttons sit in the lower part of the screen and are small; never match the card itself.
    const cands = this.appNodes(nodes).filter((n) => n.bounds && area(n) > 0 && center(n).y > h * 0.5 && n.bounds.x2 - n.bounds.x1 < w * 0.5);
    for (const n of cands) {
      const label = n.desc || n.text;
      if (label && spec.label.test(label)) return n;
    }
    for (const n of cands) if (n.id && spec.id.test(n.id)) return n;
    return null;
  }

  private offLimits(strings: string[]): boolean {
    const joined = strings.join("\n");
    return SELECTORS.offLimits.some((re) => re.test(joined));
  }

  private async foreground(): Promise<boolean> {
    return (await this.client.foregroundPackage()) === FEELD_PACKAGE;
  }

  /** Every tap the driver makes goes through here: Feeld must be in front and the point on screen. */
  private async safeTap(x: number, y: number, why: string): Promise<boolean> {
    const { w, h } = this.size;
    if (x < 0 || y < 0 || x > w || y > h) return false;
    if (!(await this.foreground())) {
      this.log(`Not tapping (${why}): Feeld is not the app in front.`);
      return false;
    }
    await this.client.tap(x, y);
    return true;
  }

  private async safeSwipe(x1: number, y1: number, x2: number, y2: number, ms: number, why: string): Promise<boolean> {
    if (!(await this.foreground())) {
      this.log(`Not swiping (${why}): Feeld is not the app in front.`);
      return false;
    }
    await this.client.swipe(x1, y1, x2, y2, ms);
    return true;
  }

  private tapNode(n: UiNode, why: string): Promise<boolean> {
    const b = n.bounds!;
    // Somewhere inside the control, not dead centre every time.
    return this.safeTap(b.x1 + (b.x2 - b.x1) * rand(0.3, 0.7), b.y1 + (b.y2 - b.y1) * rand(0.3, 0.7), why);
  }

  async isInstalled(): Promise<boolean> {
    const now = Date.now();
    if (this.installedAt && now - this.installedAt < 30_000) return this.installed;
    this.installed = await this.client.isInstalled(FEELD_PACKAGE);
    this.installedAt = now;
    return this.installed;
  }
  forgetInstalled(): void {
    this.installedAt = 0;
  }

  /** One read of the screen: what state the app is in, plus the nodes for reuse. */
  async observe(): Promise<{ state: DeckState; nodes: UiNode[]; strings: string[] }> {
    if (!(await this.client.ensureDevice())) return { state: "no-device", nodes: [], strings: [] };
    if (!(await this.isInstalled())) return { state: "not-installed", nodes: [], strings: [] };
    const fg = await this.client.foregroundPackage();
    if (fg && fg !== FEELD_PACKAGE) return { state: "off-app", nodes: [], strings: [] };
    const nodes = await this.client.dump();
    const strings = this.texts(nodes);
    const joined = strings.join("\n");
    const test = (res: RegExp[]) => res.some((re) => re.test(joined));
    const like = this.findVoteButton(nodes, "like");
    const pass = this.findVoteButton(nodes, "pass");
    let state: DeckState = "unknown";
    if (this.offLimits(strings)) state = "off-limits";
    else if (test(SELECTORS.match)) state = "match";
    else if (test(SELECTORS.outOfLikes)) state = "out-of-likes";
    else if (test(SELECTORS.noMoreProfiles) && !like && !pass) state = "no-more-profiles";
    else if (!like && !pass && !this.header(nodes) && test(SELECTORS.loggedOut)) state = "logged-out";
    else if (like || pass || this.header(nodes)) state = "discover";
    return { state, nodes, strings };
  }

  async state(): Promise<DeckState> {
    return (await this.observe()).state;
  }

  /** Fingerprint of the profile at the top of the screen, from its name and age. Null when no header is visible (scrolled down). */
  fingerprintOf(name: string | null, age: number | null, topText: string): string {
    const key = name ? `${name}|${age ?? ""}` : topText.slice(0, 300);
    return crypto.createHash("sha1").update(key).digest("hex").slice(0, 12);
  }
  async currentFingerprint(): Promise<string | null> {
    const nodes = await this.client.dump().catch(() => null);
    if (!nodes) return null;
    const hdr = this.header(nodes);
    if (!hdr) return null;
    return this.fingerprintOf(hdr.name, hdr.age, "");
  }

  // ---------- navigation ----------

  /** Bring Feeld to the front and onto the Discover tab. Off-limits screens are backed out of, never tapped. */
  async goToDiscover(): Promise<boolean> {
    if (!(await this.client.ensureDevice())) return false;
    if (!(await this.isInstalled())) return false;
    if ((await this.client.foregroundPackage()) !== FEELD_PACKAGE) {
      this.log("Opening Feeld…");
      await this.client.launchApp(FEELD_PACKAGE);
      await sleep(3500);
    }
    const { h } = this.size;
    for (let round = 0; round < 4; round++) {
      const nodes = await this.client.dump().catch(() => []);
      const strings = this.texts(nodes);
      if (this.offLimits(strings)) {
        this.log("Feeld is on a settings/profile screen; pressing Back.");
        await this.client.key("BACK");
        await sleep(1200);
        continue;
      }
      const nav = this.appNodes(nodes).find((n) => n.bounds && area(n) > 0 && center(n).y > h * 0.86 && SELECTORS.nav.test(n.desc || n.text));
      if (nav && !nav.selected) {
        await this.tapNode(nav, "Discover tab");
        await sleep(1500);
      }
      return true;
    }
    return false;
  }

  async waitForLogin(timeoutMs: number, shouldStop: () => boolean): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (shouldStop()) return false;
      const { state } = await this.observe();
      if (state === "discover" || state === "match" || state === "out-of-likes" || state === "no-more-profiles") return true;
      if (state === "off-app" || state === "unknown") {
        // Might be on a Feeld screen after login that isn't Discover yet; try navigating.
        if (state === "off-app") await sleep(3000);
        else await this.goToDiscover();
      }
      await sleep(3000);
    }
    return false;
  }

  /** Close a match overlay or an upsell. Returns what was done, or null if nothing matched the allowlist. */
  async dismissPopups(): Promise<string | null> {
    const nodes = await this.client.dump().catch(() => []);
    const strings = this.texts(nodes);
    if (this.offLimits(strings)) {
      this.log("Feeld is on a settings/profile screen; pressing Back.");
      await this.client.key("BACK");
      return "back";
    }
    const joined = strings.join("\n");
    const overlay = SELECTORS.upsell.some((re) => re.test(joined)) || SELECTORS.match.some((re) => re.test(joined));
    for (const n of this.appNodes(nodes)) {
      if (!n.bounds || area(n) === 0) continue;
      const label = (n.text || n.desc).replace(/\s+/g, " ").trim();
      if (SELECTORS.dismiss.test(label)) {
        if (await this.tapNode(n, `dismiss "${label}"`)) return label;
      }
    }
    if (overlay) {
      const close = this.appNodes(nodes).find((n) => n.bounds && area(n) > 0 && (/^close$/i.test(n.desc || n.text) || /close/i.test(n.id)));
      if (close && (await this.tapNode(close, "close overlay"))) return "close";
    }
    return null;
  }

  // ---------- reading a profile ----------

  private scrollDown(humanize: boolean): Promise<boolean> {
    const { w, h } = this.size;
    const x = w * rand(0.4, 0.6);
    return this.safeSwipe(x, h * rand(0.7, 0.8), x + rand(-40, 40), h * rand(0.25, 0.38), humanize ? rand(300, 560) : 350, "scroll down");
  }
  private scrollUp(amount: "bit" | "screen" = "screen"): Promise<boolean> {
    const { w, h } = this.size;
    const x = w * rand(0.4, 0.6);
    const from = amount === "bit" ? h * rand(0.4, 0.5) : h * rand(0.25, 0.35);
    const to = amount === "bit" ? from + h * rand(0.12, 0.2) : h * rand(0.78, 0.88);
    return this.safeSwipe(x, from, x + rand(-40, 40), to, rand(260, 480), "scroll up");
  }

  /** Scroll back to the top of the card: until the screen stops changing. */
  async scrollToTop(maxScrolls = 16): Promise<void> {
    let last = "";
    for (let i = 0; i < maxScrolls; i++) {
      const nodes = await this.client.dump().catch(() => []);
      const sig = this.texts(nodes).join("|");
      if (sig === last) return;
      last = sig;
      if (!(await this.scrollUp())) return;
      await sleep(dwell(350));
    }
  }

  /** Crop the large images on this screenshot (the profile photos). */
  private async cropPhotos(png: Buffer, nodes: UiNode[], photos: Buffer[], hashes: bigint[]): Promise<void> {
    const { w, h } = this.size;
    const imgs = this.appNodes(nodes).filter(
      (n) => n.bounds && /ImageView|Image\b/.test(n.cls) && n.bounds.x2 - n.bounds.x1 >= w * 0.5 && n.bounds.y2 - n.bounds.y1 >= h * 0.18 && n.bounds.y1 >= 0 && n.bounds.y2 <= h,
    );
    for (const n of imgs) {
      if (photos.length >= 12) return;
      const b = n.bounds!;
      try {
        const crop = await sharp(png).extract({ left: b.x1, top: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1 }).jpeg({ quality: 88 }).toBuffer();
        const hsh = await ahash(crop);
        if (hashes.some((x) => hamming(x, hsh) <= 5)) continue;
        hashes.push(hsh);
        photos.push(crop);
      } catch {
        /* bounds slightly off; skip */
      }
    }
  }

  /**
   * Read the profile on screen: scroll through it collecting text and screenshots, like
   * a person reading it. Leaves the card wherever the scroll ended.
   */
  async readProfile(settings: Settings): Promise<ScrapedProfile | null> {
    const humanize = settings.humanize;
    this.onBusy(true);
    try {
      let nodes = await this.client.dump();
      const hdr = this.header(nodes);
      const strings: string[] = [];
      const seen = new Set<string>();
      const add = (list: string[]) => {
        for (const s of list) if (!seen.has(s)) { seen.add(s); strings.push(s); }
      };
      add(this.texts(nodes));
      if (!hdr && !strings.length) return null;
      const topText = strings.join("\n");

      const screens: Buffer[] = [];
      const photos: Buffer[] = [];
      const hashes: bigint[] = [];
      const capture = async (current: UiNode[]) => {
        const png = await this.client.screenshotPng();
        screens.push(await sharp(png).jpeg({ quality: 86 }).toBuffer());
        await this.cropPhotos(png, current, photos, hashes);
      };
      await capture(nodes);
      if (humanize) await sleep(dwell(1100)); // look at the first photo
      let lastSig = this.texts(nodes).join("|");
      const { h } = this.size;
      let readMoreTapped = 0;
      for (let i = 0; i < settings.maxProfileScrolls; i++) {
        // "Read more" on a truncated bio, if it's inside the card.
        const more = this.appNodes(nodes).find((n) => n.bounds && area(n) > 0 && center(n).y < h * 0.86 && SELECTORS.readMore.test(n.text || n.desc));
        if (more && readMoreTapped < 3 && (await this.tapNode(more, "read more"))) {
          readMoreTapped++;
          await sleep(dwell(500));
          nodes = await this.client.dump();
          add(this.texts(nodes));
          await capture(nodes);
        }
        if (!(await this.scrollDown(humanize))) return null;
        await sleep(humanize ? dwell(650) : 450);
        nodes = await this.client.dump();
        const sig = this.texts(nodes).join("|");
        if (sig === lastSig) break; // reached the end
        lastSig = sig;
        add(this.texts(nodes));
        await capture(nodes);
        if (humanize && i >= 1 && chance(0.12)) {
          // Double-take: glance back up, then carry on.
          await this.scrollUp("bit");
          await sleep(dwell(1200));
          await this.scrollDown(true);
          await sleep(dwell(400));
        }
        if (humanize) await sleep(dwell(500));
      }
      const name = hdr?.name ?? null;
      const age = hdr?.age ?? null;
      const text = strings.filter((s) => !SELECTORS.chrome.test(s)).join("\n").slice(0, 6000);
      return { fingerprint: this.fingerprintOf(name, age, topText), name, age, text, screens, photos };
    } finally {
      this.onBusy(false);
    }
  }

  // ---------- acting ----------

  /**
   * Ping the profile on screen: tap Ping, write the message in the composer, send. Returns "ping"
   * once the next card is up, "unavailable" when there was no Ping button or Feeld showed an
   * out-of-pings / upsell screen instead of the composer (the caller then sends a like), or
   * "failed" if the composer opened but the card didn't advance.
   */
  async ping(message: string): Promise<"ping" | "unavailable" | "failed"> {
    this.onBusy(true);
    try {
      const before = await this.client.dump();
      const strings = this.texts(before);
      if (this.offLimits(strings)) {
        await this.client.key("BACK");
        return "unavailable";
      }
      const beforeFp = this.header(before) ? this.fingerprintOf(this.header(before)!.name, this.header(before)!.age, "") : null;
      const beforeSig = strings.join("|");
      let btn = this.findVoteButton(before, "ping");
      if (!btn) {
        await this.scrollToTop();
        btn = this.findVoteButton(await this.client.dump(), "ping");
      }
      if (!btn) {
        this.log("No Ping button found on screen.");
        return "unavailable";
      }
      if (!(await this.tapNode(btn, `ping button "${btn.desc || btn.text || btn.id}"`))) return "unavailable";
      await sleep(dwell(1200));
      // The composer: a text field plus a Send button. Anything else is an upsell or a limit.
      let nodes = await this.client.dump();
      const edit = nodes.find((n) => n.pkg === FEELD_PACKAGE && /EditText/.test(n.cls) && n.bounds && area(n) > 0);
      const joined = this.texts(nodes).join("\n");
      if (!edit || SELECTORS.outOfPings.some((re) => re.test(joined))) {
        this.log(SELECTORS.outOfPings.some((re) => re.test(joined)) ? "Feeld says you're out of pings." : "Ping didn't open a message composer; treating pings as unavailable.");
        const what = await this.dismissPopups();
        if (!what) await this.client.key("BACK");
        await sleep(800);
        return "unavailable";
      }
      if (!(await this.tapNode(edit, "ping composer"))) return "failed";
      await sleep(dwell(500));
      await this.client.typeText(message);
      await sleep(dwell(900));
      nodes = await this.client.dump();
      const send = this.appNodes(nodes).find((n) => n.bounds && area(n) > 0 && (SELECTORS.send.label.test(n.desc || n.text) || SELECTORS.send.id.test(n.id)));
      if (!send) {
        this.log("Typed the ping but found no Send button; backing out.");
        await this.client.key("BACK");
        await sleep(600);
        await this.client.key("BACK");
        return "failed";
      }
      if (!(await this.tapNode(send, "send ping"))) return "failed";
      await sleep(dwell(1200));
      // A "ping sent" confirmation may need dismissing before the deck moves on.
      const advanced = await this.waitForCardChange(beforeFp, beforeSig, 10_000);
      if (!advanced) {
        const what = await this.dismissPopups();
        if (what && (await this.waitForCardChange(beforeFp, beforeSig, 5000))) return "ping";
        return "failed";
      }
      return "ping";
    } finally {
      this.onBusy(false);
    }
  }

  /**
   * Like or pass the profile on screen with its button. Returns true once the next card is up.
   * Only the button is ever used: on Feeld a horizontal swipe browses past a profile, it does not vote.
   */
  async vote(kind: "like" | "pass"): Promise<boolean> {
    this.onBusy(true);
    try {
      const before = await this.client.dump();
      const beforeFp = this.header(before) ? this.fingerprintOf(this.header(before)!.name, this.header(before)!.age, "") : null;
      const beforeSig = this.texts(before).join("|");
      if (this.offLimits(this.texts(before))) {
        this.log("Refusing to vote: Feeld is on a settings/profile screen.");
        await this.client.key("BACK");
        return false;
      }
      let btn = this.findVoteButton(before, kind);
      if (!btn) {
        await this.scrollToTop();
        btn = this.findVoteButton(await this.client.dump(), kind);
      }
      if (!btn) {
        this.log(`No ${kind} button found on screen (use Inspect screen to see the labels; SELECTORS in src/feeld.ts).`);
        return false;
      }
      if (!(await this.tapNode(btn, `${kind} button "${btn.desc || btn.text || btn.id}"`))) return false;
      return this.waitForCardChange(beforeFp, beforeSig, 8000);
    } finally {
      this.onBusy(false);
    }
  }

  /**
   * Move on to the next profile WITHOUT liking or passing. Feeld lets you browse past a profile;
   * which gesture does it was not verified against the real app, so it's a setting. Try it with
   * the "Next (no vote)" button on the phone panel first. Returns "match" when the gesture produced
   * a match screen, which means it registered as a like and must not be used.
   */
  async advance(gesture: Settings["advanceGesture"], maxScrolls = 14): Promise<"advanced" | "stuck" | "match" | "blocked"> {
    this.onBusy(true);
    try {
      const before = await this.client.dump();
      const strings = this.texts(before);
      if (this.offLimits(strings)) {
        this.log("Not moving on: Feeld is on a settings/profile screen; pressing Back.");
        await this.client.key("BACK");
        return "blocked";
      }
      const hdr = this.header(before);
      const beforeFp = hdr ? this.fingerprintOf(hdr.name, hdr.age, "") : null;
      const beforeSig = strings.join("|");
      const { w, h } = this.size;
      this.matchSeen = false;
      if (gesture === "scroll-down") {
        // A vertical feed: keep scrolling until a different profile's header is at the top.
        let last = beforeSig;
        for (let i = 0; i < maxScrolls; i++) {
          if (!(await this.scrollDown(true))) return "blocked";
          await sleep(dwell(450));
          const nodes = await this.client.dump().catch(() => []);
          const now = this.header(nodes);
          const fp = now ? this.fingerprintOf(now.name, now.age, "") : null;
          if (fp && fp !== beforeFp) return "advanced";
          const sig = this.texts(nodes).join("|");
          if (sig === last && i > 0) break; // nothing more to scroll
          last = sig;
        }
        return "stuck";
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt === 1) await this.scrollToTop();
        const y = h * rand(0.4, 0.55);
        const ok =
          gesture === "swipe-left"
            ? await this.safeSwipe(w * rand(0.8, 0.9), y, w * rand(0.05, 0.15), y + rand(-30, 30), rand(160, 300), "next profile")
            : await this.safeSwipe(w * rand(0.1, 0.2), y, w * rand(0.85, 0.95), y + rand(-30, 30), rand(160, 300), "next profile");
        if (!ok) return "blocked";
        const changed = await this.waitForCardChange(beforeFp, beforeSig, 5000);
        if (this.matchSeen) return "match";
        if (changed) return "advanced";
      }
      return "stuck";
    } finally {
      this.onBusy(false);
    }
  }

  /** A short look at a profile before acting on it: a screen or two down, with pauses. */
  async skim(): Promise<void> {
    this.onBusy(true);
    try {
      await sleep(dwell(900));
      const n = randInt(1, 3);
      for (let i = 0; i < n; i++) {
        if (!(await this.scrollDown(true))) break;
        await sleep(dwell(700));
      }
    } finally {
      this.onBusy(false);
    }
  }

  /** Poll until a different profile is at the top (or the screen changed and no popup explains it). */
  async waitForCardChange(prevFp: string | null, prevSig: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(700);
      const nodes = await this.client.dump().catch(() => null);
      if (!nodes) continue;
      const strings = this.texts(nodes);
      const joined = strings.join("\n");
      if (SELECTORS.match.some((re) => re.test(joined))) {
        this.matchSeen = true;
        this.log("It's a match! Dismissing the match screen.");
        await this.dismissPopups();
        continue;
      }
      if (SELECTORS.upsell.some((re) => re.test(joined)) && !this.findVoteButton(nodes, "like")) {
        const what = await this.dismissPopups();
        if (what) this.log(`Dismissed a popup (${what}).`);
        continue;
      }
      const hdr = this.header(nodes);
      const fp = hdr ? this.fingerprintOf(hdr.name, hdr.age, "") : null;
      if (fp && prevFp && fp !== prevFp) return true;
      if (!prevFp && strings.join("|") !== prevSig) return true;
      if (fp && !prevFp) return true;
    }
    return false;
  }

  /**
   * After the model has decided: linger on profiles we like (people look longer at someone
   * they're about to like), flick past most passes.
   */
  async secondLook(liked: boolean, probability: number | undefined): Promise<void> {
    const nearThreshold = probability !== undefined && Math.abs(probability - 0.5) < 0.15;
    if (liked && chance(0.7)) {
      await this.scrollUp("bit");
      await sleep(dwell(1500));
      if (chance(0.5)) {
        await this.scrollUp("bit");
        await sleep(dwell(1200));
      }
    } else if (nearThreshold && chance(0.5)) {
      await this.scrollUp("bit");
      await sleep(dwell(1200));
    } else if (chance(0.15)) {
      await sleep(dwell(900));
    }
  }

  /** Before a like: scroll slowly back to the top, the way a person re-checks the photos. */
  async lingerBeforeLike(): Promise<void> {
    this.onBusy(true);
    try {
      let last = "";
      for (let i = 0; i < 16; i++) {
        const nodes = await this.client.dump().catch(() => []);
        const sig = this.texts(nodes).join("|");
        if (sig === last) break;
        last = sig;
        if (!(await this.scrollUp())) break;
        await sleep(dwell(1400));
      }
      await sleep(dwell(1000));
    } finally {
      this.onBusy(false);
    }
  }

  async restart(): Promise<void> {
    await this.client.forceStop(FEELD_PACKAGE);
    await sleep(1200);
    await this.goToDiscover();
  }

  // ---------- persistence & diagnostics ----------

  /** Persist images to disk for the dashboard; returns relative URLs. */
  saveImages(id: string, images: Buffer[], prefix = "", startIndex = 0): string[] {
    const dir = path.join(PHOTOS_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    return images.map((buf, k) => {
      const file = `${prefix}${startIndex + k}.jpg`;
      fs.writeFileSync(path.join(dir, file), buf);
      return `/photos/${id}/${file}`;
    });
  }

  async saveErrorScreenshot(tag: string): Promise<string | null> {
    try {
      const file = path.join(ERRORS_DIR, `${Date.now()}-${tag}.png`);
      fs.writeFileSync(file, await this.client.screenshotPng());
      return file;
    } catch {
      return null;
    }
  }

  async inspect(): Promise<unknown> {
    const devices = await this.client.listDevices();
    const dev = await this.client.ensureDevice();
    const report: Record<string, unknown> = { adbPath: this.client.adbPath, devices, device: dev, screen: this.client.size };
    if (!dev) return report;
    this.forgetInstalled();
    report.feeldInstalled = await this.isInstalled();
    report.foregroundPackage = await this.client.foregroundPackage();
    try {
      const { state, nodes, strings } = await this.observe();
      report.state = state;
      report.header = this.header(nodes);
      report.likeButton = this.findVoteButton(nodes, "like");
      report.passButton = this.findVoteButton(nodes, "pass");
      report.pingButton = this.findVoteButton(nodes, "ping");
      report.texts = strings;
      report.nodes = this.appNodes(nodes)
        .filter((n) => n.text || n.desc || n.clickable || /ImageView/.test(n.cls))
        .map((n) => ({
          text: n.text,
          desc: n.desc,
          id: n.id.replace(`${FEELD_PACKAGE}:id/`, ""),
          cls: n.cls.split(".").pop(),
          clickable: n.clickable,
          selected: n.selected,
          depth: n.depth,
          bounds: n.bounds && `[${n.bounds.x1},${n.bounds.y1}][${n.bounds.x2},${n.bounds.y2}]`,
        }))
        .slice(0, 250);
    } catch (e) {
      report.error = (e as Error).message;
    }
    return report;
  }
}
