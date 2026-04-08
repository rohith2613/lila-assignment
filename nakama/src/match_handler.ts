// ---------------------------------------------------------------------------
// Tic-Tac-Toe match handler — the heart of the server-authoritative game.
//
// Nakama's authoritative-match feature lets us implement a custom match
// runtime by providing 7 lifecycle hooks. Nakama spawns one instance of this
// handler per match, runs `matchInit` once, then ticks `matchLoop` at a fixed
// rate. Player joins/leaves go through `matchJoinAttempt`/`matchJoin`/
// `matchLeave`. Inbound network messages from clients arrive in `matchLoop`
// as the `messages` argument.
//
// This file is intentionally heavy on comments — we want a reviewer to be
// able to follow the lifecycle without already knowing Nakama internals.
// ---------------------------------------------------------------------------
import {
  applyMove,
  createEmptyBoard,
  evaluateBoard,
  nextTurn,
  validateMove,
} from "./game_logic";
import { recordResult } from "./leaderboard";
import {
  EndReason,
  Mark,
  MatchMode,
  MatchState,
  MoveMessage,
  OpCode,
  PlayerState,
  StateUpdatePayload,
} from "./types";

// ---- Tunables --------------------------------------------------------------

/** Match tick rate. 5 Hz is plenty for a turn-based game and minimizes CPU. */
const TICK_RATE = 5;

/** Default per-turn timeout in seconds for timed mode. */
const DEFAULT_TURN_TIMEOUT = 30;

/**
 * If a match has zero players for this many ticks after init, terminate it.
 * 60 seconds gives the matchmaker plenty of time to wire up the second player.
 */
const EMPTY_MATCH_TIMEOUT_TICKS = TICK_RATE * 60;

/**
 * Once a game has ended, keep the match alive for this long so clients can
 * read the final state and the "Play Again" UX has time to render. After this
 * the match terminates and frees its slot.
 */
const POST_GAME_LINGER_TICKS = TICK_RATE * 10;

// ---- Helpers ---------------------------------------------------------------

/**
 * Convert internal MatchState into the smaller payload we send to clients.
 * We strip server-only fields (lastBroadcastTick, emptyTicksRemaining, etc.)
 * and turn `players` from a map into an array — JSON-friendly and easier to
 * iterate in React.
 */
function toStatePayload(state: MatchState): StateUpdatePayload {
  // Compute remaining seconds on the current turn for timed mode. Doing this
  // here (instead of on the client) keeps the server as the single source of
  // truth — clients only render what we tell them.
  let remaining = 0;
  if (state.mode === "timed" && state.phase === "playing") {
    // We can't read the current tick from inside this function, so the
    // caller (matchLoop) sets `turnSecondsRemaining` separately. We pass 0
    // here as a default; the caller overwrites it.
    remaining = 0;
  }

  // Build players array preserving join order. Order matters for the UI:
  // Player 1 is always X and shown first.
  const playersArray: PlayerState[] = [];
  for (let i = 0; i < state.playerOrder.length; i++) {
    const p = state.players[state.playerOrder[i]];
    if (p) playersArray.push(p);
  }

  return {
    mode: state.mode,
    board: state.board,
    phase: state.phase,
    turn: state.turn,
    players: playersArray,
    endReason: state.endReason,
    winnerUserId: state.winnerUserId,
    winningLine: state.winningLine,
    turnSecondsRemaining: remaining,
    turnTimeoutSeconds: state.turnTimeoutSeconds,
  };
}

/**
 * Compute remaining seconds on the current turn given the current tick.
 * Pure helper so it can be unit-tested.
 */
function computeTurnSecondsRemaining(state: MatchState, currentTick: number): number {
  if (state.mode !== "timed" || state.phase !== "playing") return 0;
  const elapsedTicks = currentTick - state.turnStartedAtTick;
  const elapsedSeconds = Math.floor(elapsedTicks / state.tickRate);
  const remaining = state.turnTimeoutSeconds - elapsedSeconds;
  return remaining > 0 ? remaining : 0;
}

