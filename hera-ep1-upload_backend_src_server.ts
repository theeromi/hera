import express from "express";
import cors from "cors";
import { routeChat, testProvider, providerHealth, type ChatMessage } from "./aiRouter.js";
import { loadSettings, saveSettings, type Settings, type Provider } from "./settingsStore.js";

/**
 * HERA backend server — the brain.
 * The web app talks to these endpoints. Future clients (webhooks, mobile,
 * voice) will hit the same brain.
 */

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = parseInt(process.env.PORT || "8787", 10);

// ── health / status ─────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "hera-backend", version: "0.1.0" });
});

// status for the dashboard + LEDs: providers + live health
app.get("/status", async (_req, res) => {
  const s = await loadSettings();
  res.json({
    appearance: s.appearance,
    providers: s.providers.map((p) => ({
      id: p.id, name: p.name, model: p.model,
      enabled: p.enabled, priority: p.priority,
    })),
    health: providerHealth(),
  });
});

// ── settings (read/write from the UI) ───────────────────────────
app.get("/settings", async (_req, res) => {
  res.json(await loadSettings());
});

app.put("/settings", async (req, res) => {
  try {
    const next = req.body as Settings;
    if (!next || !Array.isArray(next.providers)) {
      return res.status(400).json({ error: "Invalid settings payload." });
    }
    const saved = await saveSettings(next);
    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// test a single provider (the Settings "Test" button)
app.post("/providers/test", async (req, res) => {
  const p = req.body as Provider;
  if (!p?.baseUrl || !p?.model) {
    return res.status(400).json({ ok: false, detail: "Provider needs baseUrl and model." });
  }
  res.json(await testProvider(p));
});

// ── chat ────────────────────────────────────────────────────────
app.post("/chat", async (req, res) => {
  try {
    const messages = req.body?.messages as ChatMessage[] | undefined;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Body must include a non-empty 'messages' array." });
    }
    const result = await routeChat(messages);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[HERA] /chat error:", msg);
    res.status(502).json({ error: msg });
  }
});

app.listen(PORT, () => {
  console.log(`[HERA] backend listening on ${PORT}`);
});
