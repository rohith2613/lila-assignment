// ---------------------------------------------------------------------------
// Leaderboard + player stats persistence.
//
// We use TWO Nakama subsystems together:
//
//   1. Storage objects (collection: "stats")
//        Stores per-user wins/losses/draws/streaks. We need our own object
//        because Nakama's built-in leaderboard records only hold a single
//        score, but we want to display W/L/D/streak in the UI.
//
//   2. Leaderboard ("global_tictactoe")
//        A Nakama leaderboard ranks users by their `score` (an integer we
//        compute below). The leaderboard gives us cheap top-N queries and
//        global rank lookups, which storage objects do not.
//
// On every game-end the match handler calls `recordResult(...)` for both
// players. We update the storage object first (source of truth) and then
// mirror the new score onto the leaderboard.
// ---------------------------------------------------------------------------
import { LeaderboardEntry } from "./types";

/** Collection name for our per-user stats storage objects. */
export const STATS_COLLECTION = "stats";
/** Key inside that collection. We only keep one stats record per user. */
export const STATS_KEY = "tictactoe";

/** Id of the global leaderboard we create at module init time. */
export const LEADERBOARD_ID = "global_tictactoe";

/** Score awarded for a win, loss, draw. */
const SCORE_WIN = 100;
const SCORE_DRAW = 25;
const SCORE_LOSS = 0;

/**
 * Per-user stats record stored as JSON in Nakama storage.
 *
 * `currentStreak` is the number of consecutive wins (broken by loss/draw).
 * `bestStreak` is the all-time best.
 */
interface StatsRecord {
  wins: number;
  losses: number;
  draws: number;
  currentStreak: number;
  bestStreak: number;
  /** Last 4 game results, newest first. Used purely for diagnostics, not UI. */
  recentResults?: ("win" | "loss" | "draw")[];
}

/** Result outcome for a single game. */
export type GameOutcome = "win" | "loss" | "draw";

/**
 * Ensure the global leaderboard exists. Called once at runtime init.
 *
 * Nakama will throw if you try to create a leaderboard that already exists,
 * so we wrap the call in try/catch and swallow the "already exists" error.
 * This makes the init idempotent across server restarts.
 */
export function ensureLeaderboard(nk: nkruntime.Nakama, logger: nkruntime.Logger): void {
  try {
    nk.leaderboardCreate(
      LEADERBOARD_ID,
      // authoritative: only the server can write scores. Clients cannot
      // submit their own scores — that would defeat the entire point of a
      // server-authoritative game.
      true,
      // sortOrder: descending — higher score = better rank. Nakama's
      // SortOrder enum maps DESCENDING => 'descending'.
      "descending" as nkruntime.SortOrder,
      // operator: "best" — keep the highest score ever submitted. We always
      // submit the user's CUMULATIVE score so this effectively just stores
      // the latest value (which is monotonically non-decreasing).
      "best" as nkruntime.Operator,
      // resetSchedule: null = never reset. This is a global all-time
      // leaderboard.
      null,
      // metadata
      { description: "Global Tic-Tac-Toe leaderboard for the Lila assignment" },
    );
    logger.info("Created leaderboard %s", LEADERBOARD_ID);
  } catch (err) {
    // We expect this to fail with "already exists" on second+ runs. Other
    // errors are unusual but non-fatal — log and continue.
    logger.info("Leaderboard %s already exists or could not be created: %s", LEADERBOARD_ID, String(err));
  }
}

/**
 * Read a user's stats record from storage. Returns a zeroed record if none
 * exists yet (first-time player).
 */
function readStats(nk: nkruntime.Nakama, userId: string): StatsRecord {
  const objects = nk.storageRead([
    {
      collection: STATS_COLLECTION,
      key: STATS_KEY,
      userId: userId,
    },
  ]);
  if (objects.length === 0) {
    return { wins: 0, losses: 0, draws: 0, currentStreak: 0, bestStreak: 0, recentResults: [] };
  }
  const value = objects[0].value as StatsRecord;
  // Defensive defaults in case an older version of the record is missing
  // newer fields. Better than crashing the match.
  return {
    wins: value.wins || 0,
    losses: value.losses || 0,
    draws: value.draws || 0,
    currentStreak: value.currentStreak || 0,
    bestStreak: value.bestStreak || 0,
    recentResults: value.recentResults || [],
  };
}

/**
 * Compute the user's score from their stats. Kept as a single function so
 * the formula lives in one place — easy to tweak later.
 */