/**
 * Broadcast the full state to every connected player. Called whenever the
 * state changes (move, join, leave, game end) and once per second in timed
 * mode so the timer stays in sync.
 */
function broadcastState(
  dispatcher: nkruntime.MatchDispatcher,
  state: MatchState,
  currentTick: number,
): void {
  const payload = toStatePayload(state);
  payload.turnSecondsRemaining = computeTurnSecondsRemaining(state, currentTick);
  // sendBroadcast: opcode, data, presences=null (all), sender=null, reliable=true
  dispatcher.broadcastMessage(OpCode.STATE_UPDATE, JSON.stringify(payload), null, null, true);
  state.lastBroadcastTick = currentTick;
}

/**
 * Send an error message to a single sender. Used when we reject a move.
 */
function sendErrorTo(
  dispatcher: nkruntime.MatchDispatcher,
  presence: nkruntime.Presence,
  message: string,
): void {
  const payload = JSON.stringify({ error: message });
  dispatcher.broadcastMessage(OpCode.ERROR, payload, [presence], null, true);
}

/**
 * Mark the game as ended for the given reason and persist results to the
 * leaderboard. Centralized so we don't forget any of the bookkeeping.
 */
function endGame(
  nk: nkruntime.Nakama,
  logger: nkruntime.Logger,
  state: MatchState,
  reason: EndReason,
  winnerMark: Mark | null,
  winningLine: number[] | null,
): void {
  state.phase = "ended";
  state.endReason = reason;
  state.winningLine = winningLine;

  // Resolve winner mark to user id (if any).
  let winnerUserId: string | null = null;
  if (winnerMark !== null) {
    for (let i = 0; i < state.playerOrder.length; i++) {
      const uid = state.playerOrder[i];
      if (state.players[uid].mark === winnerMark) {
        winnerUserId = uid;
        break;
      }
    }
  }
  state.winnerUserId = winnerUserId;

  // Persist outcomes to the leaderboard. Only do this if both players were
  // actually present at some point — otherwise (e.g. an empty match that
  // just timed out) we have nothing meaningful to record.
  if (state.playerOrder.length === 2) {
    for (let i = 0; i < state.playerOrder.length; i++) {
      const uid = state.playerOrder[i];
      const p = state.players[uid];
      let outcome: "win" | "loss" | "draw";
      if (reason === "draw") {
        outcome = "draw";
      } else if (winnerUserId === uid) {
        outcome = "win";
      } else {
        outcome = "loss";
      }
      try {
        recordResult(nk, logger, uid, p.username, outcome);
      } catch (err) {
        logger.error("Failed to record result for %s: %s", uid, String(err));
      }
    }
  }

  logger.info(
    "Game ended. reason=%s winner=%s",
    reason || "null",
    winnerUserId || "none",
  );
}

// ---- Lifecycle hooks -------------------------------------------------------

/**
 * matchInit — called once when Nakama creates a new match instance.
 *
 * The `params` argument receives whatever the caller passed to
 * `nk.matchCreate(...)`. We use it to receive the chosen mode (classic/timed)
 * and the initial player metadata so the match knows who to expect.
 */
const matchInit: nkruntime.MatchInitFunction<MatchState> = function (
  ctx,
  logger,
  nk,
  params,
) {
  const mode: MatchMode = (params.mode as MatchMode) === "timed" ? "timed" : "classic";

  const state: MatchState = {
    mode: mode,
    board: createEmptyBoard(),
    phase: "waiting",
    turn: "X",
    players: {},
    playerOrder: [],
    endReason: null,
    winnerUserId: null,
    winningLine: null,
    turnStartedAtTick: 0,
    turnTimeoutSeconds: DEFAULT_TURN_TIMEOUT,
    tickRate: TICK_RATE,
    lastBroadcastTick: 0,
    emptyTicksRemaining: EMPTY_MATCH_TIMEOUT_TICKS,
  };

  logger.info("matchInit: created %s match", mode);
  return {
    state: state,
    tickRate: TICK_RATE,
    // Match label is searchable via Nakama's match listing API. We embed
    // mode + a phase marker so the matchmaker can find joinable matches by
    // mode and skip ones that are already in progress.
    label: JSON.stringify({ mode: mode, phase: "waiting", open: 1 }),
  };
};

