# LILA Tic-Tac-Toe — Full-Stack Multiplayer Assignment

A production-ready, server-authoritative multiplayer Tic-Tac-Toe game built
for the [LILA Games](https://linktr.ee/lilagames) backend assignment.

- **Backend:** [Nakama 3.22](https://heroiclabs.com/nakama/) with custom
  match handler, matchmaking, and leaderboard logic written in TypeScript and
  bundled into a single JS file consumed by Nakama's Goja runtime.
- **Frontend:** React 18 + Vite + TypeScript + Tailwind CSS, mobile-first
  responsive UI, real-time updates over Nakama's WebSocket transport.
- **Infra:** Docker Compose for local dev and single-host production.
  Postgres for state, Nakama for game logic + auth + sockets.

```
┌──────────────────┐                ┌──────────────────────┐
│   React client   │ ── WebSocket ──│   Nakama server      │
│  (Vite + Tailw.) │ ── HTTPS  ─────│  (Go + JS runtime)   │
└──────────────────┘                │   ↓                  │
                                    │   match_handler.ts   │
                                    │   matchmaking.ts     │
                                    │   leaderboard.ts     │
                                    └──────────────────────┘
                                              │
                                              ▼
                                      ┌──────────────┐
                                      │  Postgres 16 │
                                      └──────────────┘
```

---

## Table of contents

1. [Features](#features)
2. [Repository layout](#repository-layout)
3. [Quick start (local)](#quick-start-local)
4. [How to test multiplayer locally](#how-to-test-multiplayer-locally)
5. [Architecture and design decisions](#architecture-and-design-decisions)
6. [API / server configuration](#api--server-configuration)
7. [Deployment](#deployment)
8. [Known limitations / TODOs](#known-limitations--todos)

---

## Features

### Core requirements

- **Server-authoritative game logic.** Every move is validated on the server
  before it's applied. Clients only render whatever state the server
  broadcasts; they cannot manipulate the board, skip turns, or move out of
  order. See [`nakama/src/game_logic.ts`](nakama/src/game_logic.ts) and
  [`nakama/src/match_handler.ts`](nakama/src/match_handler.ts).
- **Matchmaking.** Players call a `find_match` RPC that either joins an
  existing open room in the requested mode or creates a new one. Game rooms
  are discoverable via the `list_open_matches` RPC and joinable by id.
- **Connection / disconnection handling.** Disconnects mid-game are treated
  as forfeits — the remaining player wins and the leaderboard updates
  accordingly. Reconnects on the same user id are accepted in the
  `matchJoinAttempt` hook.
- **Real-time mobile UI.** Responsive, touch-friendly React frontend with
  ink-in cell animations, winning-line highlighting, and a turn timer.

### Bonus requirements (all implemented)

- **Concurrent game support.** Each `nk.matchCreate` call spawns an isolated
  match instance. Nakama tracks state per match — no cross-contamination.
  The match label encodes mode and open/closed state so the matchmaker can
  query for joinable rooms via Bleve search.
- **Leaderboard system.** Wins, losses, draws, current and best win streaks
  are persisted in Nakama storage. A separate Nakama leaderboard ranks
  players by cumulative score (`100 × wins + 25 × draws`). The result screen
  refetches the leaderboard via the `get_leaderboard` RPC.
- **Timer-based game mode.** Selectable from the mode-select screen. The
  server enforces a 30-second per-move clock; expiration triggers a forfeit
  with a `"timeout"` end reason. The client renders a live countdown pill
  that turns yellow at 50% and red at 25%.

---

## Repository layout

```
lila-assignment/
├── README.md                    # This file
├── DEPLOYMENT.md                # Step-by-step cloud deploy guide
├── docker-compose.yml           # Postgres + Nakama, ready to `docker compose up`
├── .gitignore
│
├── nakama/                      # Nakama server + TypeScript modules
│   ├── Dockerfile               # Multi-stage: builds TS modules then mounts on Nakama
│   ├── local.yml                # Nakama runtime config
│   ├── package.json             # TS / rollup tooling
│   ├── tsconfig.json
│   ├── rollup.config.mjs        # Bundles src/*.ts → build/index.js
│   ├── scripts/copy-bundle.mjs  # Copies build/index.js → data/modules/index.js
│   ├── src/
│   │   ├── main.ts              # InitModule entry point — registers everything
│   │   ├── types.ts             # Shared types & op-codes
│   │   ├── game_logic.ts        # Pure Tic-Tac-Toe rules
│   │   ├── match_handler.ts     # 7 match lifecycle hooks
│   │   ├── matchmaking.ts       # find_match / create_private_match RPCs
│   │   ├── leaderboard.ts       # Stats persistence + leaderboard writes
│   │   └── rpcs.ts              # get_leaderboard / get_my_stats / healthcheck
│   └── data/modules/            # Build output lands here (in .gitignore? no, committed)
│
└── frontend/                    # React + Vite frontend
    ├── package.json
    ├── vite.config.ts
    ├── tailwind.config.js
    ├── postcss.config.js
    ├── tsconfig.json
    ├── index.html
    ├── .env.example             # Copy to .env, override Nakama host/port
    └── src/
        ├── main.tsx             # ReactDOM render
        ├── App.tsx              # Screen state machine
        ├── index.css            # Tailwind layers + base resets
        ├── vite-env.d.ts        # Type definitions for VITE_* env vars
        ├── nakama/
        │   ├── client.ts        # Nakama SDK wrapper (auth, socket, RPCs)
        │   └── types.ts         # Mirror of nakama/src/types.ts
        └── components/
            ├── NicknameScreen.tsx
            ├── ModeSelect.tsx
            ├── MatchmakingScreen.tsx
            ├── GameBoard.tsx
            └── ResultScreen.tsx
```

---

## Quick start (local)

### Prerequisites

- **Docker** + **Docker Compose v2** (for Postgres + Nakama)
- **Node.js 20+** (for building the TS modules and running the frontend)

### 1. Build the Nakama runtime modules

```bash
cd nakama
npm install
npm run build      # type-check → rollup bundle → copy to data/modules/index.js
cd ..
```

The build pipeline:
1. `tsc --noEmit` type-checks all TypeScript files
2. `rollup -c` bundles `src/main.ts` and its imports into one ES5-compatible
   CommonJS file (`build/index.js`)
3. `node scripts/copy-bundle.mjs` copies the bundle into
   `data/modules/index.js` where Nakama can pick it up

### 2. Bring up Postgres + Nakama

```bash
docker compose up --build
```

This will:
- Start `postgres:16-alpine` with a persisted volume
- Build the Nakama image (which bakes our compiled JS module in)
- Run `nakama migrate up` to apply schema migrations
- Start Nakama on:
  - `:7349` — gRPC API
  - `:7350` — HTTP/REST + WebSocket (this is what the frontend talks to)
  - `:7351` — Nakama Console (admin UI; user `admin`, password
    `lila_admin_change_me`)
  - `:9100` — Prometheus metrics

You should see something like:

```
lila-nakama   | {"level":"info","msg":"LILA Tic-Tac-Toe runtime initializing..."}
lila-nakama   | {"level":"info","msg":"Registered match module: lila_tictactoe"}
lila-nakama   | {"level":"info","msg":"Registered 6 RPCs"}
lila-nakama   | {"level":"info","msg":"Created leaderboard global_tictactoe"}
lila-nakama   | {"level":"info","msg":"LILA Tic-Tac-Toe runtime initialized successfully"}
lila-nakama   | {"level":"info","msg":"Startup done"}
```

### 3. Run the frontend

```bash
cd frontend
cp .env.example .env       # the defaults already point at localhost:7350
npm install
npm run dev                # starts Vite on http://localhost:5173
```

Open <http://localhost:5173> in two browsers (or one normal + one
incognito) to play against yourself.

---

## How to test multiplayer locally

The easiest end-to-end smoke test:

1. Open <http://localhost:5173> in **two** browser windows. Use one normal
   window and one incognito/private window so they get distinct device ids
   (and therefore distinct Nakama accounts).
2. In window 1: enter nickname `Ace`, click Continue, choose Classic.
3. In window 2: enter nickname `Boo`, click Continue, choose Classic.
4. Window 1 will be in the matchmaking queue first. As soon as window 2
   joins, both windows should jump to the game screen with one player as
   X and the other as O.
5. Tap cells to play. Each move should appear in both windows in well under
   a second.
6. Force a win, draw, or click "Leave room" to forfeit. Both clients should
   transition to the result screen and the leaderboard should reflect the
   updated W/L/D and score.

To test the **timed mode**, repeat the steps but choose Timed on both
sides. You'll see a countdown pill above the board. Don't move for 30
seconds and the server will declare the other player the winner with a
`"timeout"` end reason.

To test **disconnect handling**, start a game then close one window
mid-match. The other window should immediately receive a `forfeit` end
state.

To test **concurrent matches**, open more than two windows and create
matches in parallel — each pair gets its own isolated server-side match
instance.

You can poke the runtime directly via the Nakama Console at
<http://localhost:7351> (admin / `lila_admin_change_me`). The "Storage" and
"Leaderboards" tabs are particularly useful for verifying the leaderboard
state.

---

## Architecture and design decisions

### Why Nakama?

The assignment specified Nakama. Given that, the question was whether to
write the server logic in Go (compiled into the Nakama binary) or in
TypeScript (loaded by Nakama's JS runtime). I picked **TypeScript** because:

- The full match handler is a few hundred lines — Go's deployment overhead
  (cross-compile, custom build args) isn't worth it at this size.
- TypeScript shares types with the React client, so the wire format is
  guaranteed in sync at compile time.
- The `nakama-runtime` npm package gives full type definitions for every
  Nakama API, so the IDE catches misuse.
- Goja (Nakama's JS engine) is fast enough for a 5 Hz turn-based game.

### Server-authoritative gameplay

All game state (`board`, `turn`, `phase`, `winningLine`, `endReason`) lives
in the `MatchState` object inside the match handler. Clients **never** send
the new board state — they only send a `MOVE` op-code with a cell index
between 0 and 8. The server then:

1. Validates the cell index is an integer in `[0, 8]`.
2. Validates the cell is empty.
3. Validates it's the sender's turn (matched against the player's assigned
   mark).
4. Applies the move.
5. Re-evaluates the board for a winning line or a draw.
6. Broadcasts the new state to both players.

Any failure step sends an `ERROR` op-code back to the offending client and
makes no state change. The client UI treats `ERROR` as a non-fatal toast.
Source: [`match_handler.ts:handleMove`](nakama/src/match_handler.ts).

### Matchmaking via custom RPC

Nakama ships with a powerful generic matchmaker, but it's optimized for
multi-criteria skill-based matching. For 2-player Tic-Tac-Toe we just want
"find any open room of mode X", so I implemented a tiny RPC that calls
`nk.matchList(...)` with a Bleve query against the match label
(`+label.mode:classic +label.open:1`) and returns the first hit, falling
back to `nk.matchCreate(...)` if none exists. The match label is updated to
`open:0` once two players join, so the matchmaker stops listing it.

Source: [`matchmaking.ts:findMatchRpc`](nakama/src/matchmaking.ts).

### Leaderboard with both storage and a Nakama leaderboard

Nakama's built-in leaderboard records hold a single score, but the spec asks
for wins / losses / streaks displayed in the UI. So I store the full stats
record as a Nakama storage object (`stats/tictactoe`) and **mirror** the
computed score onto a Nakama leaderboard (`global_tictactoe`). The
leaderboard gives us cheap top-N queries; the storage object lets us load
the W/L/D breakdown via leaderboard metadata.

Storage permissions are set to `permissionRead=2, permissionWrite=0` —
publicly readable but only writable by the server, so a malicious client
can't tamper with their own stats.

Source: [`leaderboard.ts`](nakama/src/leaderboard.ts).

### Timer mode without wall-clock time

The per-move countdown is computed from the match tick number rather than
wall-clock time:

```ts
const elapsedTicks = currentTick - state.turnStartedAtTick;
const elapsedSeconds = Math.floor(elapsedTicks / state.tickRate);
const remaining = state.turnTimeoutSeconds - elapsedSeconds;
```

This makes the server deterministic — replaying the same tick stream
produces the same outcome — and avoids time-zone / NTP drift bugs. The
client receives the remaining seconds in every state broadcast and only
animates the local digit; it never makes its own decision about timeouts.

### Frontend state model

The React app is a 5-state state machine driven by a single `useState`
inside `App.tsx`:

```
nickname → mode → matchmaking → game → result
                                  ↑       │
                                  └───────┘  ("Play Again")
```

The Nakama socket lives on the connection object created during the
nickname step. Each screen receives the connection as a prop and only the
matchmaking and game screens actually call socket APIs. The socket
`onmatchdata` callback is wired up by `joinMatch` in
[`nakama/client.ts`](frontend/src/nakama/client.ts) and dispatches by
op-code into the React tree.

---

## API / server configuration

### Nakama config (`nakama/local.yml`)

| Field                                | Value                          | Why                                              |
| ------------------------------------ | ------------------------------ | ------------------------------------------------ |
| `runtime.path`                       | `./data/modules`               | Where rollup writes the JS bundle                |
| `runtime.js_entrypoint`              | `index.js`                     | Single bundled file                              |
| `socket.server_key`                  | `defaultkey`                   | **Change in production** — must match client    |
| `session.encryption_key`             | `lila_default_…`               | **Change in production** — long random string    |
| `console.username` / `password`      | `admin` / `lila_admin_change_me` | **Change in production** — admin UI is powerful |
| `metrics.prometheus_port`            | `9100`                         | Prometheus scrape endpoint                       |

### RPCs

All RPCs live in `nakama/src/matchmaking.ts` and `nakama/src/rpcs.ts`.
The client calls them via `client.rpc(session, "<name>", payload)`.

| RPC name              | Auth required | Payload                  | Returns                                              |
| --------------------- | ------------- | ------------------------ | ---------------------------------------------------- |
| `find_match`          | yes           | `{ mode: "classic"\|"timed" }` | `{ matchId: string }`                          |
| `create_private_match`| yes           | `{ mode }`               | `{ matchId: string }`                                |
| `list_open_matches`   | yes           | `{ mode }`               | `{ matches: [{matchId, label, size}] }`              |
| `get_leaderboard`     | yes           | `{ limit?: number }`     | `{ entries: LeaderboardEntry[] }`                    |
| `get_my_stats`        | yes           | none                     | `LeaderboardEntry`                                   |
| `healthcheck`         | no            | none                     | `{ ok: true, ts: number }`                           |

### Op-codes (over the match data channel)

| Code | Direction       | Purpose                                  | Payload                          |
| ---- | --------------- | ---------------------------------------- | -------------------------------- |
| 1    | server → client | Full state snapshot                      | `StateUpdatePayload`             |
| 2    | client → server | Place a mark                             | `{ cell: number }`               |
| 3    | server → client | (Reserved — presence updates)            | -                                |
| 4    | server → client | (Reserved — explicit game-over event)    | -                                |
| 5    | client → server | Voluntary leave / forfeit                | `{}`                             |
| 6    | server → client | Error in response to a client message    | `{ error: string }`              |

### Frontend env vars

| Var                      | Default        | Purpose                              |
| ------------------------ | -------------- | ------------------------------------ |
| `VITE_NAKAMA_HOST`       | `localhost`    | Nakama hostname (no scheme/port)     |
| `VITE_NAKAMA_PORT`       | `7350`         | Nakama HTTP port                     |
| `VITE_NAKAMA_USE_SSL`    | `false`        | `true` if Nakama is behind HTTPS     |
| `VITE_NAKAMA_SERVER_KEY` | `defaultkey`   | Must match `socket.server_key`       |

---

## Deployment

See [`DEPLOYMENT.md`](DEPLOYMENT.md) for a step-by-step guide covering:

- Deploying Nakama + Postgres to a DigitalOcean droplet (or any Linux VM)
- Putting a TLS-terminating Caddy proxy in front of port 7350
- Deploying the React frontend to Vercel (or Netlify, GitHub Pages, etc.)
- Wiring the frontend's `VITE_NAKAMA_*` vars to the public Nakama host

---

## Known limitations / TODOs

These are intentional cuts to keep the assignment focused:

- **No skill-based matchmaking.** All players in the queue for a given mode
  are paired first-come-first-served. Adding ELO/skill tracking is
  straightforward (the leaderboard already has a score) but out of scope.
- **No spectator mode.** Late joiners are rejected. The match handler has
  the hooks to allow them but the UI does not.
- **No private rooms in the UI.** The `create_private_match` RPC exists on
  the server but no UI calls it. Adding a "play with a friend" screen would
  be ~50 lines.
- **No tests yet.** The pure functions in `game_logic.ts` are designed to be
  trivially unit-testable; I'd add a Vitest suite as the very first thing in
  a follow-up.
- **No CI pipeline.** A small GitHub Actions workflow that runs `npm run
  build` in both packages would catch regressions on every PR.

---

## License

This project was built solely for the LILA Games hiring assignment. All
trademarks belong to their respective owners.
