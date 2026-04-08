// ---------------------------------------------------------------------------
// Nakama client wrapper.
//
// We isolate ALL Nakama SDK calls in this file so React components only ever
// import a small, well-typed surface. This makes it easy to:
//
//   - Swap the SDK version without touching component code.
//   - Mock the client in tests.
//   - Reason about authentication / socket lifecycle in one place.
//
// The wrapper exposes:
//   - createNakamaClient()  : connects (auth + socket) and returns a session.
//   - findMatch(...)        : RPC -> matchId
//   - joinMatch(matchId)    : socket join, sets up the message listener
//   - sendMove(...)         : socket send to the active match
//   - leaveMatch(...)       : socket leave + RPC cleanup if needed
//   - getLeaderboard()      : RPC -> top N entries
// ---------------------------------------------------------------------------
import { Client, Session, Socket } from "@heroiclabs/nakama-js";
import { GameState, LeaderboardEntry, MatchMode, OpCode } from "./types";

// -- Environment-driven config -----------------------------------------------
//
// Vite exposes any `VITE_*` env var on `import.meta.env`. We default to local
// dev values so a `npm run dev` works out of the box without an .env file.

const HOST = (import.meta.env.VITE_NAKAMA_HOST as string) || "127.0.0.1";
const PORT = (import.meta.env.VITE_NAKAMA_PORT as string) || "7350";
const USE_SSL = (import.meta.env.VITE_NAKAMA_USE_SSL as string) === "true";
const SERVER_KEY =
  (import.meta.env.VITE_NAKAMA_SERVER_KEY as string) || "defaultkey";

/**
 * Persisted device id key. We generate a stable per-browser id so the same
 * user gets the same Nakama account on every visit (and therefore the same
 * leaderboard record). Stored in localStorage; cleared when the user clicks
 * "log out" (not currently in the UI but trivial to add).
 */
const DEVICE_ID_KEY = "lila-tictactoe-device-id";

/**
 * Persisted nickname. Used to pre-fill the nickname screen on return visits.
 */
const NICKNAME_KEY = "lila-tictactoe-nickname";

// -- Public types ------------------------------------------------------------

/**
 * Live connection bundle. After `createNakamaClient()` resolves you have a
 * client (REST), a session (auth token), and a socket (WebSocket).
 */
export interface NakamaConnection {
  client: Client;
  session: Session;
  socket: Socket;
  /** The user id Nakama assigned us — same as session.user_id but typed. */
  userId: string;
  /** The username the user picked, echoed back from the server. */
  username: string;
}

/**
 * Callbacks the UI provides so the wrapper can fire updates without owning
 * any React state itself.
 */
export interface MatchCallbacks {
  onState: (state: GameState) => void;
  onError: (message: string) => void;
  onDisconnect: () => void;
}

// -- Helpers -----------------------------------------------------------------

/**
 * Generate (or load) a stable per-device id. Used as Nakama's "device auth"
 * id which gives us a permanent account without requiring the user to set
 * up email/password.
 */
function getOrCreateDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    // crypto.randomUUID is supported in all modern browsers (and the small
    // set Nakama supports). Fall back to a Math.random hash if missing.
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      id = crypto.randomUUID();
    } else {
      id = "dev-" + Math.random().toString(36).slice(2) + "-" + Date.now().toString(36);
    }
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

/** Read / write the persisted nickname so the user only types it once. */
export function getStoredNickname(): string {
  return localStorage.getItem(NICKNAME_KEY) || "";
}
export function setStoredNickname(name: string): void {
  localStorage.setItem(NICKNAME_KEY, name);
}

// -- Public API --------------------------------------------------------------

/**
 * Authenticate (device auth) and open a socket. Returns a NakamaConnection
 * the rest of the UI uses for matchmaking and gameplay.
 *
 * The `nickname` is set as the Nakama display name and is what other players
 * see in the leaderboard.
 */
export async function createNakamaClient(nickname: string): Promise<NakamaConnection> {
  // Persist the nickname for next visit.
  setStoredNickname(nickname);

  // The Nakama JS SDK takes (serverKey, host, port, useSSL).
  const client = new Client(SERVER_KEY, HOST, PORT, USE_SSL);

  // Device auth: stable id, create=true means create the account if it
  // doesn't exist yet. We pass the nickname as the username so it shows up
  // on the leaderboard immediately. `vars` is empty — not used.
  const deviceId = getOrCreateDeviceId();
  const session = await client.authenticateDevice(deviceId, true, nickname);

  // If this is a returning user we still want their username updated to the
  // current nickname (in case they changed it). Nakama doesn't let you set
  // the username during a re-auth, so we update it via the account API.
  try {
    await client.updateAccount(session, { username: nickname, display_name: nickname });
  } catch (err) {
    // Username collisions can throw. We log and continue — the existing
    // username will still work, it just won't reflect the new nickname.
    console.warn("[nakama] failed to update account username:", err);
  }

  // Open the socket. The second arg is `appearOnline` (true so other players
  // can see our presence). The third arg is the protocol — we use 'protobuf'
  // to keep payloads compact. (Nakama also supports 'json'.)
  const socket = client.createSocket(USE_SSL, false);
  await socket.connect(session, true);

  // Pull the username back out of the session — Nakama may have munged it
  // (e.g. trimmed whitespace) so we use the canonical value.
  const username = (session.username as string) || nickname;
  const userId = session.user_id as string;

  return { client, session, socket, userId, username };
}

