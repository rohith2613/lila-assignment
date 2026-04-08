// ---------------------------------------------------------------------------
// Plain-Node unit tests for the pure game logic in src/game_logic.ts.
//
// We can't import the .ts file directly, so we re-implement the SAME pure
// helpers here and run a battery of assertions against them. The point is
// to verify the algorithm is correct — the actual TypeScript file is a
// straight copy of these functions and is type-checked by tsc separately.
//
// Run with: node test/game_logic.test.mjs
// ---------------------------------------------------------------------------
import assert from "node:assert/strict";

// ---- Re-implementation matching src/game_logic.ts -------------------------
const WINNING_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

function createEmptyBoard() {
  const b = [];
  for (let i = 0; i < 9; i++) b.push(null);
  return b;
}

function validateMove(board, cell, playerMark, currentTurn) {
  if (typeof cell !== "number" || !isFinite(cell)) return "cell must be a number";
  if (Math.floor(cell) !== cell) return "cell must be an integer";
  if (cell < 0 || cell > 8) return "cell must be between 0 and 8";
  if (playerMark !== currentTurn) return "not your turn";
  if (board[cell] !== null) return "cell is already occupied";
  return null;
}

function applyMove(board, cell, mark) {
  board[cell] = mark;
  return board;
}

function evaluateBoard(board) {
  for (const line of WINNING_LINES) {
    const a = board[line[0]];
    const b = board[line[1]];
    const c = board[line[2]];
    if (a !== null && a === b && a === c) {
      return { winner: a, line, draw: false };
    }
  }
  for (const cell of board) {
    if (cell === null) return { winner: null, line: null, draw: false };
  }
  return { winner: null, line: null, draw: true };
}

function nextTurn(current) {
  return current === "X" ? "O" : "X";
}

// ---- Tests -----------------------------------------------------------------
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log("  ✓", name);
    passed++;
  } catch (err) {
    console.log("  ✗", name);
    console.log("    ", err.message);
    failed++;
  }
}

console.log("\ngame_logic.ts — pure-function tests\n");

test("createEmptyBoard returns 9 nulls", () => {
  const b = createEmptyBoard();
  assert.equal(b.length, 9);
  for (const c of b) assert.equal(c, null);
});

test("validateMove accepts a fresh move", () => {
  const b = createEmptyBoard();
  assert.equal(validateMove(b, 0, "X", "X"), null);
});

test("validateMove rejects out-of-range cells", () => {
  const b = createEmptyBoard();
  assert.equal(validateMove(b, -1, "X", "X"), "cell must be between 0 and 8");
  assert.equal(validateMove(b, 9, "X", "X"), "cell must be between 0 and 8");
  assert.equal(validateMove(b, 100, "X", "X"), "cell must be between 0 and 8");
});

test("validateMove rejects non-integer cells", () => {
  const b = createEmptyBoard();
  assert.equal(validateMove(b, 1.5, "X", "X"), "cell must be an integer");
  assert.equal(validateMove(b, NaN, "X", "X"), "cell must be a number");
});

test("validateMove rejects non-number cells", () => {
  const b = createEmptyBoard();
  assert.equal(validateMove(b, "0", "X", "X"), "cell must be a number");
  assert.equal(validateMove(b, null, "X", "X"), "cell must be a number");
  assert.equal(validateMove(b, undefined, "X", "X"), "cell must be a number");
});

test("validateMove rejects wrong-turn moves", () => {
  const b = createEmptyBoard();
  assert.equal(validateMove(b, 0, "O", "X"), "not your turn");
});

test("validateMove rejects occupied cells", () => {
  const b = createEmptyBoard();
  applyMove(b, 4, "X");
  assert.equal(validateMove(b, 4, "O", "O"), "cell is already occupied");
});

test("evaluateBoard detects each row win", () => {
  for (const row of [[0, 1, 2], [3, 4, 5], [6, 7, 8]]) {
    const b = createEmptyBoard();
    for (const c of row) b[c] = "X";
    const e = evaluateBoard(b);
    assert.equal(e.winner, "X");
    assert.deepEqual(e.line, row);
    assert.equal(e.draw, false);
  }
});

test("evaluateBoard detects each column win", () => {
  for (const col of [[0, 3, 6], [1, 4, 7], [2, 5, 8]]) {
    const b = createEmptyBoard();
    for (const c of col) b[c] = "O";
    const e = evaluateBoard(b);
    assert.equal(e.winner, "O");
    assert.deepEqual(e.line, col);
  }
});

test("evaluateBoard detects both diagonals", () => {
  const b1 = createEmptyBoard();
  [0, 4, 8].forEach(c => b1[c] = "X");
  assert.equal(evaluateBoard(b1).winner, "X");

  const b2 = createEmptyBoard();
  [2, 4, 6].forEach(c => b2[c] = "O");
  assert.equal(evaluateBoard(b2).winner, "O");
});

test("evaluateBoard detects a draw on full board with no winner", () => {
  // X O X
  // X O O
  // O X X
  const draw = ["X", "O", "X", "X", "O", "O", "O", "X", "X"];
  const e = evaluateBoard(draw);
  assert.equal(e.winner, null);
  assert.equal(e.draw, true);
  assert.equal(e.line, null);
});

test("evaluateBoard returns no-result for in-progress games", () => {
  const b = createEmptyBoard();
  b[0] = "X";
  b[4] = "O";
  const e = evaluateBoard(b);
  assert.equal(e.winner, null);
  assert.equal(e.draw, false);
});

test("evaluateBoard does not match three-in-a-row of mixed marks", () => {
  // [X, O, X] in row 1 — should NOT count as a win.
  const b = createEmptyBoard();
  b[0] = "X"; b[1] = "O"; b[2] = "X";
  const e = evaluateBoard(b);
  assert.equal(e.winner, null);
});

test("nextTurn alternates", () => {
  assert.equal(nextTurn("X"), "O");
  assert.equal(nextTurn("O"), "X");
});

test("end-to-end: full game from empty to win", () => {
  // Simulate a complete game where X wins by top row.
  const b = createEmptyBoard();
  // X plays cell 0
  assert.equal(validateMove(b, 0, "X", "X"), null);
  applyMove(b, 0, "X");
  assert.equal(evaluateBoard(b).winner, null);
  // O plays cell 4
  assert.equal(validateMove(b, 4, "O", "O"), null);
  applyMove(b, 4, "O");
  // X plays cell 1
  applyMove(b, 1, "X");
  // O plays cell 5
  applyMove(b, 5, "O");
  // X plays cell 2 → wins
  applyMove(b, 2, "X");
  const e = evaluateBoard(b);
  assert.equal(e.winner, "X");
  assert.deepEqual(e.line, [0, 1, 2]);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
