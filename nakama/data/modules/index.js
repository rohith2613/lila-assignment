'use strict';

/** Collection name for our per-user stats storage objects. */
var STATS_COLLECTION = "stats";
/** Key inside that collection. We only keep one stats record per user. */
var STATS_KEY = "tictactoe";
/** Id of the global leaderboard we create at module init time. */
var LEADERBOARD_ID = "global_tictactoe";
/** Score awarded for a win, loss, draw. */
var SCORE_WIN = 100;
var SCORE_DRAW = 25;
var SCORE_LOSS = 0;
/**
 * Ensure the global leaderboard exists. Called once at runtime init.
 *
 * Nakama will throw if you try to create a leaderboard that already exists,
 * so we wrap the call in try/catch and swallow the "already exists" error.
 * This makes the init idempotent across server restarts.
 */
function ensureLeaderboard(nk, logger) {
    try {
        nk.leaderboardCreate(LEADERBOARD_ID, 
        // authoritative: only the server can write scores. Clients cannot
        // submit their own scores — that would defeat the entire point of a
        // server-authoritative game.
        true, 
        // sortOrder: descending — higher score = better rank. Nakama's
        // SortOrder enum maps DESCENDING => 'descending'.
        "descending", 
        // operator: "best" — keep the highest score ever submitted. We always
        // submit the user's CUMULATIVE score so this effectively just stores
        // the latest value (which is monotonically non-decreasing).
        "best", 
        // resetSchedule: null = never reset. This is a global all-time
        // leaderboard.
        null, 
        // metadata
        { description: "Global Tic-Tac-Toe leaderboard for the Lila assignment" });
        logger.info("Created leaderboard %s", LEADERBOARD_ID);
    }
    catch (err) {
        // We expect this to fail with "already exists" on second+ runs. Other
        // errors are unusual but non-fatal — log and continue.
        logger.info("Leaderboard %s already exists or could not be created: %s", LEADERBOARD_ID, String(err));
    }
}
/**
 * Read a user's stats record from storage. Returns a zeroed record if none
 * exists yet (first-time player).
 */
