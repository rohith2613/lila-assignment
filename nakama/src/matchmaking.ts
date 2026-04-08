// ---------------------------------------------------------------------------
// Matchmaking RPCs.
//
// We expose three RPCs to clients:
//
//   1. find_match
//        Look for an open match in the requested mode. If one exists, return
//        its match id so the client can join. Otherwise create a new one and
//        return THAT id. This is the "automatic matchmaking" path required
//        by the spec.
//
//   2. create_private_match
//        Always create a fresh match without trying to reuse one. Useful for
//        playing with a friend (room discovery via match listing).
//
//   3. list_open_matches
//        Return a list of currently joinable matches in a given mode, so the
//        client can offer "browse rooms" UX.
//
// Why RPCs (and not Nakama's built-in matchmaker)?
//   Nakama has a powerful generic matchmaker, but it's optimized for skill-
//   based matching with multiple criteria. For a 2-player Tic-Tac-Toe game we
//   just need "find any open room of mode X", which is easier to express via
//   match listing + a tiny RPC. The RPC also gives us a clean API for the
//   client and lets us atomically create-or-join.
// ---------------------------------------------------------------------------
import { MatchMode } from "./types";

/** The Nakama module name we register the match handler under (see main.ts). */
export const MATCH_MODULE = "lila_tictactoe";

/**
 * Parse / validate the mode field from an RPC payload. Defaults to "classic"
 * if missing or invalid.
 */
function parseMode(payload: string | undefined): MatchMode {
  if (!payload || payload.length === 0) return "classic";
  try {
    const obj = JSON.parse(payload);
    return obj && obj.mode === "timed" ? "timed" : "classic";
  } catch (err) {
    return "classic";
  }
}

/**
 * RPC: find_match
 *
 * Request payload (JSON string): { "mode": "classic" | "timed" }
 * Response payload (JSON string): { "matchId": "..." }
 *
 * Algorithm:
 *   1. List up to 10 open matches in the requested mode (label.open == 1).
 *   2. Iterate the results and pick the first one that still has a free slot.
 *   3. If none found, create a new match and return its id.
 *
 * Race-condition note: between listing and joining, another player might
 * grab the slot. The client always handles a join failure by retrying
 * `find_match`, so the worst case is one extra round-trip — never a wedged
 * client.
 */
export const findMatchRpc: nkruntime.RpcFunction = function (ctx, logger, nk, payload) {
  const mode = parseMode(payload);
  logger.info("find_match: mode=%s user=%s", mode, ctx.userId);

  // Build a label query that matches "open" rooms in the desired mode.
  // Nakama supports a Bleve query DSL on match labels — `+field:value`.
  const query = "+label.mode:" + mode + " +label.open:1";
  const minSize = 1; // at least 1 player already inside
  const maxSize = 1; // exactly 1 — i.e., one slot free
  const limit = 10;
  // authoritative=true so we only consider matches running our handler.
  const matches = nk.matchList(limit, true, "", minSize, maxSize, query);

  if (matches && matches.length > 0) {
    // Pick the first match. The list is unordered but stable enough for our
    // purposes; we don't need fancy ranking.
    const m = matches[0];
    logger.info("find_match: reusing existing match %s", m.matchId);
    return JSON.stringify({ matchId: m.matchId });
  }

  // No open match — create one.
  const matchId = nk.matchCreate(MATCH_MODULE, { mode: mode });
  logger.info("find_match: created new match %s", matchId);
  return JSON.stringify({ matchId: matchId });
};

/**
 * RPC: create_private_match
 *
 * Always creates a brand new match. Returns the match id so the creator can
 * join immediately, then share the id with a friend who joins via the same
 * id (room code).
 */
export const createPrivateMatchRpc: nkruntime.RpcFunction = function (
  ctx,
  logger,
  nk,
  payload,
) {
  const mode = parseMode(payload);
  const matchId = nk.matchCreate(MATCH_MODULE, { mode: mode });
  logger.info("create_private_match: %s mode=%s", matchId, mode);
  return JSON.stringify({ matchId: matchId });
};

/**
 * RPC: list_open_matches
 *
 * Return up to 20 currently-joinable matches in the requested mode. Used by
 * any "browse rooms" UI.
 */
export const listOpenMatchesRpc: nkruntime.RpcFunction = function (
  ctx,
  logger,
  nk,
  payload,
) {
  const mode = parseMode(payload);
  const query = "+label.mode:" + mode + " +label.open:1";
  const matches = nk.matchList(20, true, "", 1, 1, query) || [];
  const out: { matchId: string; label: string; size: number }[] = [];
  for (let i = 0; i < matches.length; i++) {
    out.push({ matchId: matches[i].matchId, label: matches[i].label, size: matches[i].size });
  }
  return JSON.stringify({ matches: out });
};