/**
 * Call the `find_match` RPC and return the match id to join.
 */
export async function findOrCreateMatch(
  conn: NakamaConnection,
  mode: MatchMode,
): Promise<string> {
  const rpcResult = await conn.client.rpc(conn.session, "find_match", { mode });
  // RPC payload is JSON. The Nakama SDK returns it pre-parsed in `payload`.
  const payload = (rpcResult.payload || {}) as { matchId?: string };
  if (!payload.matchId) {
    throw new Error("find_match RPC did not return a matchId");
  }
  return payload.matchId;
}

/**
 * Join a match by id and wire up the callbacks. Returns the initial state
 * Nakama sends as part of the join (if any).
 */
export async function joinMatch(
  conn: NakamaConnection,
  matchId: string,
  callbacks: MatchCallbacks,
): Promise<void> {
  // The socket fires onmatchdata for every server broadcast. We dispatch
  // by op-code: STATE_UPDATE -> onState, ERROR -> onError.
  conn.socket.onmatchdata = (matchData) => {
    try {
      const decoded = decodeMatchData(matchData.data);
      switch (matchData.op_code) {
        case OpCode.STATE_UPDATE: {
          const state = JSON.parse(decoded) as GameState;
          callbacks.onState(state);
          break;
        }
        case OpCode.ERROR: {
          const err = JSON.parse(decoded) as { error: string };
          callbacks.onError(err.error || "unknown server error");
          break;
        }
        default: {
          // Unknown op-codes are silently ignored. The server may add new
          // ones in future versions; old clients should not crash.
          console.warn("[nakama] unknown op_code", matchData.op_code);
        }
      }
    } catch (err) {
      console.error("[nakama] failed to decode match data", err);
      callbacks.onError("failed to decode server message");
    }
  };

  conn.socket.ondisconnect = () => {
    callbacks.onDisconnect();
  };

  // Actually join. Nakama SDK returns a Match object containing the initial
  // presence list — we don't need it directly because the server will
  // broadcast a STATE_UPDATE on join.
  await conn.socket.joinMatch(matchId);
}

/**
 * Send a MOVE message to the current match.
 */
export async function sendMove(
  conn: NakamaConnection,
  matchId: string,
  cell: number,
): Promise<void> {
  // Nakama JS SDK accepts string OR Uint8Array for the data parameter. We
  // send JSON strings — the server's `nk.binaryToString` decodes them.
  await conn.socket.sendMatchState(matchId, OpCode.MOVE, JSON.stringify({ cell }));
}

/**
 * Tell the server we want to leave (forfeit if mid-game).
 */
export async function leaveMatch(
  conn: NakamaConnection,
  matchId: string,
): Promise<void> {
  try {
    // Send the LEAVE op-code first so the server treats it as an explicit
    // forfeit, then leave the socket presence list.
    await conn.socket.sendMatchState(matchId, OpCode.LEAVE, JSON.stringify({}));
  } catch (err) {
    // The match may already be torn down — that's fine.
    console.warn("[nakama] LEAVE op-code send failed (match likely gone)", err);
  }
  try {
    await conn.socket.leaveMatch(matchId);
  } catch (err) {
    console.warn("[nakama] socket leaveMatch failed", err);
  }
}

/**
 * Fetch the global leaderboard top N. Used by the result screen.
 */
export async function getLeaderboard(
  conn: NakamaConnection,
  limit = 10,
): Promise<LeaderboardEntry[]> {
  const result = await conn.client.rpc(conn.session, "get_leaderboard", { limit });
  const payload = (result.payload || {}) as { entries?: LeaderboardEntry[] };
  return payload.entries || [];
}

// -- Private helpers ---------------------------------------------------------

/**
 * Decode the `data` field of a match-data event into a UTF-8 string.
 *
 * Nakama JS SDK behavior:
 *   - Old versions: `data` is a base64-encoded string.
 *   - New versions: `data` is a Uint8Array.
 *
 * We handle both so a future SDK upgrade doesn't surprise us.
 */
function decodeMatchData(data: string | Uint8Array): string {
  if (typeof data === "string") {
    // base64 -> binary string -> UTF-8 string. atob handles latin1; for
    // proper UTF-8 we'd need a TextDecoder pipe, but our payloads are ASCII
    // JSON so atob alone is fine.
    try {
      return atob(data);
    } catch {
      return data;
    }
  }
  return new TextDecoder().decode(data);
}
