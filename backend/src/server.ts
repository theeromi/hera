import express from "express";
import cors from "cors";
import { routeChat, testProvider, providerHealth, type ChatMessage } from "./aiRouter.js";
import { loadSettings, saveSettings, type Settings, type Provider } from "./settingsStore.js";
import { getHomelabState, loadHosts, saveHosts } from "./connectors/hostRegistry.js";
import { readHost, type HostConfig } from "./connectors/sshConnector.js";

/**
 * HERA backend server — the brain.
 * Episode 1: chat, settings, providers.
 * Episode 2: homelab state + host management.
 */

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = parseInt(process.env.PORT || "8787", 10);

// ── health / status ─────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "hera-backend", version: "0.2.0" });
});

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

// ── settings ────────────────────────────────────────────────────
app.get("/settings", async (_req, res) => {
  res.json(await loadSettings());
});

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

// ── EPISODE 2: homelab ──────────────────────────────────────────

/** Current homelab state (cached). ?force=1 to re-scan now. */
app.get("/homelab", async (req, res) => {
  try {
    const force = req.query.force === "1" || req.query.force === "true";
    res.json(await getHomelabState(force));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Force a fresh read of every host. */
app.post("/homelab/refresh", async (_req, res) => {
  try {
    res.json(await getHomelabState(true));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** The configured hosts (for the UI). */
app.get("/hosts", async (_req, res) => {
  res.json(await loadHosts());
});

app.put("/hosts", async (req, res) => {
  try {
    const hosts = req.body as HostConfig[];
    if (!Array.isArray(hosts)) return res.status(400).json({ error: "Expected an array of hosts." });
    res.json(await saveHosts(hosts));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Test a single host connection (the "Test" button in the UI). */
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

// ── chat ────────────────────────────────────────────────────────
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
