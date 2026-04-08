// ---------------------------------------------------------------------------
// Nakama runtime entry point.
//
// Nakama's JavaScript runtime looks for a top-level `InitModule` binding and
// calls it once at server startup. We use it to:
//
//   1. Register the Tic-Tac-Toe match handler under a module name so the
//      matchCreate RPC can spawn instances of it.
//   2. Register all client-facing RPCs (matchmaking, leaderboard, healthcheck).
//   3. Ensure the global leaderboard exists.
//
// We follow the canonical Nakama TypeScript pattern:
//   - Use `let InitModule = function(...) { ... }` at the top level.
//   - Add a `!InitModule && InitModule.bind(null)` reference at the bottom
//     so rollup's tree-shaker doesn't drop the binding.
//   - Do NOT use `export` — Nakama's Goja runtime evaluates this file as a
//     script and looks up `InitModule` as a top-level identifier.
// ---------------------------------------------------------------------------
import { ensureLeaderboard } from "./leaderboard";
import { matchHandler } from "./match_handler";
import {
  createPrivateMatchRpc,
  findMatchRpc,
  listOpenMatchesRpc,
  MATCH_MODULE,
} from "./matchmaking";
import { getLeaderboardRpc, getMyStatsRpc, healthcheckRpc } from "./rpcs";

// `let InitModule` becomes a top-level lexical binding in the bundled script,
// which Goja exposes via Runtime.Get("InitModule"). Renaming this variable
// will break Nakama integration — leave it alone.
let InitModule: nkruntime.InitModule = function (
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  initializer: nkruntime.Initializer,
) {
  logger.info("LILA Tic-Tac-Toe runtime initializing...");

  // Register the match handler. The first argument is the module name we
  // pass to nk.matchCreate(...) inside the matchmaking RPC.
  initializer.registerMatch(MATCH_MODULE, matchHandler);
  logger.info("Registered match module: %s", MATCH_MODULE);

  // Register RPCs. Each RPC name becomes the path the client calls via
  // client.rpc("find_match", payload).
  initializer.registerRpc("find_match", findMatchRpc);
  initializer.registerRpc("create_private_match", createPrivateMatchRpc);
  initializer.registerRpc("list_open_matches", listOpenMatchesRpc);
  initializer.registerRpc("get_leaderboard", getLeaderboardRpc);
  initializer.registerRpc("get_my_stats", getMyStatsRpc);
  initializer.registerRpc("healthcheck", healthcheckRpc);
  logger.info("Registered 6 RPCs");

  // Make sure the leaderboard exists. Idempotent — safe to call on every boot.
  ensureLeaderboard(nk, logger);

  logger.info("LILA Tic-Tac-Toe runtime initialized successfully");
};

// Reference InitModule below so the bundler doesn't tree-shake it away. The
// expression is a no-op at runtime (the && short-circuits) but it forces
// rollup to keep the binding alive in the output.
//
// We need @ts-ignore here because TypeScript narrows InitModule to `never`
// after the falsy `!InitModule` check (the function value can never be
// falsy), which makes `.bind` look invalid even though it's reachable code.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
// @ts-ignore — see comment above.
!InitModule && InitModule.bind(null);