/**
 * matchJoinAttempt — called when a client requests to join the match.
 *
 * We accept the join if:
 *   - The match is still in the "waiting" phase (we don't allow spectators).
 *   - There are fewer than 2 players already.
 *   - The user isn't already in the match (defensive — Nakama usually
 *     prevents this but a reconnect after disconnect can race).
 *
 * Returning {state, accept: true} accepts. Returning accept: false rejects
 * with an optional reason string the client can read.
 */
const matchJoinAttempt: nkruntime.MatchJoinAttemptFunction<MatchState> = function (
  ctx,
  logger,
  nk,
  dispatcher,
  tick,
  state,
  presence,
  metadata,
) {
  // Already in the match? Allow re-join (treat as reconnect).
  if (state.players[presence.userId]) {
    state.players[presence.userId].connected = true;
    return { state: state, accept: true };
  }

  // Match full?
  if (state.playerOrder.length >= 2) {
    return { state: state, accept: false, rejectMessage: "match is full" };
  }

  // Not in waiting phase? Reject — late joiners aren't supported.
  if (state.phase !== "waiting") {
    return { state: state, accept: false, rejectMessage: "match already in progress" };
  }

  return { state: state, accept: true };
};

/**
 * matchJoin — called after matchJoinAttempt accepts. Now the player is
 * actually IN the match presence list and we can set up their game state.
 */
const matchJoin: nkruntime.MatchJoinFunction<MatchState> = function (
  ctx,
  logger,
  nk,
  dispatcher,
  tick,
  state,
  presences,
) {
  for (let i = 0; i < presences.length; i++) {
    const p = presences[i];
    if (state.players[p.userId]) {
      // Reconnect path — they're already known. Just mark connected and
      // move on.
      state.players[p.userId].connected = true;
      continue;
    }
    // Assign mark by join order: first player is X, second is O.
    const mark: Mark = state.playerOrder.length === 0 ? "X" : "O";
    state.players[p.userId] = {
      userId: p.userId,
      username: p.username,
      mark: mark,
      connected: true,
    };
    state.playerOrder.push(p.userId);
    logger.info("Player %s (%s) joined as %s", p.username, p.userId, mark);
  }

  // If we now have 2 players, transition to playing.
  if (state.phase === "waiting" && state.playerOrder.length === 2) {
    state.phase = "playing";
    state.turn = "X";
    state.turnStartedAtTick = tick;
    // Update label so the matchmaker won't list this match as joinable.
    dispatcher.matchLabelUpdate(JSON.stringify({ mode: state.mode, phase: "playing", open: 0 }));
    logger.info("Match has 2 players, starting game");
  }

  // Always broadcast after a join so the new player gets the current state
  // and the existing player sees the opponent appear.
  broadcastState(dispatcher, state, tick);

  return { state: state };
};

/**
 * matchLeave — called when a player disconnects or explicitly leaves.
 *
 * Behavior:
 *   - In "waiting" phase: just remove them. The match will eventually time
 *     out via the empty-match timer if nobody else joins.
 *   - In "playing" phase: forfeit the game. The remaining player wins.
 *   - In "ended" phase: nothing to do — game already over.
 */
