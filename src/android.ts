/**
 * Thin ADB client: device discovery, the accessibility tree (uiautomator dump),
 * screenshots, and raw input. Nothing here knows about Feeld; see feeld.ts.
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface UiNode {
  text: string;
  desc: string;
  id: string;
  cls: string;
  pkg: string;
  clickable: boolean;
  selected: boolean;
  scrollable: boolean;
  focused: boolean;
  depth: number;
  bounds: { x1: number; y1: number; x2: number; y2: number } | null;
}

export interface Device {
  serial: string;
  status: string;
  model: string;
}

export function findAdb(explicit?: string): string | null {
  const candidates = [
    explicit,
    process.env.ADB_PATH,
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, "platform-tools", "adb"),
    process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, "platform-tools", "adb"),
    path.join(os.homedir(), "Library/Android/sdk/platform-tools/adb"),
    path.join(os.homedir(), "Android/Sdk/platform-tools/adb"),
    "/opt/homebrew/bin/adb",
    "/usr/local/bin/adb",
    "adb",
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    try {
      if (c.includes("/") && !fs.existsSync(c)) continue;
      execFileSync(c, ["version"], { stdio: "ignore" });
      return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

/** Parses a uiautomator XML dump into a flat list of nodes in document order, with nesting depth. */
export function parseHierarchy(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  const re = /<node\b([^>]*?)(\/?)>|<\/node>/g;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[0] === "</node>") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    const attrs: Record<string, string> = {};
    const ar = /([\w-]+)="([^"]*)"/g;
    let a: RegExpExecArray | null;
    while ((a = ar.exec(m[1]))) attrs[a[1]] = unescapeXml(a[2]);
    const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(attrs.bounds || "");
    nodes.push({
      text: (attrs.text || "").trim(),
      desc: (attrs["content-desc"] || "").trim(),
      id: attrs["resource-id"] || "",
      cls: attrs.class || "",
      pkg: attrs.package || "",
      clickable: attrs.clickable === "true",
      selected: attrs.selected === "true",
      scrollable: attrs.scrollable === "true",
      focused: attrs.focused === "true",
      depth,
      bounds: b ? { x1: +b[1], y1: +b[2], x2: +b[3], y2: +b[4] } : null,
    });
    if (m[2] !== "/") depth++;
  }
  return nodes;
}

export const center = (n: UiNode) => ({ x: Math.round((n.bounds!.x1 + n.bounds!.x2) / 2), y: Math.round((n.bounds!.y1 + n.bounds!.y2) / 2) });
export const area = (n: UiNode) => (n.bounds ? Math.max(0, n.bounds.x2 - n.bounds.x1) * Math.max(0, n.bounds.y2 - n.bounds.y1) : 0);

export class AdbClient {
  adbPath: string | null;
  /** Serial we are pinned to (chosen device or the emulator we booted). */
  serial: string | null = null;
  device: Device | null = null;
  size: { w: number; h: number } | null = null;

  constructor(opts: { adbPath?: string; serial?: string } = {}) {
    this.adbPath = findAdb(opts.adbPath);
    this.serial = opts.serial || null;
  }

  // ---------- low level ----------

  async adb(args: string[], opts: { timeout?: number; binary?: false }): Promise<string>;
  async adb(args: string[], opts: { timeout?: number; binary: true }): Promise<Buffer>;
  async adb(args: string[], { timeout = 20_000, binary = false }: { timeout?: number; binary?: boolean } = {}): Promise<string | Buffer> {
    if (!this.adbPath) throw new Error("adb not found. Install Android platform-tools (brew install --cask android-platform-tools).");
    const full = this.serial ? ["-s", this.serial, ...args] : args;
    const { stdout } = await execFileP(this.adbPath, full, { timeout, maxBuffer: 64 * 1024 * 1024, encoding: binary ? "buffer" : "utf8" });
    return stdout as string | Buffer;
  }

  shell(cmd: string, opts?: { timeout?: number }): Promise<string> {
    return this.adb(["shell", cmd], { ...opts, binary: false });
  }

