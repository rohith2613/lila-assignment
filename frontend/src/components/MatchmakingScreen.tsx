// ---------------------------------------------------------------------------
// Matchmaking screen — calls find_match RPC, joins the returned match, and
// waits for the second player to arrive. Mirrors the second mockup in the
// assignment PDF: a centered "Finding a random player..." card with a
// rolling timer and a Cancel button.
//
// State machine inside this component:
//
//   "queue" -> calling find_match RPC, then joinMatch over the socket
//   "wait"  -> joined, waiting for opponent (gameState.phase === "waiting")
//
// As soon as gameState.phase becomes "playing" the parent App detects it and
// transitions to the game screen.
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from "react";
import {
  findOrCreateMatch,
  joinMatch,
  NakamaConnection,
} from "../nakama/client";
import { GameState, MatchMode } from "../nakama/types";

interface Props {
  conn: NakamaConnection;
  mode: MatchMode;
  onJoined: (matchId: string, initialState: GameState) => void;
  onState: (state: GameState) => void;
  onError: (message: string) => void;
  onCancel: () => void;
  errorMessage: string | null;
}

export default function MatchmakingScreen({
  conn,
  mode,
  onJoined,
  onState,
  onError,
  onCancel,
  errorMessage,
}: Props) {
  // Elapsed seconds — purely cosmetic, drives the "It usually takes Xs" copy.
  const [elapsed, setElapsed] = useState(0);

  // Track whether we've successfully joined the match yet so we can show
  // a slightly different status message.
  const [joined, setJoined] = useState(false);

  // We use a ref so a re-render doesn't double-fire the join effect.
  const startedRef = useRef(false);

  // ---- Tick the elapsed counter every second ----------------------------
  useEffect(() => {
    const id = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  // ---- Kick off matchmaking on mount ------------------------------------
  //
  // Important: we deliberately do NOT use a `cancelled` flag with an effect
  // cleanup. React StrictMode mounts -> unmounts -> re-mounts every effect
  // in dev, which would set `cancelled=true` mid-flight and skip the
  // `joinMatch` call we depend on. The `startedRef` guard makes the body
  // run at most once across both StrictMode passes; the async work that
  // it kicks off keeps going regardless of remounts. Callbacks update
  // parent state via setState, which is safe even if this component is
  // technically unmounted at the moment a callback fires (the parent App
  // owns the connection and the screen state).
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    (async () => {
      try {
        const matchId = await findOrCreateMatch(conn, mode);

        // The first STATE_UPDATE after join is the "initial" state we hand
        // to the App via onJoined. Subsequent updates use the regular
        // onState callback.
        let receivedFirstState = false;

        await joinMatch(conn, matchId, {
          onState: (state) => {
            if (!receivedFirstState) {
              receivedFirstState = true;
              setJoined(true);
              onJoined(matchId, state);
            } else {
              onState(state);
            }
          },
          onError: (msg) => onError(msg),
          onDisconnect: () => onError("Disconnected from server"),
        });
      } catch (err) {
        console.error("[matchmaking] failed:", err);
        onError(
          "Couldn't find a match. The server may be busy — please try again.",
        );
      }
    })();

    // No cleanup function — see comment block above. Cancellation of the
    // in-flight async work is the parent App's responsibility (via
    // handleLeaveMatch which calls leaveMatch on the connection).
    //
    // We intentionally do NOT include onJoined / onState / onError in deps
    // either: they're useCallback'd in the parent and the startedRef guard
    // already prevents re-entry on dependency changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, mode]);

  // ---- Render -----------------------------------------------------------
  return (
    <div className="w-full max-w-sm text-center">
      <div className="rounded-2xl border border-lila-border bg-lila-surface p-8">
        {/* Spinner — pure CSS so we don't add a dependency. */}
        <div
          className="mx-auto mb-6 h-12 w-12 animate-slow-pulse rounded-full border-4 border-lila-border border-t-lila-accent"
          role="status"
          aria-label="Searching for a match"
        />

        <h2 className="text-lg font-semibold">
          {joined ? "Waiting for opponent…" : "Finding a random player…"}
        </h2>
        <p className="mt-2 text-sm text-lila-subtle">
          Mode: <span className="font-medium text-lila-text">{mode === "timed" ? "Timed" : "Classic"}</span>
        </p>
        <p className="mt-1 text-xs text-lila-subtle">
          {elapsed < 60
            ? `${elapsed}s elapsed · usually takes ~5s`
            : "Still searching…"}
        </p>

        {errorMessage && (
          <p className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300">
            {errorMessage}
          </p>
        )}

        <button
          type="button"
          onClick={onCancel}
          className="btn-secondary mt-6 w-full"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