const matchLeave: nkruntime.MatchLeaveFunction<MatchState> = function (
  ctx,
  logger,
  nk,
  dispatcher,
  tick,
  state,
  presences,
) {
  for (let i = 0; i < presences.length; i++) {
    const p = presences[i];
    const player = state.players[p.userId];
    if (!player) continue;
    player.connected = false;
    logger.info("Player %s (%s) left", player.username, p.userId);

    if (state.phase === "playing") {
      // Forfeit: the OTHER player wins.
      const otherUid = state.playerOrder[0] === p.userId ? state.playerOrder[1] : state.playerOrder[0];
      const otherMark = state.players[otherUid] ? state.players[otherUid].mark : null;
      endGame(nk, logger, state, "forfeit", otherMark, null);
      broadcastState(dispatcher, state, tick);
    } else if (state.phase === "waiting") {
      // Remove from order. They never started a game so no leaderboard hit.
      const idx = state.playerOrder.indexOf(p.userId);
      if (idx >= 0) state.playerOrder.splice(idx, 1);
      delete state.players[p.userId];
      broadcastState(dispatcher, state, tick);
    }
  }

  return { state: state };
};

/**
 * matchLoop — called every tick (TICK_RATE per second).
 *
 * Responsibilities:
 *   1. Process inbound messages (moves, leaves).
 *   2. Enforce the per-turn timer in timed mode.
 *   3. Tear down empty matches that never got a second player.
 *   4. Tear down ended matches after their linger period.
 *   5. Broadcast periodic timer updates in timed mode.
 *
 * Returning `null` here tells Nakama to terminate the match.
 */
const matchLoop: nkruntime.MatchLoopFunction<MatchState> = function (
  ctx,
  logger,
  nk,
  dispatcher,
  tick,
  state,
  messages,
) {
  // -- 1. Process inbound messages -----------------------------------------
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const sender = msg.sender;

    // Decode payload as JSON. Goja's JSON.parse throws on bad input — wrap
    // it in try/catch so a malformed client message can't crash the match.
    let parsed: any = null;
    try {
      parsed = JSON.parse(nk.binaryToString(msg.data));
    } catch (err) {
      sendErrorTo(dispatcher, sender, "invalid JSON payload");
      continue;
    }

    if (msg.opCode === OpCode.MOVE) {
      handleMove(nk, logger, dispatcher, tick, state, sender, parsed as MoveMessage);
    } else if (msg.opCode === OpCode.LEAVE) {
      // Treat as forfeit while playing.
      if (state.phase === "playing") {
        const otherUid = state.playerOrder[0] === sender.userId ? state.playerOrder[1] : state.playerOrder[0];
        const otherMark = state.players[otherUid] ? state.players[otherUid].mark : null;
        endGame(nk, logger, state, "forfeit", otherMark, null);
        broadcastState(dispatcher, state, tick);
      }
    } else {
      // Unknown opcode — log and ignore. Don't echo to sender; that could
      // be used as an amplification vector by a malicious client.
      logger.warn("Unknown opcode %d from %s", msg.opCode, sender.userId);
    }
  }

  // -- 2. Empty-match cleanup ----------------------------------------------
  // If nobody is in the match, decrement the timer and tear down on zero.
  if (state.playerOrder.length === 0) {
    state.emptyTicksRemaining -= 1;
    if (state.emptyTicksRemaining <= 0) {
      logger.info("Terminating empty match");
      return null;
    }
    return { state: state };
  } else {
    // Reset the empty timer whenever someone is present.
    state.emptyTicksRemaining = EMPTY_MATCH_TIMEOUT_TICKS;
  }

  // -- 3. Per-turn timeout (timed mode only) -------------------------------
  if (state.mode === "timed" && state.phase === "playing") {
    const remaining = computeTurnSecondsRemaining(state, tick);
    if (remaining <= 0) {
      // Whoever's turn it is loses by timeout.
      const losingMark = state.turn;
      const winningMark: Mark = nextTurn(losingMark);
      logger.info("Turn timeout — %s loses", losingMark);
      endGame(nk, logger, state, "timeout", winningMark, null);
      broadcastState(dispatcher, state, tick);
    } else {
      // Re-broadcast roughly once a second so client timers stay in sync.
      // This is throttled by `lastBroadcastTick` to avoid spamming the wire.
      const ticksSinceLast = tick - state.lastBroadcastTick;
      if (ticksSinceLast >= state.tickRate) {
        broadcastState(dispatcher, state, tick);
      }
    }
  }

  // -- 4. Post-game linger -------------------------------------------------
  // Once the game has ended, hold the match open for POST_GAME_LINGER_TICKS
  // so the client has time to render the result screen and decide what to
  // do next. After the timer expires we terminate by returning null.
  if (state.phase === "ended") {
    if (typeof state.lingerTicksRemaining === "undefined") {
      state.lingerTicksRemaining = POST_GAME_LINGER_TICKS;
    }
    state.lingerTicksRemaining -= 1;
    if (state.lingerTicksRemaining <= 0) {
      logger.info("Linger period over, terminating ended match");
      return null;
    }
  }

  return { state: state };
};

