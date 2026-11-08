/**
 * Where the phone says it is. Feeld's Discover feed is driven by the device's GPS, and the
 * emulator defaults to somewhere in Northern California, so the city setting is applied to the
 * emulator over ADB whenever it connects or the setting changes. Real phones use their own GPS.
 */
import type { AdbClient } from "./android.js";
import type { Settings } from "./config.js";

export const CITIES = {
  berkeley: { label: "Berkeley, CA", lat: 37.8715, lon: -122.273 },
  sf: { label: "San Francisco, CA", lat: 37.7749, lon: -122.4194 },
  dc: { label: "Washington, DC", lat: 38.9072, lon: -77.0369 },
  nyc: { label: "New York, NY", lat: 40.7128, lon: -74.006 },
} as const;
export type CityKey = keyof typeof CITIES;

export function resolveLocation(s: Settings): { label: string; lat: number; lon: number } | null {
  if (s.city === "custom") {
    if (typeof s.latitude !== "number" || typeof s.longitude !== "number") return null;
    return { label: `custom (${s.latitude.toFixed(4)}, ${s.longitude.toFixed(4)})`, lat: s.latitude, lon: s.longitude };
  }
  return CITIES[s.city];
}

/**
 * Sets the emulator's GPS fix. Returns a message for the log, or null if nothing was done
 * (no emulator, or no usable location). A small jitter (~300 m) keeps it off the exact city-centre pin.
 */
export async function applyLocation(client: AdbClient, settings: Settings): Promise<string | null> {
  const loc = resolveLocation(settings);
  if (!loc) return null;
  if (!client.serial || !/^emulator-/.test(client.serial)) return `Location: a real phone uses its own GPS; set ${loc.label} on the phone itself.`;
  const jitter = () => (Math.random() - 0.5) * 0.006;
  const lat = loc.lat + jitter();
  const lon = loc.lon + jitter();
  // `adb emu geo fix` takes longitude first.
  await client.adb(["emu", "geo", "fix", lon.toFixed(5), lat.toFixed(5)], { timeout: 10_000 });
  return `Location set to ${loc.label} (${lat.toFixed(4)}, ${lon.toFixed(4)}).`;
}
