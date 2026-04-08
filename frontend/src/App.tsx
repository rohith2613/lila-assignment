// ---------------------------------------------------------------------------
// Top-level App component — owns the screen state machine.
//
// The flow is strictly linear:
//
//   nickname  ──>  mode  ──>  matchmaking  ──>  game  ──>  result
//                    ▲                                       │
//                    └───────────────────────────────────────┘
//                              "Play Again" loop
//
// Each screen receives just the props it needs (and the connection object,
// for screens that talk to Nakama). State transitions live in callbacks
// passed down from this file so the screens stay dumb.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from "react";
import GameBoard from "./components/GameBoard";
import MatchmakingScreen from "./components/MatchmakingScreen";
import ModeSelect from "./components/ModeSelect";
import NicknameScreen from "./components/NicknameScreen";
import ResultScreen from "./components/ResultScreen";
import {
  createNakamaClient,
  joinMatch,
  leaveMatch,
  NakamaConnection,
} from "./nakama/client";
import { GameState, MatchMode } from "./nakama/types";

type Screen = "nickname" | "mode" | "matchmaking" | "game" | "result";

export default function App() {
  // -- Connection / identity ------------------------------------------------
  const [conn, setConn] = useState<NakamaConnection | null>(null);
  const [connecting, setConnecting] = useState(false);

  // -- Navigation -----------------------------------------------------------
  const [screen, setScreen] = useState<Screen>("nickname");

  // -- Match state ----------------------------------------------------------
  const [mode, setMode] = useState<MatchMode>("classic");
  const [matchId, setMatchId] = useState<string | null>(null);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Once a match is joined, we receive STATE_UPDATE messages via the
  // callbacks attached in the matchmaking screen. We just react here.
  // -------------------------------------------------------------------------

  // When the game state transitions to "playing" we leave matchmaking. When
  // it transitions to "ended" we move to the result screen. We watch the
  // gameState.phase rather than tracking the transitions inside child
  // components — keeps the screen logic in one place.
  useEffect(() => {
    if (!gameState) return;
    if (gameState.phase === "playing" && screen === "matchmaking") {
      setScreen("game");
    } else if (gameState.phase === "ended" && screen === "game") {
      setScreen("result");
    }
  }, [gameState, screen]);

  // -------------------------------------------------------------------------
  // Callbacks passed to screens
  // -------------------------------------------------------------------------

  const handleNicknameSubmit = useCallback(async (name: string) => {
    setConnecting(true);
    setErrorMessage(null);
    try {
      const c = await createNakamaClient(name);
      setConn(c);
      setScreen("mode");
    } catch (err) {
      console.error("[App] failed to connect:", err);
      setErrorMessage(
        "Couldn't reach the game server. Check your connection and try again.",
      );
    } finally {
      setConnecting(false);
    }
  }, []);

  const handleModeChosen = useCallback((m: MatchMode) => {
    setMode(m);
    setGameState(null);
    setMatchId(null);
    setErrorMessage(null);
    setScreen("matchmaking");
  }, []);

  const handleMatchJoined = useCallback((id: string, initialState: GameState) => {
    setMatchId(id);
    setGameState(initialState);
  }, []);

  const handleMatchStateUpdate = useCallback((state: GameState) => {
    setGameState(state);
  }, []);

  const handleMatchError = useCallback((message: string) => {
    setErrorMessage(message);
  }, []);

  const handleLeaveMatch = useCallback(async () => {
    if (conn && matchId) {
      await leaveMatch(conn, matchId);
    }
    setMatchId(null);
    setGameState(null);
    setErrorMessage(null);
    setScreen("mode");
  }, [conn, matchId]);

  const handlePlayAgain = useCallback(() => {
    // Don't leave the previous match — it's already ended and lingering
    // for cleanup. Just clear local state and go back to mode select.
    setMatchId(null);
    setGameState(null);
    setErrorMessage(null);
    setScreen("mode");
  }, []);

  // -------------------------------------------------------------------------
  // Cleanup on unmount: close the socket so the server frees us up.
  // -------------------------------------------------------------------------
  useEffect(() => {
    return () => {
      if (conn) {
        try {
          conn.socket.disconnect(true);
        } catch (err) {
          // Ignore — page is closing anyway.
        }
      }
    };
  }, [conn]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  // We pick a background per screen. The game itself uses the teal accent
  // (matching the LILA sample mockup); everything else uses the dark surface.
  const isGameScreen = screen === "game";
  const containerBg = isGameScreen ? "bg-lila-accent text-black" : "bg-lila-bg text-lila-text";

  return (
    <div className={`flex min-h-svh w-full flex-col ${containerBg} transition-colors`}>
      {/* Header — only shown on the connected screens (after nickname).
          Keeps the layout clean on the cold-start splash. */}
      {conn && screen !== "nickname" && (
        <header className="flex items-center justify-between px-5 py-4 text-sm">
          <span className="font-bold tracking-widest">LILA</span>
          <span
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              isGameScreen ? "bg-black/20 text-black" : "bg-lila-surface text-lila-subtle"
            }`}
          >
            {conn.username}
          </span>
        </header>
      )}

      {/* Main content area — flex-1 + center so each screen renders into a
          consistent vertical viewport regardless of how much copy it has. */}
      <main className="flex flex-1 items-center justify-center px-5 pb-8">
        {screen === "nickname" && (
          <NicknameScreen
            onSubmit={handleNicknameSubmit}
            busy={connecting}
            error={errorMessage}
          />
        )}

        {screen === "mode" && conn && (
          <ModeSelect onSelect={handleModeChosen} />
        )}

        {screen === "matchmaking" && conn && (
          <MatchmakingScreen
            conn={conn}
            mode={mode}
            onJoined={handleMatchJoined}
            onState={handleMatchStateUpdate}
            onError={handleMatchError}
            onCancel={handleLeaveMatch}
            errorMessage={errorMessage}
          />
        )}

        {screen === "game" && conn && matchId && gameState && (
          <GameBoard
            conn={conn}
            matchId={matchId}
            state={gameState}
            onLeave={handleLeaveMatch}
            errorMessage={errorMessage}
          />
        )}

        {screen === "result" && conn && gameState && (
          <ResultScreen
            conn={conn}
            state={gameState}
            onPlayAgain={handlePlayAgain}
          />
        )}
      </main>

      {/* Footer — small attribution. Only on dark screens to avoid clutter. */}
      {!isGameScreen && (
        <footer className="px-5 pb-4 text-center text-[11px] text-lila-subtle">
          Built for the LILA Games full-stack assignment · Powered by Nakama
        </footer>
      )}
    </div>
  );
}
