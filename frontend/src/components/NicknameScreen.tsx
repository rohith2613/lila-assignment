// ---------------------------------------------------------------------------
// Nickname screen — the first thing the user sees. Mirrors the leftmost
// mockup in the assignment PDF: a centered card with "Who are you?", a
// nickname input, and a Continue button.
//
// We pre-fill the input with whatever nickname is in localStorage so a
// returning user can hit Continue immediately.
// ---------------------------------------------------------------------------
import { FormEvent, useState } from "react";
import { getStoredNickname } from "../nakama/client";

interface Props {
  onSubmit: (nickname: string) => void;
  busy: boolean;
  error: string | null;
}

/** Min/max nickname length. Mirrors what Nakama allows for usernames. */
const MIN_LEN = 2;
const MAX_LEN = 20;

export default function NicknameScreen({ onSubmit, busy, error }: Props) {
  const [value, setValue] = useState<string>(getStoredNickname());

  // Local validation. We don't show errors until the user has tried to
  // submit at least once — typing-time errors feel naggy.
  const [showError, setShowError] = useState(false);
  const trimmed = value.trim();
  const isValid = trimmed.length >= MIN_LEN && trimmed.length <= MAX_LEN;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!isValid) {
      setShowError(true);
      return;
    }
    onSubmit(trimmed);
  }

  return (
    <div className="w-full max-w-sm">
      {/* Title — keeps the X icon style of the mockup but spelled out. */}
      <div className="mb-8 text-center">
        <div className="mb-3 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-lila-accent text-3xl font-black text-black">
          ×
        </div>
        <h1 className="text-2xl font-bold tracking-tight">Tic-Tac-Toe</h1>
        <p className="mt-1 text-sm text-lila-subtle">Multiplayer · Server-authoritative</p>
      </div>

      <form
        className="rounded-2xl border border-lila-border bg-lila-surface p-6 shadow-2xl"
        onSubmit={handleSubmit}
      >
        <label
          htmlFor="nickname"
          className="mb-2 block text-sm font-medium text-lila-text"
        >
          Who are you?
        </label>
        <input
          id="nickname"
          type="text"
          autoComplete="off"
          autoCapitalize="words"
          spellCheck={false}
          inputMode="text"
          maxLength={MAX_LEN}
          placeholder="Nickname"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (showError) setShowError(false);
          }}
          className="input-field"
          disabled={busy}
          aria-invalid={showError && !isValid}
        />

        {/* Validation message — only after the user has tried to submit. */}
        {showError && !isValid && (
          <p className="mt-2 text-xs text-red-400">
            Nickname must be {MIN_LEN}–{MAX_LEN} characters.
          </p>
        )}

        {/* Server / connection error from the parent. */}
        {error && (
          <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="btn-primary mt-6 w-full"
        >
          {busy ? "Connecting…" : "Continue"}
        </button>
      </form>

      {/* Hint copy — sets expectations about what happens next. */}
      <p className="mt-6 text-center text-xs text-lila-subtle">
        Your nickname will appear on the leaderboard.
      </p>
    </div>
  );
}
