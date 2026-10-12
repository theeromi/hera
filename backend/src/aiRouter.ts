import crypto from "node:crypto";
import { activeProviders, loadSettings, type Provider } from "./settingsStore.js";
import { homelabContext, loadHosts, getHomelabState } from "./connectors/hostRegistry.js";
import { getContainerLogs } from "./connectors/sshConnector.js";
import { proposeAction, type PendingAction } from "./actionEngine.js";
import { getMemory, getSkills } from "./memoryStore.js";

/**
 * The AI Router — HERA's brain-stem.
 *
 * Episode 3: HERA gets hands, safely.
 *  - The model is given TOOLS (native tool calling — no fragile text parsing):
 *      propose_action       → creates a pending approval. Never executes.
 *      get_container_logs   → read-only, runs immediately.
 *  - The system prompt now includes: memory (HERA.md) + skills + live homelab.
 *  - Tool rounds are capped so a confused model can never loop forever
 *    (the MonkeyCode lesson, as code).
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatResult {
  content: string;
  provider: string;
  model: string;
  pendingAction?: PendingAction;
}

const MAX_TOOL_ROUNDS = 3;
// Ollama's OpenAI endpoint defaults to 1.0 — high enough that local models
// sometimes sample junk in place of the <tool_call> token (the call then
// arrives as plain text) or drift into another language.
const TEMPERATURE = 0.2;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "propose_action",
      description:
        "Propose a Docker container action (start/stop/restart) on a homelab host. " +
        "This does NOT execute anything — it creates a proposal the operator must approve. " +
        "Only use container names and host ids that appear in the homelab state.",
      parameters: {
        type: "object",
        properties: {
          hostId: { type: "string", description: "The host id from the homelab state, e.g. 'content-lab'" },
          container: { type: "string", description: "Exact container name as shown in the homelab state" },
          action: { type: "string", enum: ["start", "stop", "restart"] },
          reason: { type: "string", description: "One short sentence: why this action" },
        },
        required: ["hostId", "container", "action", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_container_logs",
      description:
        "Fetch recent logs for a container (read-only, runs immediately, no approval needed). " +
        "Useful before proposing a fix for an unhealthy or exited container.",
      parameters: {
        type: "object",
        properties: {
          hostId: { type: "string" },
          container: { type: "string" },
          lines: { type: "number", description: "How many lines (default 40, max 200)" },
        },
        required: ["hostId", "container"],
      },
    },
  },
];

const health: Record<string, "up" | "down" | "unknown"> = {};

async function callProvider(
  provider: Provider,
  messages: ChatMessage[],
  timeoutMs: number,
  withTools: boolean
): Promise<{ content: string | null; toolCalls: ToolCall[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body: Record<string, unknown> = {
      model: provider.model,
      messages,
      stream: false,
      temperature: TEMPERATURE,
    };
    if (withTools) body.tools = TOOLS;

    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`${res.status}: ${t.slice(0, 160)}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
    };
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("no message returned");
    const content = msg.content ?? null;
    const toolCalls = msg.tool_calls ?? [];
    // Some local models (e.g. qwen via Ollama) write the tool call into the
    // reply text instead of using native tool_calls. Recover it here.
    if (withTools && toolCalls.length === 0 && content) {
      const recovered = extractTextToolCalls(content);
      if (recovered.toolCalls.length > 0) return recovered;
    }
    return { content, toolCalls };
  } finally {
    clearTimeout(timer);
  }
}

const TOOL_NAMES = new Set(TOOLS.map((t) => t.function.name));

/**
 * Fallback parser for tool calls emitted as text. Scans for any balanced
 * JSON object naming a known tool, wherever it sits — inside ```json fences,
 * <tool_call> tags (even half-garbled ones), or loose in the reply.
 */
function extractTextToolCalls(content: string): { content: string; toolCalls: ToolCall[] } {
  const toolCalls: ToolCall[] = [];
  const spans: [number, number][] = [];

  const toCall = (raw: string): ToolCall | null => {
    let obj: any;
    try { obj = JSON.parse(raw); } catch { return null; }
    if (obj?.function && typeof obj.function === "object") obj = obj.function;
    const name = obj?.name;
    if (typeof name !== "string" || !TOOL_NAMES.has(name)) return null;
    const args = obj.arguments ?? obj.parameters ?? {};
    return {
      id: `text_${crypto.randomUUID().slice(0, 8)}`,
      type: "function",
      function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
    };
  };

  for (let i = content.indexOf("{"); i !== -1; i = content.indexOf("{", i + 1)) {
    const end = matchBrace(content, i);
    if (end === -1) continue;
    const tc = toCall(content.slice(i, end + 1));
    if (!tc) continue;
    toolCalls.push(tc);
    spans.push([i, end + 1]);
    i = end;
  }

  let cleaned = content;
  for (const [s, e] of spans.reverse()) cleaned = cleaned.slice(0, s) + cleaned.slice(e);
  cleaned = cleaned.replace(/<\/?tool_call>|```(?:json)?\s*```/g, "");

  return { content: cleaned.trim(), toolCalls };
}

