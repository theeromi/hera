import express from "express";
import cors from "cors";
import { routeChat, testProvider, providerHealth, type ChatMessage } from "./aiRouter.js";
import { loadSettings, saveSettings, type Settings, type Provider } from "./settingsStore.js";
import { getHomelabState, loadHosts, saveHosts } from "./connectors/hostRegistry.js";
import { readHost, type HostConfig } from "./connectors/sshConnector.js";
import { listActions, approveAction, denyAction } from "./actionEngine.js";
import {
  listConversations, createConversation, getConversation,
  appendMessage, deleteConversation,
} from "./conversationStore.js";
import { getMemory, saveMemory } from "./memoryStore.js";

/**
 * HERA backend — the brain.
 * Ep1: chat, settings, providers.  Ep2: homelab sight.
 * Ep3: conversations, memory, and ACTIONS (propose → approve → execute).
 */

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = parseInt(process.env.PORT || "8787", 10);

// ── health / status ─────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "hera-backend", version: "0.3.0" });
});

app.get("/status", async (_req, res) => {
  const s = await loadSettings();
  res.json({
    appearance: s.appearance,
    providers: s.providers.map((p) => ({
      id: p.id, name: p.name, model: p.model, enabled: p.enabled, priority: p.priority,
    })),
    health: providerHealth(),
  });
});

// ── settings ────────────────────────────────────────────────────
app.get("/settings", async (_req, res) => res.json(await loadSettings()));

app.put("/settings", async (req, res) => {
  try {
    const next = req.body as Settings;
    if (!next || !Array.isArray(next.providers)) {
      return res.status(400).json({ error: "Invalid settings payload." });
    }
    res.json(await saveSettings(next));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/providers/test", async (req, res) => {
  const p = req.body as Provider;
  if (!p?.baseUrl || !p?.model) {
    return res.status(400).json({ ok: false, detail: "Provider needs baseUrl and model." });
  }
  res.json(await testProvider(p));
});

// ── memory (HERA.md) ────────────────────────────────────────────
app.get("/memory", async (_req, res) => {
  res.json({ content: await getMemory() });
});

app.put("/memory", async (req, res) => {
  const content = req.body?.content;
  if (typeof content !== "string") return res.status(400).json({ error: "Expected { content: string }" });
  await saveMemory(content);
  res.json({ ok: true });
});

// ── homelab ─────────────────────────────────────────────────────
app.get("/homelab", async (req, res) => {
  try {
    const force = req.query.force === "1" || req.query.force === "true";
    res.json(await getHomelabState(force));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/homelab/refresh", async (_req, res) => {
  try { res.json(await getHomelabState(true)); }
  catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
});

app.get("/hosts", async (_req, res) => res.json(await loadHosts()));

app.put("/hosts", async (req, res) => {
  try {
    const hosts = req.body as HostConfig[];
    if (!Array.isArray(hosts)) return res.status(400).json({ error: "Expected an array of hosts." });
    res.json(await saveHosts(hosts));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/hosts/test", async (req, res) => {
  try {
    const host = req.body as HostConfig;
    if (!host?.address || !host?.user) {
      return res.status(400).json({ reachable: false, error: "Host needs user and address." });
    }
    res.json(await readHost(host));
  } catch (err) {
    res.status(500).json({ reachable: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ── conversations (Ep3) ─────────────────────────────────────────
app.get("/conversations", async (_req, res) => res.json(await listConversations()));

app.post("/conversations", async (_req, res) => res.json(await createConversation()));

app.get("/conversations/:id", async (req, res) => {
  const convo = await getConversation(req.params.id);
  if (!convo) return res.status(404).json({ error: "Not found" });
  res.json(convo);
});

app.delete("/conversations/:id", async (req, res) => {
  await deleteConversation(req.params.id);
  res.json({ ok: true });
});

/** Send a message in a conversation. HERA replies; may attach a pending action. */
app.post("/conversations/:id/messages", async (req, res) => {
  try {
    const content = req.body?.content;
    if (typeof content !== "string" || !content.trim()) {
      return res.status(400).json({ error: "Expected { content: string }" });
    }
    const convo = await getConversation(req.params.id);
    if (!convo) return res.status(404).json({ error: "Not found" });

    await appendMessage(convo.id, { role: "user", content });

    // history for the model: user/assistant turns only (tool internals stay internal)
    const history: ChatMessage[] = convo.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    history.push({ role: "user", content });

    const result = await routeChat(history);

    const updated = await appendMessage(convo.id, {
      role: "assistant",
      content: result.content,
      pendingActionId: result.pendingAction?.id,
    });

    res.json({
      message: updated.messages[updated.messages.length - 1],
      pendingAction: result.pendingAction || null,
      provider: result.provider,
      model: result.model,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[HERA] /conversations message error:", msg);
    res.status(502).json({ error: msg });
  }
});

// ── actions (Ep3: approve / deny) ───────────────────────────────
app.get("/actions", async (req, res) => {
  res.json(await listActions(typeof req.query.status === "string" ? req.query.status : undefined));
});

app.post("/actions/:id/approve", async (req, res) => {
  try { res.json(await approveAction(req.params.id)); }
  catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : String(err) }); }
});

app.post("/actions/:id/deny", async (req, res) => {
  try { res.json(await denyAction(req.params.id)); }
  catch (err) { res.status(400).json({ error: err instanceof Error ? err.message : String(err) }); }
});

// ── legacy stateless chat (kept for curl testing) ───────────────
app.post("/chat", async (req, res) => {
  try {
    const messages = req.body?.messages as ChatMessage[] | undefined;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Body must include a non-empty 'messages' array." });
    }
    res.json(await routeChat(messages));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[HERA] /chat error:", msg);
    res.status(502).json({ error: msg });
  }
});

app.listen(PORT, () => {
  console.log(`[HERA] backend listening on ${PORT}`);
});
