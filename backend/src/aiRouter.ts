import { activeProviders, loadSettings, type Provider } from "./settingsStore.js";

/**
 * The AI Router — HERA's brain-stem.
 * Reads providers from the settings store (configured via the UI), tries them
 * in priority order, falls back on failure, and reports health so the UI LEDs
 * reflect reality. Local-first, cloud-fallback, auto-reconnect.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  content: string;
  provider: string;
  model: string;
}

/** name -> last known health, for the UI status LEDs */
const health: Record<string, "up" | "down" | "unknown"> = {};

async function callProvider(
  provider: Provider,
  messages: ChatMessage[],
  timeoutMs: number
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({ model: provider.model, messages, stream: false }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`${res.status}: ${t.slice(0, 160)}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("no content returned");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

export async function routeChat(userMessages: ChatMessage[]): Promise<ChatResult> {
  const settings = await loadSettings();
  const providers = await activeProviders();
  if (providers.length === 0) throw new Error("No enabled AI providers. Add one in Settings.");

  const messages: ChatMessage[] = [
    { role: "system", content: settings.systemPrompt },
    ...userMessages,
  ];

  const errors: string[] = [];
  for (const p of providers) {
    try {
      const content = await callProvider(p, messages, settings.requestTimeoutMs);
      health[p.name] = "up";
      return { content, provider: p.name, model: p.model };
    } catch (err) {
      health[p.name] = "down";
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${p.name}: ${msg}`);
      console.warn(`[HERA] provider "${p.name}" failed, trying next. ${msg}`);
    }
  }
  throw new Error(`All providers failed. ${errors.join(" | ")}`);
}

/** Used by the Settings "Test" button — pings a single provider. */
export async function testProvider(p: Provider): Promise<{ ok: boolean; detail: string }> {
  try {
    const reply = await callProvider(
      p,
      [{ role: "user", content: "Reply with the single word: ok" }],
      15000
    );
    health[p.name] = "up";
    return { ok: true, detail: `connected · ${reply.trim().slice(0, 40)}` };
  } catch (err) {
    health[p.name] = "down";
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export function providerHealth() {
  return health;
}
