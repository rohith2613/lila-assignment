// ---------------------------------------------------------------------------
// Shared type definitions for the Tic-Tac-Toe match handler.
//
// These types describe the on-server game state, the messages exchanged with
// clients, and the leaderboard records. Keeping them in one place makes it
// easy to keep client and server in sync — the React frontend mirrors these
// shapes in its own types.ts file.
// ---------------------------------------------------------------------------

/**
 * The two marks a player can place. We use string literals (not numbers) so
 * messages on the wire are self-describing when debugging with Nakama Console.
 */
export type Mark = "X" | "O";

/**
 * Represents one cell of the 3x3 board. `null` means the cell is empty.
 * The board is stored as a flat 9-element array indexed top-left → bottom-right:
 *
 *   0 | 1 | 2
 *   ---------
 *   3 | 4 | 5
 *   ---------
 *   6 | 7 | 8
 */
export type Cell = Mark | null;
export type Board = Cell[];

/**
 * Game phases. The match handler uses these to gate which messages are valid.
 *
 *   - "waiting": Match created but second player has not joined yet.
 *   - "playing": Both players present, moves are accepted.
 *   - "ended":   Game finished — by win, draw, timeout, or disconnect.
 */
export type GamePhase = "waiting" | "playing" | "ended";

/**
 * Possible end-states for a finished match. We separate "win" from "timeout"
 * even though both produce a winner, because the leaderboard / UI should
 * surface the difference (timeouts are forfeits).
 */
export type EndReason = "win" | "draw" | "timeout" | "forfeit" | null;

/**
 * Match modes. "classic" has no per-move timer; "timed" forfeits the player
 * who fails to move within `turnTimeoutSeconds`.
 */
export type MatchMode = "classic" | "timed";

/**
 * Per-player metadata held in match state. We store the user id (Nakama's
 * stable id), the chosen nickname, the assigned mark, and a `presence` flag
 * so we can detect disconnects.
 */
export interface PlayerState {
  userId: string;
  username: string;
  mark: Mark;
  /** True while the player's socket is connected to the match. */
  connected: boolean;
}

/**
 * Full server-side match state. Stored as the `state` value in Nakama's
 * match handler and serialized to JSON when broadcasting to clients.
 *
 * NOTE: This object is mutated in place by the match loop. Anything we want
 * to keep across ticks lives here.
 */
export interface MatchState {
  /** Match mode chosen at creation time. */
  mode: MatchMode;

  /** 9-element board, see Cell docs. */
  board: Board;

  /** Current game phase. */
  phase: GamePhase;

  /** Whose turn it is, by mark. Always "X" first. */
  turn: Mark;

  /**
   * Map of userId → PlayerState. We deliberately use a plain object (not Map)
   * because Goja's JSON.stringify handles plain objects best.
   */
  players: { [userId: string]: PlayerState };

  /**
   * Ordered list of player user ids in join order. Useful for determining who
   * is X (first) vs O (second), and for stable iteration.
   */
  playerOrder: string[];

  /** When set, the match has ended; explains why. */
  endReason: EndReason;

  /** Winning user id (if any). For draws/timeouts this may be null. */
  winnerUserId: string | null;

  /** Indices of the three cells that form the winning line, for UI highlight. */
  winningLine: number[] | null;

  /**
   * For timed mode: the tick at which the current turn started. Combined with
   * `turnTimeoutSeconds` and the match tick rate this lets us compute the
   * remaining time on every tick without using wall-clock time (which would
   * make the server non-deterministic and hard to test).
   */
  turnStartedAtTick: number;

  /**
   * Per-turn time limit in seconds. Only meaningful in timed mode.
   * 30 seconds by default, matching the spec example.
   */
  turnTimeoutSeconds: number;

  /**
   * The match tick rate (ticks per second). Stored on state so the broadcast
   * payloads can include it for client-side countdown rendering.
   */
  tickRate: number;

  /**
   * Last tick at which we broadcast a state update. Used to throttle redundant
   * broadcasts: we always broadcast on state-changing events, plus once per
   * second in timed mode so the timer stays in sync with clients.
   */
  lastBroadcastTick: number;

  /**
   * Minimum number of ticks to wait after match creation before terminating
   * an empty match. Prevents the matchmaker from creating a match that gets
   * cleaned up before either player can join.
   */
  emptyTicksRemaining: number;

  /**
   * Ticks remaining in the post-game linger window. Set the first time we
   * see phase==="ended" and decremented every tick after that. When it hits
   * zero the match terminates.
   *
   * Optional because it's only meaningful after the game ends.
   */
  lingerTicksRemaining?: number;
}

/**
 * Op-codes used on the wire between client and server. Using small integers
 * keeps payloads compact, and they double as an enum on the client side.
 *
 * Implemented as a frozen const object rather than a `const enum` because
 * `const enum` requires `isolatedModules: false`, which conflicts with how
 * rollup-plugin-typescript compiles individual files.
 */
export const OpCode = {
  /** Server → client: full state snapshot. */
  STATE_UPDATE: 1,
  /** Client → server: player wants to place a mark at a given index. */
  MOVE: 2,
  /** Server → client: a player joined or left. */
  PRESENCE_UPDATE: 3,
  /** Server → client: the match has ended. */
  GAME_OVER: 4,
  /** Client → server: explicit request to leave/forfeit. */
  LEAVE: 5,
  /** Server → client: an error in response to a client message. */
  ERROR: 6,
} as const;
export type OpCodeValue = (typeof OpCode)[keyof typeof OpCode];

/**
 * Payload shape for a MOVE message from the client.
 */
export interface MoveMessage {
  /** Cell index 0..8. */
  cell: number;
}

/**
 * Payload shape for STATE_UPDATE broadcast.
 * This is a serializable view of MatchState that excludes server-only fields.
 */
export interface StateUpdatePayload {
  mode: MatchMode;
  board: Board;
  phase: GamePhase;
  turn: Mark;
  players: PlayerState[];
  endReason: EndReason;
  winnerUserId: string | null;
  winningLine: number[] | null;
  /** Seconds remaining on the current turn (timed mode only); 0 in classic. */
  turnSecondsRemaining: number;
  turnTimeoutSeconds: number;
}

/**
 * Leaderboard entry returned to clients via RPC.
 * Mirrors the on-disk record we keep in Nakama storage.
 */
export interface LeaderboardEntry {
  userId: string;
  username: string;
  wins: number;
  losses: number;
  draws: number;
  currentStreak: number;
  bestStreak: number;
  score: number;
}
