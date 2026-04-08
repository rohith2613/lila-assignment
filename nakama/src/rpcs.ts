// ---------------------------------------------------------------------------
// Miscellaneous client-facing RPCs that don't belong to matchmaking.
//
// Currently:
//   - get_leaderboard       Returns top N players with W/L/D/streak/score.
//   - get_my_stats          Returns the calling user's own stats.
//   - healthcheck           Trivial endpoint for uptime monitoring.
// ---------------------------------------------------------------------------
import { fetchTopEntries, fetchUserStats } from "./leaderboard";

/**
 * RPC: get_leaderboard
 *
 * Request payload (JSON, optional): { "limit": number }
 * Response: { "entries": LeaderboardEntry[] }
 */
export const getLeaderboardRpc: nkruntime.RpcFunction = function (
  ctx,
  logger,
  nk,
  payload,
) {
  let limit = 10;
  if (payload && payload.length > 0) {
    try {
      const obj = JSON.parse(payload);
      if (obj && typeof obj.limit === "number") limit = obj.limit;
    } catch (err) {
      // Ignore — fall back to default.
    }
  }
  const entries = fetchTopEntries(nk, logger, limit);
  return JSON.stringify({ entries: entries });
};

/**
 * RPC: get_my_stats
 *
 * Returns the calling user's stats. No request payload.
 */
export const getMyStatsRpc: nkruntime.RpcFunction = function (ctx, logger, nk, payload) {
  if (!ctx.userId) {
    // Should never happen — Nakama refuses unauth'd RPCs by default — but
    // handle it defensively.
    return JSON.stringify({ error: "unauthenticated" });
  }
  const username = ctx.username || "anonymous";
  const stats = fetchUserStats(nk, ctx.userId, username);
  return JSON.stringify(stats);
};

/**
 * RPC: healthcheck
 *
 * Returns a tiny payload so external monitors / load balancers can hit a
 * known endpoint. Doesn't touch storage or matches.
 */
export const healthcheckRpc: nkruntime.RpcFunction = function (ctx, logger, nk, payload) {
  return JSON.stringify({ ok: true, ts: Date.now() });
};
