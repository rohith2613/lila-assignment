// ---------------------------------------------------------------------------
// Game board screen — the in-match UI. Mirrors the third mockup in the
// assignment PDF: a teal background with both player names at the top, the
// 3x3 grid in the middle, and a "Leave room" CTA at the bottom.
//
// Responsibilities:
//   1. Render the 9 cells from `state.board`.
//   2. Highlight whose turn it is.
//   3. Show the per-turn timer in timed mode.
//   4. Send a MOVE op-code when the local player taps a free cell on their turn.
//   5. Disable interaction (and show a "leaving" state) when the user
//      explicitly leaves.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from "react";
import { NakamaConnection, sendMove } from "../nakama/client";
import { Cell, GameState } from "../nakama/types";

interface Props {
  conn: NakamaConnection;
  matchId: string;
  state: GameState;
  onLeave: () => void;
  errorMessage: string | null;
}

export default function GameBoard({
  conn,
  matchId,
  state,
  onLeave,
  errorMessage,
}: Props) {
  // Local "we sent a move and are waiting for confirmation" flag. Prevents
  // the user from spamming the same cell while the server processes.
  const [sending, setSending] = useState(false);

  // Find which side WE are. The server tells us via the player list; we
  // match by user id from our session.
  const me = useMemo(
    () => state.players.find((p) => p.userId === conn.userId),
    [state.players, conn.userId],
  );
  const opponent = useMemo(
    () => state.players.find((p) => p.userId !== conn.userId),
    [state.players, conn.userId],
  );

  const isMyTurn = !!me && me.mark === state.turn && state.phase === "playing";

  // Reset the "sending" lock whenever the state changes — by the time we get
  // a new state from the server, our previous move has either been applied
  // or rejected.
  useEffect(() => {
    setSending(false);
  }, [state]);

  async function handleCellClick(idx: number) {
    if (!isMyTurn || sending) return;
    if (state.board[idx] !== null) return;
    setSending(true);
    try {
      await sendMove(conn, matchId, idx);
    } catch (err) {
      console.error("[game] sendMove failed:", err);
      setSending(false);
    }
  }

  return (
    <div className="flex w-full max-w-sm flex-col items-center">
      {/* Player header — shows both players and their marks. The current
          turn is bolded. */}
      <div className="grid w-full grid-cols-2 gap-2 text-center text-xs uppercase tracking-wide text-black/70">
        <PlayerBadge
          name={me?.username || "you"}
          mark={me?.mark}
          isTurn={state.turn === me?.mark}
          label="(you)"
        />
        <PlayerBadge
          name={opponent?.username || "opp"}
          mark={opponent?.mark}
          isTurn={state.turn === opponent?.mark}
          label="(opp)"
        />
      </div>

      {/* Turn indicator. Big text matches the mockup. */}
      <div className="mt-4 flex items-center gap-2 text-xl font-semibold text-black">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full border-2 border-black/70 text-sm">
          {state.turn}
        </span>
        <span>{isMyTurn ? "Your turn" : "Opponent's turn"}</span>
      </div>

      {/* Timer — only shown in timed mode. */}
      {state.mode === "timed" && state.phase === "playing" && (
        <TimerPill seconds={state.turnSecondsRemaining} total={state.turnTimeoutSeconds} />
      )}

      {/* The board itself. We use a CSS grid for crisp 3x3 spacing. */}
      <div
        className="mt-6 grid w-full max-w-[320px] grid-cols-3 gap-3"
        role="grid"
        aria-label="Tic-Tac-Toe board"
      >
        {state.board.map((cell, idx) => (
          <CellButton
            key={idx}
            cell={cell}
            index={idx}
            disabled={!isMyTurn || sending || cell !== null}
            highlighted={state.winningLine?.includes(idx) || false}
            onClick={() => handleCellClick(idx)}
          />
        ))}
      </div>

      {/* Inline error from the server (e.g. "not your turn"). */}
      {errorMessage && (
        <p className="mt-4 max-w-xs rounded-lg border border-red-500/40 bg-red-500/15 p-2 text-center text-xs text-red-900">
          {errorMessage}
        </p>
      )}

      {/* Leave button — forfeits the game. */}
      <button
        type="button"
        onClick={onLeave}
        className="mt-8 inline-flex items-center gap-2 rounded-full border border-black/30 bg-black/10 px-5 py-2 text-xs font-semibold text-black/80 transition hover:bg-black/20"
      >
        Leave room
      </button>
    </div>
  );
}

// -- Sub-components ---------------------------------------------------------

interface PlayerBadgeProps {
  name: string;
  mark: string | undefined;
  isTurn: boolean;
  label: string;
}

function PlayerBadge({ name, mark, isTurn, label }: PlayerBadgeProps) {
  return (
    <div
      className={`rounded-xl border px-3 py-2 transition ${
        isTurn
          ? "border-black/40 bg-black/10 text-black"
          : "border-transparent text-black/60"
      }`}
    >
      <div className="truncate text-sm font-bold uppercase">{name}</div>
      <div className="text-[10px] tracking-widest text-black/50">
        {label} · {mark || "?"}
      </div>
    </div>
  );
}

interface CellButtonProps {
  cell: Cell;
  index: number;
  disabled: boolean;
  highlighted: boolean;
  onClick: () => void;
}

function CellButton({ cell, disabled, highlighted, onClick }: CellButtonProps) {
  // Aspect-square + grid layout keeps the cells square on every viewport.
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`aspect-square rounded-2xl border-2 text-5xl font-black
        transition focus:outline-none focus-visible:ring-2 focus-visible:ring-black
        ${highlighted ? "border-lila-win bg-lila-win/30" : "border-black/30 bg-black/5"}
        ${disabled ? "cursor-default" : "hover:bg-black/15 active:scale-95"}
      `}
      aria-label={cell ? `Cell with ${cell}` : "Empty cell"}
    >
      {cell && (
        <span
          className={`mark-ink-in inline-block ${
            cell === "X" ? "text-lila-x" : "text-lila-o"
          }`}
        >
          {cell}
        </span>
      )}
    </button>
  );
}

interface TimerProps {
  seconds: number;
  total: number;
}

function TimerPill({ seconds, total }: TimerProps) {
  // Show a colored pill that turns red as time runs out. Pure visual cue —
  // the actual forfeit is enforced by the server.
  const pct = total > 0 ? Math.max(0, Math.min(1, seconds / total)) : 0;
  const color =
    pct > 0.5 ? "bg-black/15 text-black" : pct > 0.25 ? "bg-yellow-400/40 text-black" : "bg-red-500/60 text-white";
  return (
    <div
      className={`mt-2 inline-flex items-center gap-2 rounded-full px-4 py-1 text-xs font-semibold ${color}`}
      aria-live="polite"
    >
      <span aria-hidden="true">⏱</span>
      <span>{seconds}s</span>
    </div>
  );
}
