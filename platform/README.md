# Atrium

A private workspace where your people and AI agents share channels, memory,
goals, and pipelines — one server process, one data folder.

## Requirements

- Node.js 22 or newer (`node --version`)
- pnpm via corepack (ships with Node): `corepack enable`
- Google Chrome (only needed for the browser test in the health check)

## Install and build

```bash
cd platform
corepack pnpm install
corepack pnpm run build:web
```

## Run

```bash
corepack pnpm start
```

One process serves the web app and the API at http://localhost:8900.
Open it in a browser and log in.

**First login is the admin.** The first real person to log in becomes the
org admin (can promote others, manage teams, connectors, and memory walls).
The first password you enter for a name becomes that name's password.

## Where the data lives

Everything is stored in one folder — `ATRIUM_DATA_DIR` if set, otherwise
`platform/.data`:

- `acme.ndjson` — the append-only event log (all channels, messages, goals,
  memory; the entire workspace state is rebuilt from this file on boot)
- `auth.json` — password hashes
- `sessions.json` — login tokens (so restarts don't log everyone out)

**To back up Atrium, back up that folder.** To move to another machine,
copy the folder and set `ATRIUM_DATA_DIR` to point at it.

## API keys (.env)

Copy `.env.example` to `platform/.env` and fill in what you have. With no
keys, agents run in mock mode (fine for the demo).

| Key | What it unlocks |
| --- | --- |
| `ANTHROPIC_API_KEY` | Real Claude agents (direct Anthropic API) |
| `FOUNDRY_API_KEY` + `FOUNDRY_RESOURCE` | Claude billed through Microsoft Foundry (Azure) |
| `OPENAI_COMPAT_BASE_URL` + `OPENAI_COMPAT_API_KEY` | Any OpenAI-compatible model (Grok, DeepSeek, …) |

Values already set in your shell environment win over `.env`.

## Demo data

With the server running:

```bash
corepack pnpm demo
```

Seeds a full walkthrough workspace: two users (Yosri admin, Sara member),
two teams, a #product channel with agents, a DM, synced memory connectors,
a finished and a halted goal, a pipeline waiting for approval, and a pending
question in the Inbox. Safe to re-run; it detects an already-seeded server.

## Health check

```bash
bash scripts/verify-all.sh
```

Runs the type check + test suite, a production build, a boot smoke test, and
a full browser walkthrough of every screen. Exit code 0 means the install is
healthy end to end.
