// ---------------------------------------------------------------------------
// Pure Tic-Tac-Toe game logic.
//
// This module deliberately has no Nakama dependencies. Everything in here is a
// pure function over the Board / Mark types so the same code could be unit
// tested with a plain JS test runner. The match handler imports these helpers
// to enforce rules; clients never run them — they only render whatever the
// server tells them.
// ---------------------------------------------------------------------------
import { Board, Cell, Mark } from "./types";

/**
 * The eight winning lines of a 3x3 Tic-Tac-Toe board, expressed as flat
 * indices into a 9-element board array. Three rows, three columns, two
 * diagonals.
 */
export const WINNING_LINES: number[][] = [
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
export function createEmptyBoard(): Board {
  const board: Board = [];
  for (let i = 0; i < 9; i++) {
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
export function validateMove(
  board: Board,
  cell: number,
  playerMark: Mark,
  currentTurn: Mark,
): string | null {
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
export function applyMove(board: Board, cell: number, mark: Mark): Board {
  board[cell] = mark;
  return board;
}

/**
 * Result of evaluating the board after a move.
 *
 *   - winner: the winning mark, or null if no winner yet.
 *   - line:   the indices of the winning line, or null.
 *   - draw:   true if the board is full and no one won.
 */
export interface BoardEvaluation {
  winner: Mark | null;
  line: number[] | null;
  draw: boolean;
}

/**
 * Check the board for a winning line or a draw.
 *
 * Implementation: walk the 8 winning lines, check if all three cells share
 * the same non-null mark. If none match, count empty cells; zero empty cells
 * means a draw.
 */
export function evaluateBoard(board: Board): BoardEvaluation {
  for (let i = 0; i < WINNING_LINES.length; i++) {
    const line = WINNING_LINES[i];
    const a: Cell = board[line[0]];
    const b: Cell = board[line[1]];
    const c: Cell = board[line[2]];
    if (a !== null && a === b && a === c) {
      return { winner: a, line: line, draw: false };
    }
  }

  // No winner — see if any cell is still empty. If not, it's a draw.
  for (let i = 0; i < board.length; i++) {
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
export function nextTurn(current: Mark): Mark {
  return current === "X" ? "O" : "X";
}