/** Index of the '}' closing the '{' at `start` (string-aware), or -1. */
function matchBrace(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

async function buildSystemMessages(): Promise<ChatMessage[]> {
  const settings = await loadSettings();
  const parts: string[] = [settings.systemPrompt];

  try { parts.push("## Long-term memory\n" + (await getMemory())); } catch {}
  try { parts.push("## Skills\n" + (await getSkills())); } catch {}
  try { parts.push(await homelabContext()); } catch {
    parts.push("Homelab state unavailable right now.");
  }
  // local models (qwen) can drift into other languages after tool calls
  parts.push("Always reply in English.");

  return [{ role: "system", content: parts.join("\n\n---\n\n") }];
}

/** Handle one tool call. Returns the tool-result text, and the proposal if one was created. */
async function executeTool(tc: ToolCall): Promise<{ result: string; pending?: PendingAction }> {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(tc.function.arguments || "{}"); } catch {
    return { result: "Error: tool arguments were not valid JSON." };
  }

  if (tc.function.name === "propose_action") {
    try {
      const pending = await proposeAction(
        String(args.hostId || ""),
        String(args.container || ""),
        String(args.action || ""),
        String(args.reason || "")
      );
      return {
        result:
          `Proposal ${pending.id} created and shown to the operator for approval: ` +
          `${pending.action} '${pending.container}' on ${pending.hostName}. ` +
          `Tell the operator (in English) what you proposed and that it awaits their approval. Do not propose again.`,
        pending,
      };
    } catch (err) {
      return {
        result:
          `Proposal was NOT created. It was blocked automatically by HERA's policy engine ` +
          `(the operator never saw it): ${err instanceof Error ? err.message : String(err)} ` +
          `Explain this to the operator accurately, in English — do not say the operator denied it.`,
      };
    }
  }

  if (tc.function.name === "get_container_logs") {
    try {
      const hosts = await loadHosts();
      const host = hosts.find((h) => h.id === String(args.hostId) && h.enabled);
      if (!host) return { result: `Unknown host "${args.hostId}".` };
      // container must exist on that host
      const { hosts: states } = await getHomelabState();
      const state = states.find((s) => s.id === host.id);
      if (!state?.containers.some((c) => c.name === String(args.container))) {
        return { result: `Container "${args.container}" not found on ${host.name}.` };
      }
      const logs = await getContainerLogs(host, String(args.container), Number(args.lines) || 40);
      return { result: logs.trim().slice(-3000) || "(no log output)" };
    } catch (err) {
      return { result: `Log fetch failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  return { result: `Unknown tool: ${tc.function.name}` };
}

export async function routeChat(userMessages: ChatMessage[]): Promise<ChatResult> {
  const settings = await loadSettings();
  const providers = await activeProviders();
  if (providers.length === 0) throw new Error("No enabled AI providers. Add one in Settings.");

  const messages: ChatMessage[] = [...(await buildSystemMessages()), ...userMessages];

  const errors: string[] = [];
  for (const p of providers) {
    try {
      let pendingAction: PendingAction | undefined;
      let round = 0;

      while (round <= MAX_TOOL_ROUNDS) {
        // once a proposal exists, take the tools away — one proposal at a time
        const withTools = round < MAX_TOOL_ROUNDS && !pendingAction;
        const { content, toolCalls } = await callProvider(
          p, messages, settings.requestTimeoutMs, withTools
        );

        if (toolCalls.length > 0) {
          // record the assistant turn that made the calls
          messages.push({ role: "assistant", content: content ?? "", tool_calls: toolCalls });
          for (const tc of toolCalls) {
            const { result, pending } = await executeTool(tc);
            if (pending) pendingAction = pending;
            messages.push({ role: "tool", content: result, tool_call_id: tc.id });
          }
          round++;
          continue; // let the model see the tool results and reply
        }

        health[p.name] = "up";
        return {
          content: content || "(no reply)",
          provider: p.name,
          model: p.model,
          pendingAction,
        };
      }

      health[p.name] = "up";
      return {
        content: "I hit my tool-use limit for one message. Tell me how you'd like to proceed.",
        provider: p.name,
        model: p.model,
      };
    } catch (err) {
      health[p.name] = "down";
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${p.name}: ${msg}`);
      console.warn(`[HERA] provider "${p.name}" failed, trying next. ${msg}`);
    }
  }
  throw new Error(`All providers failed. ${errors.join(" | ")}`);
}

export async function testProvider(p: Provider): Promise<{ ok: boolean; detail: string }> {
  try {
    const { content } = await callProvider(
      p, [{ role: "user", content: "Reply with the single word: ok" }], 15000, false
    );
    health[p.name] = "up";
    return { ok: true, detail: `connected · ${(content || "").trim().slice(0, 40)}` };
  } catch (err) {
    health[p.name] = "down";
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export function providerHealth() {
  return health;
}
