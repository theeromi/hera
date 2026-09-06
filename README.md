# HERA — Homelab Environment & Resource Assistant v1

> A self-hosted AI assistant for your homelab. Runs on your hardware, talks to
> your local Ollama (with an optional cloud fallback), and configures itself
> from a web console. Built in public, episode by episode.

**Episode 1 — the foundation.** A branded multi-view console (Dashboard, Chat,
Settings, Integrations) backed by a small Express service that routes chat to
any OpenAI-compatible provider in priority order, falling back automatically
when one fails. No homelab control yet — that starts in Episode 2.

## Features

- 🖥️ **Rack-console web UI** — dashboard, chat, settings, integrations
- 🔌 **Bring your own AI** — anything OpenAI-compatible (Ollama, Groq, OpenAI…)
- ♻️ **Automatic fallback** — tries providers by priority, moves on when one fails
- ⚙️ **Configure from the UI** — add, test, and prioritize providers; no file editing
- 📱 **Works on a phone** — the console collapses to a mobile layout
- 🎨 **Rebrandable** — change the name and accent color in Settings
- 🐳 **Self-hostable** — one `docker compose up`

## Repo layout

```
hera/
├── docker-compose.yml        backend on :8787, nginx-served frontend on :8080
├── backend/
│   ├── Dockerfile            node:22-alpine, builds TS, volume at /app/data
│   ├── package.json          express + cors; tsx/tsc for dev and build
│   ├── tsconfig.json
│   ├── .env.example          template (see "Configuration" — .env is NOT auto-loaded)
│   └── src/
│       ├── server.ts         Express app, all HTTP endpoints
│       ├── aiRouter.ts       provider fan-out, priority order, fallback, health
│       └── settingsStore.ts  JSON settings persisted to data/settings.json
└── frontend/
    └── index.html            the entire console — no build step, no dependencies
```

Not in git (see [`.gitignore`](.gitignore)): `node_modules/`, `dist/`, `.env`,
and **`backend/data/`** — that directory holds `settings.json`, which stores
provider API keys in plaintext.

## Requirements

- Docker + Docker Compose
- At least one OpenAI-compatible AI provider — a local [Ollama](https://ollama.com)
  instance and/or a cloud API key

## Quick start

```bash
git clone https://github.com/theeromi/hera.git
cd hera
docker compose up -d --build
```

- Web console: `http://<host>:8080`
- Backend API: `http://<host>:8787`

Then open **Settings → AI Providers**, point HERA at your Ollama (base URL
`http://YOUR-OLLAMA-IP:11434/v1`, model e.g. `qwen2.5:14b`, API key `ollama`),
press **Test**, then **Add provider**. Add a cloud provider with a higher
priority number to get automatic fallback.

> The console guesses the backend is on port `8787` of whatever host you loaded
> the page from. If that's wrong — or you opened `index.html` directly — set it
> under **Settings → Connection**, or append `?api=http://host:8787` to the URL.

## Running without Docker

```bash
cd backend
npm install
npm run dev          # tsx watch, or: npm run build && npm start
```

Serve `frontend/index.html` with any static server, or just open the file.

## Configuration

**Providers, appearance, and the system prompt are configured in the UI** and
persisted to `settings.json` in the data directory. Under Docker that directory
is the named volume `hera-data`, so it survives rebuilds — and it is *not* the
`backend/data/` folder in your working tree.

Only four environment variables are read, and only to seed defaults on first
run, before any settings file exists:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Port the backend listens on |
| `HERA_DATA_DIR` | `./data` | Where `settings.json` is written |
| `LOCAL_AI_BASE_URL` | `http://192.168.1.100:11434/v1` | Seeds the default local provider |
| `LOCAL_AI_MODEL` | `qwen2.5:14b` | Seeds the default local provider's model |

⚠️ **`.env` files are not loaded.** `dotenv` is listed as a dependency but is
never imported, so these must be set in the real environment — `docker-compose.yml`
does this via `environment:`. Once `settings.json` exists, the seed values are
ignored entirely and the UI is the only source of truth.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness probe |
| `GET` | `/status` | Providers (keys omitted) + live health, for the dashboard LEDs |
| `GET` | `/settings` | Full settings, **including provider API keys** |
| `PUT` | `/settings` | Replace settings |
| `POST` | `/providers/test` | Ping one provider — the Settings "Test" button |
| `POST` | `/chat` | `{ messages: [...] }` → routed completion |

## Architecture

```
Web console  ──►  HERA backend (brain)  ──►  AI providers
(dashboard/chat/   /chat /settings /status     local Ollama  (priority 1)
 settings/integ)   /providers/test             cloud API     (priority 2, fallback)
```

The backend is the brain; the web console is its first client. Webhooks, mobile,
and homelab connectors plug into the same brain in later episodes.

## Security notes

This is a **trusted-LAN** service as of Episode 1:

- There is **no authentication** on any endpoint.
- `GET /settings` returns provider API keys in cleartext to anyone who can reach it.
- CORS is wide open (`cors()` with no options).
- Keys are stored unencrypted in `settings.json`.

Don't expose port `8787` to the internet, and keep `backend/data/` out of git.

## Roadmap

- **Ep 1** — foundation: console + chat + provider config ✅
- **Ep 2** — HERA sees your homelab (read-only overview)
- **Ep 3** — Docker connector + safe actions (approval-gated)
- **Ep 4** — Proxmox connector (VMs, approval-gated)
- **Ep 5** — webhooks, dashboard sync, proactive alerts
- **Ep 6+** — memory, mobile, voice

## Safety principles

HERA never performs destructive actions without explicit approval. The AI
decides *what to propose*; connector code executes only *allowed* actions via
official APIs. If HERA is unsure, it asks before proceeding.

## License

MIT — fork it, rebrand it, make it yours.
