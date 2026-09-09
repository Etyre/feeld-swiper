/** Boots and stops the Android emulator so the phone can run invisibly in the background. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdbClient } from "./android.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function sdkRoot(): string | null {
  for (const c of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, path.join(os.homedir(), "Library/Android/sdk"), path.join(os.homedir(), "Android/Sdk")]) {
    if (c && fs.existsSync(path.join(c, "emulator", "emulator"))) return c;
  }
  return null;
}

export function avdExists(name: string): boolean {
  return fs.existsSync(path.join(os.homedir(), ".android", "avd", `${name}.avd`));
}

/** Serial of a running emulator backed by this AVD, if any. */
export async function runningEmulatorFor(client: AdbClient, avdName: string): Promise<string | null> {
  for (const d of await client.listDevices()) {
    if (d.status !== "device" || !/^emulator-/.test(d.serial)) continue;
    if ((await client.avdNameOf(d.serial)) === avdName) return d.serial;
  }
  return null;
}

/**
 * Boots the AVD (headless unless `window`) and resolves with its serial once Android reports
 * boot completed. Resolves null if the emulator or AVD is missing or the boot times out.
 */
export async function bootEmulator(opts: { client: AdbClient; avdName: string; window?: boolean; log?: (m: string) => void; timeoutMs?: number }): Promise<string | null> {
  const { client, avdName, window = false, log = () => {}, timeoutMs = 300_000 } = opts;
  const root = sdkRoot();
  if (!root) {
    log('Android emulator not found. Run "npm run emulator" once to install it, or plug in a phone.');
    return null;
  }
  if (!avdExists(avdName)) {
    log(`Virtual device "${avdName}" does not exist. Run "npm run emulator" once to create it.`);
    return null;
  }
  const already = await runningEmulatorFor(client, avdName);
  if (already) return already;

  const before = new Set((await client.listDevices()).map((d) => d.serial));
  const args = ["-avd", avdName, "-no-audio", "-no-boot-anim", "-no-metrics"];
  if (!window) args.push("-no-window");
  log(`Starting emulator "${avdName}"${window ? "" : " in the background"}…`);
  const proc = spawn(path.join(root, "emulator", "emulator"), args, {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, ANDROID_HOME: root, ANDROID_SDK_ROOT: root },
  });
  proc.unref();

  const start = Date.now();
  let lastNote = 0;
  while (Date.now() - start < timeoutMs) {
    await sleep(3000);
    const fresh = (await client.listDevices()).filter((d) => d.status === "device" && /^emulator-/.test(d.serial) && !before.has(d.serial));
    for (const d of fresh) {
      if ((await client.avdNameOf(d.serial)) !== avdName) continue;
      const booted = await bootCompleted(client, d.serial);
      if (booted) {
        log(`Emulator ready after ${Math.round((Date.now() - start) / 1000)}s.`);
        await sleep(3000); // let the launcher settle
        return d.serial;
      }
    }
    if (Date.now() - lastNote > 20_000) {
      lastNote = Date.now();
      log("Emulator still booting…");
    }
  }
  log("Emulator did not finish booting in time.");
  return null;
}

async function bootCompleted(client: AdbClient, serial: string): Promise<boolean> {
  const prev = client.serial;
  client.serial = serial;
  try {
    const out = await client.shell("getprop sys.boot_completed", { timeout: 5000 }).catch(() => "");
    return out.trim() === "1";
  } finally {
    client.serial = prev;
  }
}

export async function stopEmulator(client: AdbClient, serial: string, log: (m: string) => void = () => {}): Promise<void> {
  if (!/^emulator-/.test(serial)) return;
  log("Stopping the emulator (its state is saved for a fast restart)…");
  const prev = client.serial;
  client.serial = serial;
  try {
    await client.adb(["emu", "kill"], { binary: false }).catch(() => {});
  } finally {
    client.serial = prev;
  }
}
