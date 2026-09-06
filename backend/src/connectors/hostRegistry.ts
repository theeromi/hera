import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  readAllHosts,
  localHostDefault,
  type HostConfig,
  type HostState,
} from "./sshConnector.js";

/**
 * Host Registry — HERA's memory of the homelab.
 *
 * Two jobs:
 *  1. Persist which hosts HERA knows about (configured from the UI).
 *  2. Cache the last read so HERA isn't SSH-ing into 4 machines every time
 *     you ask it a question. Fast, light, and kind to the network.
 */

const DATA_DIR = process.env.HERA_DATA_DIR || path.resolve("data");
const HOSTS_FILE = path.join(DATA_DIR, "hosts.json");

/** How long a read stays fresh before HERA re-scans. */
const CACHE_TTL_MS = parseInt(process.env.HOMELAB_CACHE_TTL_MS || "60000", 10);

let hostsCache: HostConfig[] | null = null;
let stateCache: { states: HostState[]; at: number } | null = null;

export async function loadHosts(): Promise<HostConfig[]> {
  if (hostsCache) return hostsCache;
  try {
    if (existsSync(HOSTS_FILE)) {
      hostsCache = JSON.parse(await readFile(HOSTS_FILE, "utf-8"));
    } else {
      hostsCache = [localHostDefault()];
      await saveHosts(hostsCache);
    }
  } catch (err) {
    console.error("[HERA] failed to load hosts:", err);
    hostsCache = [localHostDefault()];
  }
  return hostsCache!;
}

export async function saveHosts(hosts: HostConfig[]): Promise<HostConfig[]> {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  await writeFile(HOSTS_FILE, JSON.stringify(hosts, null, 2), "utf-8");
  hostsCache = hosts;
  stateCache = null; // hosts changed — invalidate the cached read
  return hosts;
}

/**
 * Get the homelab state. Served from cache unless it's stale or forced.
 */
export async function getHomelabState(force = false): Promise<{
  hosts: HostState[];
  cached: boolean;
  readAt: string;
}> {
  const fresh = stateCache && Date.now() - stateCache.at < CACHE_TTL_MS;
  if (fresh && !force) {
    return {
      hosts: stateCache!.states,
      cached: true,
      readAt: new Date(stateCache!.at).toISOString(),
    };
  }

  const hosts = await loadHosts();
  const states = await readAllHosts(hosts);
  stateCache = { states, at: Date.now() };
  return { hosts: states, cached: false, readAt: new Date().toISOString() };
}

/**
 * A compact text summary of the homelab, for feeding to the AI as context.
 * Kept deliberately terse — this goes into every chat request, so it must be
 * cheap in tokens while still being genuinely useful.
 */
export async function homelabContext(): Promise<string> {
  const { hosts } = await getHomelabState();
  if (hosts.length === 0) return "No homelab hosts are configured yet.";

  const lines = hosts.map((h) => {
    if (!h.reachable) return `- ${h.name}: UNREACHABLE${h.error ? ` (${h.error})` : ""}`;

    const disks = h.disks
      .map((d) => `${d.filesystem} ${d.used}/${d.size} (${d.usedPercent}% used, ${d.available} free)`)
      .join("; ");
    const containers = h.containers.length
      ? h.containers.map((c) => c.name).join(", ")
      : "none";
    const mem =
      h.memoryTotalMb && h.memoryUsedMb
        ? `, memory ${h.memoryUsedMb}/${h.memoryTotalMb} MB`
        : "";

    return [
      `- ${h.name} (${h.hostname ?? "?"}): online`,
      h.uptime ? `, up ${h.uptime}` : "",
      h.loadAvg !== undefined ? `, load ${h.loadAvg}` : "",
      mem,
      disks ? `\n    storage: ${disks}` : "",
      `\n    containers: ${containers}`,
    ].join("");
  });

  return `Current homelab state (read live over SSH):\n${lines.join("\n")}`;
}
