/**
 * Guided setup: signs the emulator into Google, installs Feeld from the Play Store, launches it.
 * Credentials are used in memory for the duration of the sign-in and never written anywhere.
 * Ported from the Bumble swiper's wizard.
 */
import { EventEmitter } from "node:events";
import type { AdbClient, UiNode } from "./android.js";
import { area } from "./android.js";
import { FEELD_PACKAGE, type FeeldDriver } from "./feeld.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Buttons that safely move Google's setup flow forward, most-preferred first.
const ADVANCE = [/^skip$/i, /^no,? thanks$/i, /^not now$/i, /^i agree$/i, /^agree$/i, /^accept$/i, /^more$/i, /^next$/i, /^continue$/i, /^done$/i, /^ok$/i, /^got it$/i];

export interface SetupStatus {
  step: "idle" | "google" | "install" | "launch" | "done" | "error";
  busy: boolean;
  message: string;
  needsAttention: boolean;
  googleAccount: string | null;
  feeldInstalled: boolean;
}

export class SetupWizard extends EventEmitter {
  status: SetupStatus = { step: "idle", busy: false, message: "", needsAttention: false, googleAccount: null, feeldInstalled: false };

  constructor(private client: AdbClient, private driver: FeeldDriver, private log: (m: string) => void) {
    super();
  }

  set(patch: Partial<SetupStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit("status", this.status);
  }

  async refresh(): Promise<SetupStatus> {
    if (!(await this.client.ensureDevice())) return this.status;
    const accounts = await this.client.googleAccounts().catch(() => []);
    this.driver.forgetInstalled();
    const installed = await this.driver.isInstalled().catch(() => false);
    this.set({ googleAccount: accounts[0] || null, feeldInstalled: installed });
    return this.status;
  }

  async runAll({ email, password }: { email: string; password: string }): Promise<boolean> {
    if (this.status.busy) throw new Error("Setup is already running");
    this.set({ busy: true, needsAttention: false });
    try {
      await this.refresh();
      if (!this.status.googleAccount) {
        if (!email || !password) throw new Error("Google email and password are required");
        const ok = await this.googleSignIn({ email, password });
        if (!ok) return false;
      } else {
        this.log(`Google account already signed in (${this.status.googleAccount}).`);
      }
      if (!this.status.feeldInstalled) {
        const ok = await this.installFeeld();
        if (!ok) return false;
      } else {
        this.log("Feeld is already installed.");
      }
      await this.launchFeeld();
      this.set({ step: "done", message: "Feeld is installed and open. Log in to Feeld on the phone panel, then start a batch." });
      return true;
    } catch (e) {
      this.set({ step: "error", message: (e as Error).message || String(e) });
      this.log(`Setup error: ${(e as Error).message || e}`);
      return false;
    } finally {
      this.set({ busy: false });
      await this.refresh().catch(() => {});
    }
  }

