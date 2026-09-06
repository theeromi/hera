import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Settings store — persists HERA's configuration to disk as JSON so users
 * configure everything from the web UI instead of editing files by hand.
 *
 * Lives in a data/ folder (mounted as a Docker volume so it survives restarts).
 */

export interface Provider {
  id: string;
  name: string;          // friendly label, e.g. "Local 3090" or "OpenAI"
  baseUrl: string;       // OpenAI-compatible, e.g. http://192.168.1.187:11434/v1
  apiKey: string;        // Ollama ignores it; cloud needs it
  model: string;         // e.g. qwen2.5:14b or gpt-4o-mini
  enabled: boolean;      // toggle without deleting
  priority: number;      // lower = tried first
}

export interface Appearance {
  name: string;          // "HERA" — rebrandable
  accent: string;        // phosphor color, e.g. #ffb347
}

export interface Settings {
  providers: Provider[];
  appearance: Appearance;
  systemPrompt: string;
  requestTimeoutMs: number;
}

const DATA_DIR = process.env.HERA_DATA_DIR || path.resolve("data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

const DEFAULT_SETTINGS: Settings = {
  providers: [
    {
      id: "local-default",
      name: "Local (Ollama)",
      baseUrl: process.env.LOCAL_AI_BASE_URL || "http://192.168.1.187:11434/v1",
      apiKey: "ollama",
      model: process.env.LOCAL_AI_MODEL || "qwen2.5:14b",
      enabled: true,
      priority: 1,
    },
  ],
  appearance: { name: "HERA", accent: "#ffb347" },
  systemPrompt:
    "You are HERA, a helpful homelab assistant. Be concise, clear, and practical. If you are unsure what the user means, ask for clarification before proceeding.",
  requestTimeoutMs: 60000,
};

let cache: Settings | null = null;

export async function loadSettings(): Promise<Settings> {
  if (cache) return cache;
  try {
    if (existsSync(SETTINGS_FILE)) {
      const raw = await readFile(SETTINGS_FILE, "utf-8");
      cache = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } else {
      cache = DEFAULT_SETTINGS;
      await saveSettings(cache);
    }
  } catch (err) {
    console.error("[HERA] failed to load settings, using defaults:", err);
    cache = DEFAULT_SETTINGS;
  }
  return cache!;
}

export async function saveSettings(next: Settings): Promise<Settings> {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  // keep providers sorted by priority so index 0 is always preferred
  next.providers.sort((a, b) => a.priority - b.priority);
  await writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), "utf-8");
  cache = next;
  return next;
}

/** Returns only the enabled providers, in priority order. */
export async function activeProviders(): Promise<Provider[]> {
  const s = await loadSettings();
  return s.providers.filter((p) => p.enabled).sort((a, b) => a.priority - b.priority);
}
