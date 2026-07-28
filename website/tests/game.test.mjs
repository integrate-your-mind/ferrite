import assert from "node:assert/strict";
import test from "node:test";
import { getStatus, getWinner } from "../app/examples/game.js";

test("Tic-Tac-Toe detects both diagonals", () => {
  assert.equal(getWinner(["X", "O", null, "O", "X", null, null, null, "X"]), "X");
  assert.equal(getWinner(["O", null, "X", null, "X", null, "X", null, "O"]), "X");
});

test("Tic-Tac-Toe reports a full-board draw and no winner", () => {
  const draw = ["X", "O", "X", "X", "O", "O", "O", "X", "X"];
  assert.equal(getWinner(draw), null);
  assert.equal(getStatus(draw), "Draw");
});