/**
 * Process a single MOVE message from a client. Validates the move, applies
 * it, evaluates the board, and either advances the turn or ends the game.
 */
function handleMove(
  nk: nkruntime.Nakama,
  logger: nkruntime.Logger,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: MatchState,
  sender: nkruntime.Presence,
  msg: MoveMessage,
): void {
  if (state.phase !== "playing") {
    sendErrorTo(dispatcher, sender, "match is not in playing phase");
    return;
  }

  const player = state.players[sender.userId];
  if (!player) {
    sendErrorTo(dispatcher, sender, "you are not in this match");
    return;
  }

  const error = validateMove(state.board, msg.cell, player.mark, state.turn);
  if (error !== null) {
    sendErrorTo(dispatcher, sender, error);
    return;
  }

  // Apply the move authoritatively.
  applyMove(state.board, msg.cell, player.mark);

  // Check for game-end conditions.
  const evalResult = evaluateBoard(state.board);
  if (evalResult.winner !== null) {
    endGame(nk, logger, state, "win", evalResult.winner, evalResult.line);
  } else if (evalResult.draw) {
    endGame(nk, logger, state, "draw", null, null);
  } else {
    // No end yet — pass the turn to the other player and reset the per-turn
    // timer (in timed mode).
    state.turn = nextTurn(state.turn);
    state.turnStartedAtTick = tick;
  }

  broadcastState(dispatcher, state, tick);
}

/**
 * matchTerminate — called when the server is shutting down or the match is
 * being forcibly evicted (rare). We try to flush a final state broadcast so
 * clients can show a graceful "server restarting" message.
 */
const matchTerminate: nkruntime.MatchTerminateFunction<MatchState> = function (
  ctx,
  logger,
  nk,
  dispatcher,
  tick,
  state,
  graceSeconds,
) {
  logger.info("matchTerminate called, grace=%d", graceSeconds);
  if (state.phase !== "ended") {
    state.phase = "ended";
    state.endReason = "forfeit";
  }
  broadcastState(dispatcher, state, tick);
  return { state: state };
};

/**
 * matchSignal — called when external code calls `nk.matchSignal(matchId, ...)`.
 * We don't currently use signals but the hook is required by the interface.
 */
const matchSignal: nkruntime.MatchSignalFunction<MatchState> = function (
  ctx,
  logger,
  nk,
  dispatcher,
  tick,
  state,
  data,
) {
  return { state: state };
};

/**
 * The Nakama runtime expects an object with these exact property names. We
 * export it as a single bundle so `main.ts` can register it under a chosen
 * module name.
 */
export const matchHandler: nkruntime.MatchHandler<MatchState> = {
  matchInit: matchInit,
  matchJoinAttempt: matchJoinAttempt,
  matchJoin: matchJoin,
  matchLeave: matchLeave,
  matchLoop: matchLoop,
  matchTerminate: matchTerminate,
  matchSignal: matchSignal,
};
