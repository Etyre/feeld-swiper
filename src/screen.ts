/**
 * Live phone screen for the dashboard: streams downscaled JPEG frames to subscribed
 * WebSocket clients and turns their taps / drags / keystrokes into device input.
 */
import sharp from "sharp";
import type { WebSocket } from "ws";
import type { AdbClient } from "./android.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const KEYS: Record<string, string> = {
  Enter: "ENTER", Backspace: "DEL", Delete: "FORWARD_DEL", Tab: "TAB", Escape: "BACK",
  ArrowLeft: "DPAD_LEFT", ArrowRight: "DPAD_RIGHT", ArrowUp: "DPAD_UP", ArrowDown: "DPAD_DOWN",
  Home: "MOVE_HOME", End: "MOVE_END", BACK: "BACK", HOME: "HOME", RECENTS: "APP_SWITCH", POWER: "POWER",
  VOLUME_UP: "VOLUME_UP", VOLUME_DOWN: "VOLUME_DOWN",
};

export type InputMessage =
  | { type: "tap"; x: number; y: number }
  | { type: "swipe"; x1: number; y1: number; x2: number; y2: number; ms?: number }
  | { type: "text"; text: string }
  | { type: "key"; key: string };

export class ScreenStream {
  private subs = new Set<WebSocket>();
  private loop: Promise<void> | null = null;
  fps = 0;
  /** Width of the streamed frames. The phone is 1080 wide; half of that is plenty for a side panel. */
  frameWidth = 540;
  /** Last frame sent, for a plain HTTP fetch. */
  lastFrame: Buffer | null = null;
  /** Set by the driver while it is busy with the phone, so the stream slows down and stays out of the way. */
  busy = false;

  constructor(private client: AdbClient, private log: (m: string) => void = () => {}) {}

  subscribe(ws: WebSocket): void {
    this.subs.add(ws);
    ws.once("close", () => this.subs.delete(ws));
    if (!this.loop) this.loop = this.run();
  }

  unsubscribe(ws: WebSocket): void {
    this.subs.delete(ws);
  }

  async captureFrame(): Promise<Buffer> {
    const png = await this.client.screenshotPng();
    return sharp(png).resize({ width: this.frameWidth }).jpeg({ quality: 68, mozjpeg: true }).toBuffer();
  }

  private async run(): Promise<void> {
    let frames = 0;
    let t0 = Date.now();
    while (this.subs.size) {
      try {
        if (!(await this.client.ensureDevice())) {
          await sleep(1500);
          continue;
        }
        const t = Date.now();
        const buf = await this.captureFrame();
        this.lastFrame = buf;
        for (const ws of this.subs) {
          if (ws.readyState === ws.OPEN && ws.bufferedAmount < 4e6) ws.send(buf, { binary: true });
        }
        frames++;
        const spent = Date.now() - t;
        const minInterval = this.busy ? 400 : 120;
        if (spent < minInterval) await sleep(minInterval - spent);
        if (Date.now() - t0 >= 3000) {
          this.fps = frames / ((Date.now() - t0) / 1000);
          frames = 0;
          t0 = Date.now();
        }
      } catch {
        await sleep(1000);
      }
    }
    this.loop = null;
  }

  /** Handles an input message from the dashboard. Coordinates are 0..1 fractions of the screen. */
  async handleInput(msg: InputMessage): Promise<void> {
    const { w, h } = this.client.size ?? { w: 1080, h: 2400 };
    const X = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * w);
    const Y = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * h);
    switch (msg.type) {
      case "tap":
        return this.client.tap(X(msg.x), Y(msg.y));
      case "swipe":
        return this.client.swipe(X(msg.x1), Y(msg.y1), X(msg.x2), Y(msg.y2), Math.min(2000, Math.max(60, msg.ms ?? 200)));
      case "text":
        return this.client.typeText(String(msg.text || "").slice(0, 500));
      case "key": {
        const k = KEYS[msg.key] || (/^[A-Z_]+$/.test(msg.key) ? msg.key : null);
        if (k) await this.client.key(k);
        return;
      }
    }
  }
}