function readStats(nk, userId) {
    var objects = nk.storageRead([
        {
            collection: STATS_COLLECTION,
            key: STATS_KEY,
            userId: userId,
        },
    ]);
    if (objects.length === 0) {
        return { wins: 0, losses: 0, draws: 0, currentStreak: 0, bestStreak: 0, recentResults: [] };
    }
    var value = objects[0].value;
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
function computeScore(stats) {
    return stats.wins * SCORE_WIN + stats.draws * SCORE_DRAW + stats.losses * SCORE_LOSS;
}
/**
 * Record a single game result for ONE user. Updates storage AND submits to
 * the leaderboard. Idempotent? No — call exactly once per user per game.
 *
 * The match handler calls this for both players when a match ends.
 */
function recordResult(nk, logger, userId, username, outcome) {
    var stats = readStats(nk, userId);
    if (outcome === "win") {
        stats.wins += 1;
        stats.currentStreak += 1;
        if (stats.currentStreak > stats.bestStreak) {
            stats.bestStreak = stats.currentStreak;
        }
    }
    else if (outcome === "loss") {
        stats.losses += 1;
        stats.currentStreak = 0; // streak resets on loss
    }
    else {
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
    var newScore = computeScore(stats);
    try {
        nk.leaderboardRecordWrite(LEADERBOARD_ID, userId, username, newScore, 0, {
            wins: stats.wins,
            losses: stats.losses,
            draws: stats.draws,
            currentStreak: stats.currentStreak,
            bestStreak: stats.bestStreak,
        });
    }
    catch (err) {
        logger.error("Failed to write leaderboard record for %s: %s", userId, String(err));
    }
    logger.info("Recorded %s for %s (W:%d L:%d D:%d streak:%d score:%d)", outcome, userId, stats.wins, stats.losses, stats.draws, stats.currentStreak, newScore);
}
/**
 * Read the top N entries from the global leaderboard, returning an array of
 * UI-friendly LeaderboardEntry objects.
 */
function fetchTopEntries(nk, logger, limit) {
    // Clamp the limit to something sane. We don't want a malicious client to
    // ask for the top 1,000,000 records.
    if (limit < 1)
        limit = 1;
    if (limit > 100)
        limit = 100;
    var result;
    try {
        result = nk.leaderboardRecordsList(LEADERBOARD_ID, undefined, limit, undefined, undefined);
    }
    catch (err) {
        logger.error("Failed to list leaderboard records: %s", String(err));
        return [];
    }
    var entries = [];
    var records = result.records || [];
    for (var i = 0; i < records.length; i++) {
        var r = records[i];
        // Pull stat fields out of the metadata we wrote at submission time. The
        // leaderboard record itself only has the score; metadata gives us W/L/D.
        var meta = (r.metadata || {});
        entries.push({
            userId: r.ownerId,
            username: r.username || "anonymous",
            wins: meta.wins || 0,
            losses: meta.losses || 0,
            draws: meta.draws || 0,
            currentStreak: meta.currentStreak || 0,
            bestStreak: meta.bestStreak || 0,
            score: r.score,
        });
    }
    return entries;
}
/**
 * Fetch a single user's stats. Used by the client when it wants to refresh
 * its own header without re-reading the whole leaderboard.
 */
function fetchUserStats(nk, userId, username) {
    var stats = readStats(nk, userId);
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

/**
 * The eight winning lines of a 3x3 Tic-Tac-Toe board, expressed as flat
 * indices into a 9-element board array. Three rows, three columns, two
 * diagonals.
 */
var WINNING_LINES = [
    // Rows
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    // Columns
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    // Diagonals
    [0, 4, 8],
    [2, 4, 6],
];
/**
 * Create a fresh empty board.
 *
 * Goja note: we use a plain `for` loop instead of Array.fill() because some
 * older Goja builds had quirks with Array.fill on typed arrays. A loop is
 * trivially correct and portable.
 */
function createEmptyBoard() {
    var board = [];
    for (var i = 0; i < 9; i++) {
        board.push(null);
    }
    return board;
}
/**
 * Validate a proposed move BEFORE applying it. Returns null if the move is
 * legal, or a human-readable error string if not. The caller (the match
 * handler) is responsible for sending the error back to the client.
 *
 * Rules enforced:
 *   1. Cell index must be an integer in [0, 8].
 *   2. The cell must currently be empty.
 *   3. It must be the player's turn (caller passes their mark).
 *   4. The expected current-turn mark must match the player's mark.
 *
 * Note: we do NOT check that the game is in the playing phase here — the
 * match handler does that check before calling us, because phase is part of
 * MatchState which we keep out of this module.
 */
function validateMove(board, cell, playerMark, currentTurn) {
    // Coerce / range-check the cell index. We have to be defensive because the
    // input is decoded from JSON and could be anything a client sends us.
    if (typeof cell !== "number" || !isFinite(cell)) {
        return "cell must be a number";
    }
    // Make sure it is an integer (not 1.5 etc.).
    if (Math.floor(cell) !== cell) {
        return "cell must be an integer";
    }
    if (cell < 0 || cell > 8) {
        return "cell must be between 0 and 8";
    }
    if (playerMark !== currentTurn) {
        return "not your turn";
    }
    if (board[cell] !== null) {
        return "cell is already occupied";
    }
    return null;
}
/**
 * Apply a validated move to the board, mutating it in place AND returning it
 * for convenience. Mutating in place keeps the match handler's state object
 * stable across ticks (we never reassign `state.board`).
 *
 * IMPORTANT: This must only be called after `validateMove` returns null.
 */
function applyMove(board, cell, mark) {
    board[cell] = mark;
    return board;
}
/**
 * Check the board for a winning line or a draw.
 *
 * Implementation: walk the 8 winning lines, check if all three cells share
 * the same non-null mark. If none match, count empty cells; zero empty cells
 * means a draw.
 */
function evaluateBoard(board) {
    for (var i = 0; i < WINNING_LINES.length; i++) {
        var line = WINNING_LINES[i];
        var a = board[line[0]];
        var b = board[line[1]];
        var c = board[line[2]];
        if (a !== null && a === b && a === c) {
            return { winner: a, line: line, draw: false };
        }
    }
    // No winner — see if any cell is still empty. If not, it's a draw.
    for (var i = 0; i < board.length; i++) {
        if (board[i] === null) {
            return { winner: null, line: null, draw: false };
        }
    }
    return { winner: null, line: null, draw: true };
}
/**
 * Toggle whose turn it is. Trivial helper but exported so the match handler
 * doesn't repeat the ternary in multiple places.
 */
function nextTurn(current) {
    return current === "X" ? "O" : "X";
}

// ---------------------------------------------------------------------------
// Shared type definitions for the Tic-Tac-Toe match handler.
//
// These types describe the on-server game state, the messages exchanged with
// clients, and the leaderboard records. Keeping them in one place makes it
// easy to keep client and server in sync — the React frontend mirrors these
// shapes in its own types.ts file.
// ---------------------------------------------------------------------------
/**
 * Op-codes used on the wire between client and server. Using small integers
 * keeps payloads compact, and they double as an enum on the client side.
 *
 * Implemented as a frozen const object rather than a `const enum` because
 * `const enum` requires `isolatedModules: false`, which conflicts with how
 * rollup-plugin-typescript compiles individual files.
 */
var OpCode = {
    /** Server → client: full state snapshot. */
    STATE_UPDATE: 1,
    /** Client → server: player wants to place a mark at a given index. */
    MOVE: 2,
    /** Client → server: explicit request to leave/forfeit. */
    LEAVE: 5,
    /** Server → client: an error in response to a client message. */
    ERROR: 6,
};

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
// ---- Tunables --------------------------------------------------------------
/** Match tick rate. 5 Hz is plenty for a turn-based game and minimizes CPU. */
var TICK_RATE = 5;
/** Default per-turn timeout in seconds for timed mode. */
var DEFAULT_TURN_TIMEOUT = 30;
/**
 * If a match has zero players for this many ticks after init, terminate it.
 * 60 seconds gives the matchmaker plenty of time to wire up the second player.
 */
var EMPTY_MATCH_TIMEOUT_TICKS = TICK_RATE * 60;
/**
 * Once a game has ended, keep the match alive for this long so clients can
 * read the final state and the "Play Again" UX has time to render. After this
 * the match terminates and frees its slot.
 */
var POST_GAME_LINGER_TICKS = TICK_RATE * 10;
// ---- Helpers ---------------------------------------------------------------
/**
 * Convert internal MatchState into the smaller payload we send to clients.
 * We strip server-only fields (lastBroadcastTick, emptyTicksRemaining, etc.)
 * and turn `players` from a map into an array — JSON-friendly and easier to
 * iterate in React.
 */
function toStatePayload(state) {
    // Compute remaining seconds on the current turn for timed mode. Doing this
    // here (instead of on the client) keeps the server as the single source of
    // truth — clients only render what we tell them.
    var remaining = 0;
    if (state.mode === "timed" && state.phase === "playing") {
        // We can't read the current tick from inside this function, so the
        // caller (matchLoop) sets `turnSecondsRemaining` separately. We pass 0
        // here as a default; the caller overwrites it.
        remaining = 0;
    }
    // Build players array preserving join order. Order matters for the UI:
    // Player 1 is always X and shown first.
    var playersArray = [];
    for (var i = 0; i < state.playerOrder.length; i++) {
        var p = state.players[state.playerOrder[i]];
        if (p)
            playersArray.push(p);
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
function computeTurnSecondsRemaining(state, currentTick) {
    if (state.mode !== "timed" || state.phase !== "playing")
        return 0;
    var elapsedTicks = currentTick - state.turnStartedAtTick;
    var elapsedSeconds = Math.floor(elapsedTicks / state.tickRate);
    var remaining = state.turnTimeoutSeconds - elapsedSeconds;
    return remaining > 0 ? remaining : 0;
}
/**
 * Broadcast the full state to every connected player. Called whenever the
 * state changes (move, join, leave, game end) and once per second in timed
 * mode so the timer stays in sync.
 */
function broadcastState(dispatcher, state, currentTick) {
    var payload = toStatePayload(state);
    payload.turnSecondsRemaining = computeTurnSecondsRemaining(state, currentTick);
    // sendBroadcast: opcode, data, presences=null (all), sender=null, reliable=true
    dispatcher.broadcastMessage(OpCode.STATE_UPDATE, JSON.stringify(payload), null, null, true);
    state.lastBroadcastTick = currentTick;
}
/**
 * Send an error message to a single sender. Used when we reject a move.
 */
function sendErrorTo(dispatcher, presence, message) {
    var payload = JSON.stringify({ error: message });
    dispatcher.broadcastMessage(OpCode.ERROR, payload, [presence], null, true);
}
/**
 * Mark the game as ended for the given reason and persist results to the
 * leaderboard. Centralized so we don't forget any of the bookkeeping.
 */
function endGame(nk, logger, state, reason, winnerMark, winningLine) {
    state.phase = "ended";
    state.endReason = reason;
    state.winningLine = winningLine;
    // Resolve winner mark to user id (if any).
    var winnerUserId = null;
    if (winnerMark !== null) {
        for (var i = 0; i < state.playerOrder.length; i++) {
            var uid = state.playerOrder[i];
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
        for (var i = 0; i < state.playerOrder.length; i++) {
            var uid = state.playerOrder[i];
            var p = state.players[uid];
            var outcome = void 0;
            if (reason === "draw") {
                outcome = "draw";
            }
            else if (winnerUserId === uid) {
                outcome = "win";
            }
            else {
                outcome = "loss";
            }
            try {
                recordResult(nk, logger, uid, p.username, outcome);
            }
            catch (err) {
                logger.error("Failed to record result for %s: %s", uid, String(err));
            }
        }
    }
    logger.info("Game ended. reason=%s winner=%s", reason || "null", winnerUserId || "none");
}
// ---- Lifecycle hooks -------------------------------------------------------
/**
 * matchInit — called once when Nakama creates a new match instance.
 *
 * The `params` argument receives whatever the caller passed to
 * `nk.matchCreate(...)`. We use it to receive the chosen mode (classic/timed)
 * and the initial player metadata so the match knows who to expect.
 */
var matchInit = function (ctx, logger, nk, params) {
    var mode = params.mode === "timed" ? "timed" : "classic";
    var state = {
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
var matchJoinAttempt = function (ctx, logger, nk, dispatcher, tick, state, presence, metadata) {
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
 *
 * For each new player we look up their CURRENT username via `nk.usersGetId`
 * instead of trusting `presence.username`. The presence value reflects the
 * username at the time the WebSocket session was authenticated; if the
 * client called `updateAccount` to change their nickname AFTER auth (which
 * our flow does, to handle username conflicts), the presence cache is stale
 * but the user account record is fresh.
 */
var matchJoin = function (ctx, logger, nk, dispatcher, tick, state, presences) {
    // Resolve all the new joiners' user accounts in one batched call.
    var newJoinIds = [];
    for (var i = 0; i < presences.length; i++) {
        if (!state.players[presences[i].userId]) {
            newJoinIds.push(presences[i].userId);
        }
    }
    var usernameById = {};
    if (newJoinIds.length > 0) {
        try {
            var users = nk.usersGetId(newJoinIds);
            if (users) {
                for (var i = 0; i < users.length; i++) {
                    var u = users[i];
                    if (u && u.userId) {
                        // Prefer display_name if set (the human-readable nickname), then
                        // username (the unique handle), then a placeholder.
                        usernameById[u.userId] = u.displayName || u.username || "anonymous";
                    }
                }
            }
        }
        catch (err) {
            logger.warn("usersGetId failed during matchJoin: %s", String(err));
        }
    }
    for (var i = 0; i < presences.length; i++) {
        var p = presences[i];
        if (state.players[p.userId]) {
            // Reconnect path — they're already known. Just mark connected and
            // move on.
            state.players[p.userId].connected = true;
            continue;
        }
        // Assign mark by join order: first player is X, second is O.
        var mark = state.playerOrder.length === 0 ? "X" : "O";
        var resolvedName = usernameById[p.userId] || p.username || "anonymous";
        state.players[p.userId] = {
            userId: p.userId,
            username: resolvedName,
            mark: mark,
            connected: true,
        };
        state.playerOrder.push(p.userId);
        logger.info("Player %s (%s) joined as %s", resolvedName, p.userId, mark);
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
var matchLeave = function (ctx, logger, nk, dispatcher, tick, state, presences) {
    for (var i = 0; i < presences.length; i++) {
        var p = presences[i];
        var player = state.players[p.userId];
        if (!player)
            continue;
        player.connected = false;
        logger.info("Player %s (%s) left", player.username, p.userId);
        if (state.phase === "playing") {
            // Forfeit: the OTHER player wins.
            var otherUid = state.playerOrder[0] === p.userId ? state.playerOrder[1] : state.playerOrder[0];
            var otherMark = state.players[otherUid] ? state.players[otherUid].mark : null;
            endGame(nk, logger, state, "forfeit", otherMark, null);
            broadcastState(dispatcher, state, tick);
        }
        else if (state.phase === "waiting") {
            // Remove from order. They never started a game so no leaderboard hit.
            var idx = state.playerOrder.indexOf(p.userId);
            if (idx >= 0)
                state.playerOrder.splice(idx, 1);
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
var matchLoop = function (ctx, logger, nk, dispatcher, tick, state, messages) {
    // -- 1. Process inbound messages -----------------------------------------
    for (var i = 0; i < messages.length; i++) {
        var msg = messages[i];
        var sender = msg.sender;
        // Decode payload as JSON. Goja's JSON.parse throws on bad input — wrap
        // it in try/catch so a malformed client message can't crash the match.
        var parsed = null;
        try {
            parsed = JSON.parse(nk.binaryToString(msg.data));
        }
        catch (err) {
            sendErrorTo(dispatcher, sender, "invalid JSON payload");
            continue;
        }
        if (msg.opCode === OpCode.MOVE) {
            handleMove(nk, logger, dispatcher, tick, state, sender, parsed);
        }
        else if (msg.opCode === OpCode.LEAVE) {
            // Treat as forfeit while playing.
            if (state.phase === "playing") {
                var otherUid = state.playerOrder[0] === sender.userId ? state.playerOrder[1] : state.playerOrder[0];
                var otherMark = state.players[otherUid] ? state.players[otherUid].mark : null;
                endGame(nk, logger, state, "forfeit", otherMark, null);
                broadcastState(dispatcher, state, tick);
            }
        }
        else {
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
    }
    else {
        // Reset the empty timer whenever someone is present.
        state.emptyTicksRemaining = EMPTY_MATCH_TIMEOUT_TICKS;
    }
    // -- 3. Per-turn timeout (timed mode only) -------------------------------
    if (state.mode === "timed" && state.phase === "playing") {
        var remaining = computeTurnSecondsRemaining(state, tick);
        if (remaining <= 0) {
            // Whoever's turn it is loses by timeout.
            var losingMark = state.turn;
            var winningMark = nextTurn(losingMark);
            logger.info("Turn timeout — %s loses", losingMark);
            endGame(nk, logger, state, "timeout", winningMark, null);
            broadcastState(dispatcher, state, tick);
        }
        else {
            // Re-broadcast roughly once a second so client timers stay in sync.
            // This is throttled by `lastBroadcastTick` to avoid spamming the wire.
            var ticksSinceLast = tick - state.lastBroadcastTick;
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
function handleMove(nk, logger, dispatcher, tick, state, sender, msg) {
    if (state.phase !== "playing") {
        sendErrorTo(dispatcher, sender, "match is not in playing phase");
        return;
    }
    var player = state.players[sender.userId];
    if (!player) {
        sendErrorTo(dispatcher, sender, "you are not in this match");
        return;
    }
    var error = validateMove(state.board, msg.cell, player.mark, state.turn);
    if (error !== null) {
        sendErrorTo(dispatcher, sender, error);
        return;
    }
    // Apply the move authoritatively.
    applyMove(state.board, msg.cell, player.mark);
    // Check for game-end conditions.
    var evalResult = evaluateBoard(state.board);
    if (evalResult.winner !== null) {
        endGame(nk, logger, state, "win", evalResult.winner, evalResult.line);
    }
    else if (evalResult.draw) {
        endGame(nk, logger, state, "draw", null, null);
    }
    else {
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
var matchTerminate = function (ctx, logger, nk, dispatcher, tick, state, graceSeconds) {
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
var matchSignal = function (ctx, logger, nk, dispatcher, tick, state, data) {
    return { state: state };
};
/**
 * The Nakama runtime expects an object with these exact property names. We
 * export it as a single bundle so `main.ts` can register it under a chosen
 * module name.
 */
var matchHandler = {
    matchInit: matchInit,
    matchJoinAttempt: matchJoinAttempt,
    matchJoin: matchJoin,
    matchLeave: matchLeave,
    matchLoop: matchLoop,
    matchTerminate: matchTerminate,
    matchSignal: matchSignal,
};

/** The Nakama module name we register the match handler under (see main.ts). */
var MATCH_MODULE = "lila_tictactoe";
/**
 * Parse / validate the mode field from an RPC payload. Defaults to "classic"
 * if missing or invalid.
 */
function parseMode(payload) {
    if (!payload || payload.length === 0)
        return "classic";
    try {
        var obj = JSON.parse(payload);
        return obj && obj.mode === "timed" ? "timed" : "classic";
    }
    catch (err) {
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
var findMatchRpc = function (ctx, logger, nk, payload) {
    var mode = parseMode(payload);
    logger.info("find_match: mode=%s user=%s", mode, ctx.userId);
    // Build a label query that matches "open" rooms in the desired mode.
    // Nakama supports a Bleve query DSL on match labels — `+field:value`.
    var query = "+label.mode:" + mode + " +label.open:1";
    var minSize = 1; // at least 1 player already inside
    var maxSize = 1; // exactly 1 — i.e., one slot free
    var limit = 10;
    // authoritative=true so we only consider matches running our handler.
    var matches = nk.matchList(limit, true, "", minSize, maxSize, query);
    if (matches && matches.length > 0) {
        // Pick the first match. The list is unordered but stable enough for our
        // purposes; we don't need fancy ranking.
        var m = matches[0];
        logger.info("find_match: reusing existing match %s", m.matchId);
        return JSON.stringify({ matchId: m.matchId });
    }
    // No open match — create one.
    var matchId = nk.matchCreate(MATCH_MODULE, { mode: mode });
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
var createPrivateMatchRpc = function (ctx, logger, nk, payload) {
    var mode = parseMode(payload);
    var matchId = nk.matchCreate(MATCH_MODULE, { mode: mode });
    logger.info("create_private_match: %s mode=%s", matchId, mode);
    return JSON.stringify({ matchId: matchId });
};
/**
 * RPC: list_open_matches
 *
 * Return up to 20 currently-joinable matches in the requested mode. Used by
 * any "browse rooms" UI.
 */
var listOpenMatchesRpc = function (ctx, logger, nk, payload) {
    var mode = parseMode(payload);
    var query = "+label.mode:" + mode + " +label.open:1";
    var matches = nk.matchList(20, true, "", 1, 1, query) || [];
    var out = [];
    for (var i = 0; i < matches.length; i++) {
        out.push({ matchId: matches[i].matchId, label: matches[i].label, size: matches[i].size });
    }
    return JSON.stringify({ matches: out });
};

// ---------------------------------------------------------------------------
// Miscellaneous client-facing RPCs that don't belong to matchmaking.
//
// Currently:
//   - get_leaderboard       Returns top N players with W/L/D/streak/score.
//   - get_my_stats          Returns the calling user's own stats.
//   - healthcheck           Trivial endpoint for uptime monitoring.
// ---------------------------------------------------------------------------
/**
 * RPC: get_leaderboard
 *
 * Request payload (JSON, optional): { "limit": number }
 * Response: { "entries": LeaderboardEntry[] }
 */
var getLeaderboardRpc = function (ctx, logger, nk, payload) {
    var limit = 10;
    if (payload && payload.length > 0) {
        try {
            var obj = JSON.parse(payload);
            if (obj && typeof obj.limit === "number")
                limit = obj.limit;
        }
        catch (err) {
            // Ignore — fall back to default.
        }
    }
    var entries = fetchTopEntries(nk, logger, limit);
    return JSON.stringify({ entries: entries });
};
/**
 * RPC: get_my_stats
 *
 * Returns the calling user's stats. No request payload.
 */
var getMyStatsRpc = function (ctx, logger, nk, payload) {
    if (!ctx.userId) {
        // Should never happen — Nakama refuses unauth'd RPCs by default — but
        // handle it defensively.
        return JSON.stringify({ error: "unauthenticated" });
    }
    var username = ctx.username || "anonymous";
    var stats = fetchUserStats(nk, ctx.userId, username);
    return JSON.stringify(stats);
};
/**
 * RPC: healthcheck
 *
 * Returns a tiny payload so external monitors / load balancers can hit a
 * known endpoint. Doesn't touch storage or matches.
 */
var healthcheckRpc = function (ctx, logger, nk, payload) {
    return JSON.stringify({ ok: true, ts: Date.now() });
};

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
// `let InitModule` becomes a top-level lexical binding in the bundled script,
// which Goja exposes via Runtime.Get("InitModule"). Renaming this variable
// will break Nakama integration — leave it alone.
var InitModule = function (ctx, logger, nk, initializer) {
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
