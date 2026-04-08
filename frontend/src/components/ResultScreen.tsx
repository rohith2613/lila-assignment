// ---------------------------------------------------------------------------
// Result screen — shown when the match has ended. Mirrors the rightmost
// mockup in the assignment PDF: a big WINNER / LOSER / DRAW headline, points
// awarded, the global leaderboard, and a "Play Again" button.
//
// We re-fetch the leaderboard via the get_leaderboard RPC every time the
// screen mounts so the user always sees fresh stats (including their own
// updated W/L/D from the game they just finished).
// ---------------------------------------------------------------------------
import { useEffect, useState } from "react";
import { getLeaderboard, NakamaConnection } from "../nakama/client";
import { GameState, LeaderboardEntry } from "../nakama/types";

interface Props {
  conn: NakamaConnection;
  state: GameState;
  onPlayAgain: () => void;
}

export default function ResultScreen({ conn, state, onPlayAgain }: Props) {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Determine the local user's outcome from the state. We compare against
  // our own user id rather than relying on a separate flag.
  const isWin = state.winnerUserId === conn.userId;
  const isDraw = state.endReason === "draw";
  const isTimeout = state.endReason === "timeout";
  const isForfeit = state.endReason === "forfeit";

  // Headline copy + score awarded. We compute the score on the client purely
  // for display — the server is the source of truth, but the formula matches.
  const headline = isDraw
    ? "DRAW"
    : isWin
      ? "WINNER!"
      : isTimeout
        ? "TIMEOUT"
        : "GAME OVER";
  const points = isWin ? 100 : isDraw ? 25 : 0;
  const subline = isWin
    ? `+${points} pts`
    : isDraw
      ? `+${points} pts`
      : isForfeit
        ? "Opponent left"
        : isTimeout
          ? "Time ran out"
          : "Better luck next time";

  // Fetch the global leaderboard. We refresh on mount and after a small
  // delay (to give the server's leaderboard write a chance to land).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    const fetchOnce = async () => {
      try {
        const data = await getLeaderboard(conn, 10);
        if (!cancelled) {
          setEntries(data);
          setLoading(false);
        }
      } catch (err) {
        console.error("[result] failed to fetch leaderboard:", err);
        if (!cancelled) {
          setLoadError("Couldn't load leaderboard.");
          setLoading(false);
        }
      }
    };

    // Two fetches: one immediately, one ~600 ms later. The second one
    // catches the freshly-written record from the just-finished game in
    // case the first fetch raced the server-side write.
    fetchOnce();
    const timer = window.setTimeout(fetchOnce, 600);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [conn]);

  return (
    <div className="w-full max-w-sm">
      {/* Big headline / icon — matches the X+WINNER block from the mockup. */}
      <div className="text-center">
        <div className="mb-3 inline-flex h-20 w-20 items-center justify-center rounded-3xl bg-lila-surface text-6xl font-black">
          {isDraw ? "−" : isWin ? "★" : "×"}
        </div>
        <h1
          className={`text-3xl font-black tracking-tight ${
            isWin ? "text-lila-accent" : isDraw ? "text-lila-text" : "text-lila-x"
          }`}
        >
          {headline}
        </h1>
        <p className="mt-1 text-sm text-lila-subtle">{subline}</p>
      </div>

      {/* Leaderboard. Pulled into its own table for readability. */}
      <div className="mt-8 rounded-2xl border border-lila-border bg-lila-surface p-4">
        <div className="flex items-center justify-between border-b border-lila-border pb-2">
          <span className="text-sm font-semibold text-lila-accent">🏆 Leaderboard</span>
          <span className="text-[10px] uppercase tracking-widest text-lila-subtle">
            W/L/D · ★ · Score
          </span>
        </div>

        {loading && (
          <div className="py-4 text-center text-xs text-lila-subtle">Loading…</div>
        )}

        {loadError && (
          <div className="py-4 text-center text-xs text-red-400">{loadError}</div>
        )}

        {!loading && !loadError && entries.length === 0 && (
          <div className="py-4 text-center text-xs text-lila-subtle">
            No leaderboard entries yet.
          </div>
        )}

        {!loading && !loadError && entries.length > 0 && (
          <ul className="mt-2 space-y-1 text-sm">
            {entries.map((entry, idx) => {
              const isMe = entry.userId === conn.userId;
              return (
                <li
                  key={entry.userId}
                  className={`flex items-center gap-2 rounded-lg px-2 py-1.5 ${
                    isMe ? "bg-lila-accent/15 text-lila-text" : "text-lila-text/90"
                  }`}
                >
                  <span className="w-5 text-right text-xs text-lila-subtle">
                    {idx + 1}.
                  </span>
                  <span className="flex-1 truncate font-medium">
                    {entry.username}
                    {isMe && <span className="ml-1 text-xs text-lila-accent">(you)</span>}
                  </span>
                  <span className="text-xs tabular-nums">
                    <span className="text-lila-win">{entry.wins}</span>
                    <span className="text-lila-subtle">/</span>
                    <span className="text-lila-x">{entry.losses}</span>
                    <span className="text-lila-subtle">/</span>
                    <span className="text-lila-o">{entry.draws}</span>
                  </span>
                  <span className="w-6 text-right text-xs text-lila-subtle">
                    {entry.bestStreak}
                  </span>
                  <span className="w-12 text-right text-sm font-semibold tabular-nums">
                    {entry.score}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <button
        type="button"
        onClick={onPlayAgain}
        className="btn-primary mt-6 w-full"
      >
        Play Again
      </button>
    </div>
  );
}
