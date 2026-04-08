// ---------------------------------------------------------------------------
// Client-side mirror of the server types defined in nakama/src/types.ts.
//
// Keeping this in sync by hand is acceptable for an assignment of this size.
// In a larger project I'd generate these from a shared schema (e.g. zod or
// protobuf) so the two sides can't drift.
// ---------------------------------------------------------------------------

export type Mark = "X" | "O";
export type Cell = Mark | null;
export type Board = Cell[];

export type GamePhase = "waiting" | "playing" | "ended";

export type EndReason = "win" | "draw" | "timeout" | "forfeit" | null;

export type MatchMode = "classic" | "timed";

export interface PlayerState {
  userId: string;
  username: string;
  mark: Mark;
  connected: boolean;
}

/**
 * Server-broadcast game state. Matches StateUpdatePayload on the backend.
 * Note that `players` is an array (not a map) — the backend converts the
 * map for us before sending.
 */
export interface GameState {
  mode: MatchMode;
  board: Board;
  phase: GamePhase;
  turn: Mark;
  players: PlayerState[];
  endReason: EndReason;
  winnerUserId: string | null;
  winningLine: number[] | null;
  turnSecondsRemaining: number;
  turnTimeoutSeconds: number;
}

/**
 * Op-codes mirror nakama/src/types.ts. Plain object instead of enum so the
 * shape is identical to the server-side const object.
 */
export const OpCode = {
  STATE_UPDATE: 1,
  MOVE: 2,
  PRESENCE_UPDATE: 3,
  GAME_OVER: 4,
  LEAVE: 5,
  ERROR: 6,
} as const;

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