function computeScore(stats: StatsRecord): number {
  return stats.wins * SCORE_WIN + stats.draws * SCORE_DRAW + stats.losses * SCORE_LOSS;
}

/**
 * Record a single game result for ONE user. Updates storage AND submits to
 * the leaderboard. Idempotent? No — call exactly once per user per game.
 *
 * The match handler calls this for both players when a match ends.
 */
export function recordResult(
  nk: nkruntime.Nakama,
  logger: nkruntime.Logger,
  userId: string,
  username: string,
  outcome: GameOutcome,
): void {
  const stats = readStats(nk, userId);

  if (outcome === "win") {
    stats.wins += 1;
    stats.currentStreak += 1;
    if (stats.currentStreak > stats.bestStreak) {
      stats.bestStreak = stats.currentStreak;
    }
  } else if (outcome === "loss") {
    stats.losses += 1;
    stats.currentStreak = 0; // streak resets on loss
  } else {
    stats.draws += 1;
    stats.currentStreak = 0; // streak resets on draw too — same as most chess sites
  }

  // Maintain a small ring of recent results (most-recent first, max 4).
  // This is purely for debugging via Nakama Console — not surfaced in the UI.
  stats.recentResults = [outcome].concat(stats.recentResults || []).slice(0, 4);

  // Persist stats. We use permissionRead=2 (public) so any authenticated user
  // can read another player's stats — needed for the leaderboard view.
  // permissionWrite=0 means ONLY the server can write — clients cannot tamper.
  nk.storageWrite([
    {
      collection: STATS_COLLECTION,
      key: STATS_KEY,
      userId: userId,
      value: stats,
      permissionRead: 2,
      permissionWrite: 0,
    },
  ]);

  // Submit the updated cumulative score to the leaderboard. We attach the
  // username as metadata so leaderboard listings can show display names
  // without a second round-trip to fetch user records.
  const newScore = computeScore(stats);
  try {
    nk.leaderboardRecordWrite(LEADERBOARD_ID, userId, username, newScore, 0, {
      wins: stats.wins,
      losses: stats.losses,
      draws: stats.draws,
      currentStreak: stats.currentStreak,
      bestStreak: stats.bestStreak,
    });
  } catch (err) {
    logger.error("Failed to write leaderboard record for %s: %s", userId, String(err));
  }

  logger.info(
    "Recorded %s for %s (W:%d L:%d D:%d streak:%d score:%d)",
    outcome, userId, stats.wins, stats.losses, stats.draws, stats.currentStreak, newScore,
  );
}

/**
 * Read the top N entries from the global leaderboard, returning an array of
 * UI-friendly LeaderboardEntry objects.
 */
export function fetchTopEntries(
  nk: nkruntime.Nakama,
  logger: nkruntime.Logger,
  limit: number,
): LeaderboardEntry[] {
  // Clamp the limit to something sane. We don't want a malicious client to
  // ask for the top 1,000,000 records.
  if (limit < 1) limit = 1;
  if (limit > 100) limit = 100;

  let result: nkruntime.LeaderboardRecordList;
  try {
    result = nk.leaderboardRecordsList(LEADERBOARD_ID, undefined, limit, undefined, undefined);
  } catch (err) {
    logger.error("Failed to list leaderboard records: %s", String(err));
    return [];
  }

  const entries: LeaderboardEntry[] = [];
  const records = result.records || [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    // Pull stat fields out of the metadata we wrote at submission time. The
    // leaderboard record itself only has the score; metadata gives us W/L/D.
    const meta = (r.metadata || {}) as { [k: string]: number };
    entries.push({
      userId: r.ownerId,
      username: r.username || "anonymous",
      wins: meta.wins || 0,
      losses: meta.losses || 0,
      draws: meta.draws || 0,
      currentStreak: meta.currentStreak || 0,
      bestStreak: meta.bestStreak || 0,
      score: r.score as unknown as number,
    });
  }
  return entries;
}

/**
 * Fetch a single user's stats. Used by the client when it wants to refresh
 * its own header without re-reading the whole leaderboard.
 */
export function fetchUserStats(
  nk: nkruntime.Nakama,
  userId: string,
  username: string,
): LeaderboardEntry {
  const stats = readStats(nk, userId);
  return {
    userId: userId,
    username: username,
    wins: stats.wins,
    losses: stats.losses,
    draws: stats.draws,
    currentStreak: stats.currentStreak,
    bestStreak: stats.bestStreak,
    score: computeScore(stats),
  };
}