  async listDevices(): Promise<Device[]> {
    if (!this.adbPath) return [];
    const out = await execFileP(this.adbPath, ["devices", "-l"], { timeout: 10_000 }).then((r) => r.stdout).catch(() => "");
    return out
      .split("\n")
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [serial, status, ...rest] = l.split(/\s+/);
        const model = (rest.find((p) => p.startsWith("model:")) || "").slice(6);
        return { serial, status, model };
      });
  }

  /** The AVD name behind an emulator serial, or null for real phones. */
  async avdNameOf(serial: string): Promise<string | null> {
    if (!this.adbPath || !/^emulator-/.test(serial)) return null;
    const out = await execFileP(this.adbPath, ["-s", serial, "emu", "avd", "name"], { timeout: 5000 }).then((r) => r.stdout).catch(() => "");
    const line = out.split("\n").map((l) => l.trim()).find((l) => l && l !== "OK");
    return line || null;
  }

  /**
   * Picks the device to use: the pinned serial if it's connected, else nothing.
   * Pinning is done by the swiper once it knows which emulator/phone it wants.
   */
  async ensureDevice(): Promise<Device | null> {
    const ready = (await this.listDevices()).filter((d) => d.status === "device");
    const pick = this.serial ? ready.find((d) => d.serial === this.serial) : ready[0];
    if (!pick) {
      this.device = null;
      this.size = null;
      return null;
    }
    if (!this.device || this.device.serial !== pick.serial || !this.size) {
      this.serial = pick.serial;
      this.device = pick;
      const out = await this.shell("wm size").catch(() => "");
      const m = /Override size:\s*(\d+)x(\d+)/.exec(out) || /Physical size:\s*(\d+)x(\d+)/.exec(out);
      this.size = m ? { w: +m[1], h: +m[2] } : { w: 1080, h: 2400 };
    }
    return this.device;
  }

  pin(serial: string | null): void {
    if (this.serial !== serial) {
      this.serial = serial;
      this.device = null;
      this.size = null;
    }
  }

  label(): string {
    return this.device ? `${this.device.serial}${this.device.model ? ` (${this.device.model})` : ""}` : "no device";
  }

  /** Package of the window that currently has focus. Cheap (~30 ms); called before every tap. */
  async foregroundPackage(): Promise<string> {
    const out = await this.shell("dumpsys window 2>/dev/null | grep -m1 -E 'mCurrentFocus|mFocusedApp'").catch(() => "");
    const m = /([a-zA-Z0-9_.]+)\/[a-zA-Z0-9_.$]+/.exec(out);
    if (m) return m[1];
    const out2 = await this.shell("dumpsys activity activities 2>/dev/null | grep -m1 -E 'topResumedActivity|mResumedActivity'").catch(() => "");
    const m2 = /([a-zA-Z0-9_.]+)\/[a-zA-Z0-9_.$]+/.exec(out2);
    return m2 ? m2[1] : "";
  }

  /** The accessibility tree of the current screen. About a second per call. */
  async dump(): Promise<UiNode[]> {
    let xml = "";
    for (let attempt = 0; attempt < 3 && !xml.includes("<hierarchy"); attempt++) {
      xml = await this.adb(["exec-out", "uiautomator", "dump", "/dev/tty"], { timeout: 20_000, binary: false }).catch(() => "");
      if (!xml.includes("<hierarchy")) await sleep(500);
    }
    if (!xml.includes("<hierarchy")) {
      await this.shell("uiautomator dump /sdcard/feeld-swiper-ui.xml").catch(() => {});
      xml = await this.adb(["exec-out", "cat", "/sdcard/feeld-swiper-ui.xml"], { binary: false }).catch(() => "");
    }
    const start = xml.indexOf("<?xml");
    const end = xml.lastIndexOf("</hierarchy>");
    if (start < 0 || end < 0) throw new Error("Could not read the screen hierarchy (uiautomator dump failed)");
    return parseHierarchy(xml.slice(start, end + "</hierarchy>".length));
  }

  async tap(x: number, y: number): Promise<void> {
    await this.shell(`input tap ${Math.round(x)} ${Math.round(y)}`);
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, ms = 300): Promise<void> {
    await this.shell(`input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${Math.round(ms)}`);
  }

  /** Types a string into the focused field (any characters; spaces and quotes handled). */
  async typeText(text: string): Promise<void> {
    if (!text) return;
    const q = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
    for (let i = 0; i < text.length; i += 60) {
      const chunk = text.slice(i, i + 60).replace(/ /g, "%s");
      await this.shell(`input text ${q(chunk)}`);
    }
  }

  /** Sends one or more Android key codes (numbers) or names (e.g. KEYCODE_ENTER, ENTER, BACK). */
  async key(...codes: (string | number)[]): Promise<void> {
    const norm = codes.map((c) => (typeof c === "number" ? c : /^\d+$/.test(String(c)) ? c : `KEYCODE_${String(c).replace(/^KEYCODE_/, "").toUpperCase()}`));
    await this.shell(`input keyevent ${norm.join(" ")}`);
  }

  /** PNG of the whole screen. About 100 ms on the emulator. */
  async screenshotPng(): Promise<Buffer> {
    return this.adb(["exec-out", "screencap", "-p"], { binary: true, timeout: 15_000 });
  }

  async googleAccounts(): Promise<string[]> {
    const out = await this.shell("dumpsys account").catch(() => "");
    return [...out.matchAll(/Account \{name=([^,}]+), type=com\.google\}/g)].map((m) => m[1]);
  }

  async isInstalled(pkg: string): Promise<boolean> {
    const out = await this.shell(`pm list packages ${pkg}`).catch(() => "");
    return out.split("\n").some((l) => l.trim() === `package:${pkg}`);
  }

  async launchApp(pkg: string): Promise<void> {
    await this.shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`).catch(() => {});
  }

  async forceStop(pkg: string): Promise<void> {
    await this.shell(`am force-stop ${pkg}`).catch(() => {});
  }

  async openPlayStorePage(pkg: string): Promise<void> {
    await this.shell(`am start -a android.intent.action.VIEW -d "market://details?id=${pkg}"`).catch(() => {});
  }

  /** Install an APK (or several split APKs) from disk. */
  async installApk(files: string[]): Promise<string> {
    if (files.length === 1) return this.adb(["install", "-r", files[0]], { timeout: 300_000, binary: false });
    return this.adb(["install-multiple", "-r", ...files], { timeout: 300_000, binary: false });
  }
}
