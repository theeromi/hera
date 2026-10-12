# HERA — Homelab Environment & Resource Assistant

> A self-hosted AI assistant for your homelab. Runs on your hardware, talks to
> your local Ollama (with an optional cloud fallback), and configures itself
> from a web console. Built in public, episode by episode.

HERA is a self-hosted assistant for monitoring a homelab and proposing a small,
allowlisted set of Docker actions. It routes chat to OpenAI-compatible providers,
reads host state over SSH, and persists conversations, memory, and pending action
proposals locally.

## Features

- 🖥️ **Rack-console web UI** — dashboard, chat, settings, integrations
- 🔌 **Bring your own AI** — anything OpenAI-compatible (Ollama, Groq, OpenAI…)
- ♻️ **Automatic fallback** — tries providers by priority, moves on when one fails
- ⚙️ **Configure from the UI** — add, test, and prioritize providers; no file editing
- 📱 **Works on a phone** — the console collapses to a mobile layout
- 🎨 **Rebrandable** — change the name and accent color in Settings
- 🐳 **Approval-gated Docker actions** — start, stop, or restart a known container
- 🧠 **Persistent conversations and memory** — stored in the backend data directory
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
│       ├── server.ts         Express app and HTTP endpoints
│       ├── aiRouter.ts       provider routing, native tools, and fallback
│       ├── actionEngine.ts   validates proposals and executes approved actions
│       ├── conversationStore.ts  persistent conversation history
│       ├── memoryStore.ts    operator memory and Docker skill defaults
│       ├── settingsStore.ts  settings persisted to data/settings.json
│       └── connectors/      SSH host inventory, status reads, Docker actions
└── frontend/
    └── index.html            the entire console — no build step, no dependencies
```

Not in git (see [`.gitignore`](.gitignore) and [backend/.gitignore](backend/.gitignore)):
`node_modules/`, `dist/`, `.env` files, ZIP archives, and **`backend/data/`**.
The data directory may contain provider keys, host addresses, conversations,
action history, and operator memory. Do not commit it.

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

HERA creates a default local host entry on first run. Configure additional
hosts through the `/hosts` API and assign each a policy: `readonly` blocks
actions, while `guarded` and `sandbox` require operator approval. The default
policy for hosts without an explicit value is `guarded`.

> The console connects to port `8787` on the same hostname serving the page.
> When opening the HTML directly, it uses `http://localhost:8787`.

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
| `LOCAL_AI_BASE_URL` | `http://YOUR-OLLAMA-HOST:11434/v1` | Seeds the default local provider |
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
| `GET`, `POST` | `/conversations` | List or create persistent conversations |
| `GET`, `DELETE` | `/conversations/:id` | Read or delete a conversation |
| `POST` | `/conversations/:id/messages` | Add a message and receive HERA's reply |
| `GET` | `/actions` | List action proposals; optional `?status=pending` |
| `POST` | `/actions/:id/approve` | Approve and execute an allowlisted action |
| `POST` | `/actions/:id/deny` | Deny a pending action |
| `GET`, `PUT` | `/memory` | Read or update `memory/HERA.md` |
| `GET`, `PUT` | `/hosts` | Read or replace host configuration |
| `POST` | `/hosts/test` | Test one SSH host connection |
| `GET` | `/homelab` | Read host state; `?force=1` refreshes it |
| `POST` | `/homelab/refresh` | Force a fresh host scan |

## Architecture

```
Web console  ──►  HERA backend  ──►  AI providers
 (chat, settings,      │             local Ollama / cloud fallback
 homelab, approvals)   ├── SSH host reads
                       └── approved Docker actions
```

The backend is the brain; the web console is its first client. Future episodes
can add integrations such as Proxmox, webhooks, and dashboard synchronization.

## Security notes

This is a **trusted-LAN** service; it is not safe to expose directly to the
internet:

- There is **no authentication** on any endpoint. Anyone who can reach the
  backend can read or modify settings, memory, and hosts, and can approve
  pending actions.
- `GET /settings` returns provider API keys in cleartext to anyone who can reach it.
- CORS is wide open (`cors()` with no options).
- Keys are stored unencrypted in `settings.json`.
- Docker actions are limited to `start`, `stop`, and `restart`, validate the
  host/container, and recheck host policy and container presence at approval.
  This is an application guard, not a substitute for network access controls.

Don't expose port `8787` to the internet, and keep `backend/data/` out of git.

## Roadmap

- **Ep 1** — foundation: console + chat + provider config ✅
- **Ep 2** — HERA sees your homelab (read-only overview) ✅
- **Ep 3** — Docker connector, conversations, memory, approval-gated actions ✅
- **Ep 4** — Proxmox connector (VMs, approval-gated)
- **Ep 5** — webhooks, dashboard sync, proactive alerts
- **Ep 6+** — mobile, voice, and additional integrations

## Safety principles

HERA never performs destructive actions without explicit approval. The AI
decides *what to propose*; connector code executes only *allowed* actions via
official APIs. If HERA is unsure, it asks before proceeding.

## License

MIT — fork it, rebrand it, make it yours.
