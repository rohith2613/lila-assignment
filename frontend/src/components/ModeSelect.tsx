// ---------------------------------------------------------------------------
// Mode select screen — lets the player pick Classic (no time limit) or
// Timed (30 second per-move clock). The chosen mode is forwarded to the
// matchmaking RPC so the matchmaker only pairs players in the same mode.
//
// This screen isn't in the original mockups but is required by the
// "Timer-Based Game Mode" bonus task in the assignment.
// ---------------------------------------------------------------------------
import { MatchMode } from "../nakama/types";

interface Props {
  onSelect: (mode: MatchMode) => void;
}

export default function ModeSelect({ onSelect }: Props) {
  return (
    <div className="w-full max-w-sm">
      <div className="mb-8 text-center">
        <h2 className="text-xl font-bold">Choose a mode</h2>
        <p className="mt-1 text-sm text-lila-subtle">
          Pick how you want to play. You'll be matched with another player
          who picked the same mode.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        <ModeCard
          title="Classic"
          tagline="Take your time. No turn timer."
          accent={false}
          onClick={() => onSelect("classic")}
        />
        <ModeCard
          title="Timed"
          tagline="30 seconds per move. Forfeit on timeout."
          accent
          onClick={() => onSelect("timed")}
        />
      </div>
    </div>
  );
}

// ---- Local helper ---------------------------------------------------------

interface ModeCardProps {
  title: string;
  tagline: string;
  accent: boolean;
  onClick: () => void;
}

/**
 * One of the two large mode buttons. Pulled out as a sub-component because
 * the markup is non-trivial and we have two of them.
 */
function ModeCard({ title, tagline, accent, onClick }: ModeCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex items-center justify-between rounded-2xl
        border ${accent ? "border-lila-accent/60" : "border-lila-border"}
        bg-lila-surface px-5 py-5 text-left transition
        hover:border-lila-accent hover:shadow-glow focus:outline-none
        focus-visible:ring-2 focus-visible:ring-lila-accent`}
    >
      <div>
        <div className="text-base font-semibold">{title}</div>
        <div className="mt-1 text-xs text-lila-subtle">{tagline}</div>
      </div>
      <span
        className={`text-xl transition group-hover:translate-x-1 ${
          accent ? "text-lila-accent" : "text-lila-subtle"
        }`}
        aria-hidden="true"
      >
        →
      </span>
    </button>
  );
}