  private editTexts(nodes: UiNode[]): UiNode[] {
    return nodes.filter((n) => /EditText/.test(n.cls) && n.bounds && area(n) > 0);
  }
  private findByText(nodes: UiNode[], re: RegExp, controlsOnly = false): UiNode | null {
    const isControl = (n: UiNode) => n.clickable || /Button|ImageView|CheckBox|Switch/.test(n.cls);
    return nodes.find((n) => n.bounds && area(n) > 0 && (!controlsOnly || isControl(n)) && (re.test(n.text) || re.test(n.desc))) || null;
  }
  private async tapNode(n: UiNode): Promise<void> {
    const b = n.bounds!;
    await this.client.tap((b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2);
  }

  async googleSignIn({ email, password }: { email: string; password: string }): Promise<boolean> {
    const c = this.client;
    this.set({ step: "google", message: `Signing in to Google as ${email}…`, needsAttention: false });
    this.log(`Google sign-in: opening the Play Store as ${email}`);
    await c.openPlayStorePage(FEELD_PACKAGE);
    await sleep(4000);

    const start = Date.now();
    let typedEmail = false;
    let typedPassword = false;
    let lastSig = "";
    let changedAt = Date.now();
    let attentionLogged = false;
    while (Date.now() - start < 300_000) {
      const accounts = await c.googleAccounts().catch(() => []);
      if (accounts.length) {
        this.set({ googleAccount: accounts[0], message: `Signed in as ${accounts[0]}`, needsAttention: false });
        this.log(`Google sign-in complete: ${accounts[0]}`);
        await sleep(3000);
        return true;
      }
      const nodes = await c.dump().catch(() => [] as UiNode[]);
      const texts = nodes.map((n) => n.text || n.desc).filter(Boolean).join("\n");
      if (texts !== lastSig) {
        lastSig = texts;
        changedAt = Date.now();
      }
      const edits = this.editTexts(nodes);

      if (/wrong password|incorrect password|couldn.t find your google account|couldn.t sign you in/i.test(texts)) {
        this.set({ step: "error", message: "Google rejected the email or password. Fix it on the phone panel or try again.", needsAttention: true });
        this.log("Google sign-in: wrong email or password.");
        return false;
      }
      if (edits.length && !typedEmail && /email|phone/i.test(texts) && !/password/i.test(texts)) {
        if (!(await this.fillField(edits[0], email))) {
          this.set({ step: "error", message: "Could not type the email address into the field. Try it on the phone panel.", needsAttention: true });
          return false;
        }
        typedEmail = true;
        this.log("Google sign-in: entered email");
        const fresh = await c.dump().catch(() => nodes);
        (await this.tapAny(fresh, [/^next$/i])) || (await c.key("ENTER"));
        await sleep(4000);
        continue;
      }
      if (edits.length && typedEmail && !typedPassword && /password/i.test(texts)) {
        await this.fillField(edits[0], password, true);
        typedPassword = true;
        this.log("Google sign-in: entered password");
        await sleep(500);
        const fresh = await c.dump().catch(() => nodes);
        (await this.tapAny(fresh, [/^next$/i])) || (await c.key("ENTER"));
        await sleep(5000);
        continue;
      }
      if (/verify it.s you|2-step|two-step|verification code|check your phone|tap yes on|enter the code|confirm your recovery|captcha/i.test(texts)) {
        if (!attentionLogged) {
          attentionLogged = true;
          this.log("Google sign-in: waiting for you to complete verification on the phone panel.");
        }
        this.set({ message: "Google needs verification (2-step / code / recovery). Complete it on the phone panel; setup continues automatically.", needsAttention: true });
        await sleep(3000);
        continue;
      }
      if (await this.tapAny(nodes, typedPassword || !edits.length ? ADVANCE : [/^sign in$/i, /^next$/i])) {
        await sleep(3000);
        continue;
      }
      if (Date.now() - changedAt > 25_000) {
        this.set({ message: "Sign-in seems stuck. Take a look at the phone panel and continue it there; setup resumes automatically.", needsAttention: true });
      }
      await sleep(1500);
    }
    this.set({ step: "error", message: "Google sign-in timed out." });
    return false;
  }

  async installFeeld(): Promise<boolean> {
    const c = this.client;
    this.set({ step: "install", message: "Installing Feeld from the Play Store…", needsAttention: false });
    this.log("Opening Feeld in the Play Store");
    await c.openPlayStorePage(FEELD_PACKAGE);
    await sleep(5000);
    const start = Date.now();
    let tappedInstall = 0;
    let changedAt = Date.now();
    let lastSig = "";
    while (Date.now() - start < 480_000) {
      this.driver.forgetInstalled();
      if (await this.driver.isInstalled()) {
        this.set({ feeldInstalled: true, message: "Feeld installed." });
        this.log("Feeld installed.");
        return true;
      }
      const nodes = await c.dump().catch(() => [] as UiNode[]);
      const texts = nodes.map((n) => n.text || n.desc).filter(Boolean).join("\n");
      if (texts !== lastSig) {
        lastSig = texts;
        changedAt = Date.now();
      }
      if (/not available in your (country|region)|isn.t available|not compatible|can.t install/i.test(texts)) {
        this.set({ step: "error", message: "The Play Store says Feeld is not available for this device/account. See the phone panel.", needsAttention: true });
        return false;
      }
      if (this.findByText(nodes, /^sign in$/i)) {
        this.set({ step: "error", message: "The Play Store is not signed in to Google." });
        return false;
      }
      const install = this.findByText(nodes, /^install$/i);
      if (install && Date.now() - tappedInstall > 20_000) {
        await this.tapNode(install);
        tappedInstall = Date.now();
        this.log("Tapped Install; downloading…");
        this.set({ message: "Downloading Feeld…" });
        await sleep(5000);
        continue;
      }
      if (/^(pending|downloading|installing|verifying)/im.test(texts) || /\d+%/.test(texts)) {
        await sleep(3000);
        continue;
      }
      if (await this.tapAny(nodes, [/^continue$/i, /^skip$/i, /^no,? thanks$/i, /^not now$/i, /^got it$/i, /^ok$/i, /^accept$/i])) {
        await sleep(2500);
        continue;
      }
      if (!install && !tappedInstall) {
        await c.openPlayStorePage(FEELD_PACKAGE);
        await sleep(5000);
      }
      if (Date.now() - changedAt > 60_000) {
        this.set({ message: "Install seems stuck. Check the phone panel; setup resumes automatically.", needsAttention: true });
      }
      await sleep(2500);
    }
    this.set({ step: "error", message: "Installing Feeld timed out." });
    return false;
  }

  async launchFeeld(): Promise<void> {
    this.set({ step: "launch", message: "Opening Feeld…" });
    await this.client.launchApp(FEELD_PACKAGE);
    await sleep(5000);
  }

  /** Focuses a field, replaces its content with `value`, and verifies what actually landed. */
  private async fillField(node: UiNode, value: string, secret = false): Promise<boolean> {
    const c = this.client;
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.tapNode(node);
      await sleep(600);
      await c.key("MOVE_END");
      await c.key(...Array(Math.min(120, (node.text?.length || 0) + value.length + 10)).fill(67)); // backspace
      await sleep(300);
      await c.typeText(value);
      await sleep(1200);
      const nodes = await c.dump().catch(() => [] as UiNode[]);
      const field = this.editTexts(nodes)[0];
      const got = field?.text ?? "";
      if (secret ? got.length === value.length || got.length === 0 : got === value) return true;
      if (secret) return true;
      this.log(`Field contains "${got}" instead of the expected value; retyping.`);
      node = field || node;
    }
    return false;
  }

  private async tapAny(nodes: UiNode[], patterns: RegExp[]): Promise<boolean> {
    for (const re of patterns) {
      const n = this.findByText(nodes, re, true);
      if (n) {
        await this.tapNode(n);
        this.log(`Tapped "${n.text || n.desc}"`);
        return true;
      }
    }
    return false;
  }
}
