"use client";

import { useState } from "@ferrite/runtime";
import "./page.css";

type SquareValue = "X" | "O" | null;
type BoardState = SquareValue[];

const lines: Array<[number, number, number]> = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

export const metadata = {
  title: "Ferrite Tic Tac Toe",
  description: "A stateful interactive example built with Ferrite client rendering.",
};

function getWinner(squares: BoardState): SquareValue {
  for (const [a, b, c] of lines) {
    if (squares[a] !== null && squares[a] === squares[b] && squares[b] === squares[c]) {
      return squares[a];
    }
  }
  return null;
}

function Square({
  value,
  onPlay,
}: {
  value: SquareValue;
  onPlay: () => void;
}) {
  return (
    <button
      type="button"
      className="ferrite-tictactoe-square"
      onClick={onPlay}
    >
      {value}
    </button>
  );
}

export default function TicTacToePage() {
  const [state, setState] = useState<BoardState>(Array(9).fill(null));
  const [xIsNext, setXIsNext] = useState(true);

  const winner = getWinner(state);
  const draw = winner === null && state.every((square) => square !== null);
  const next = xIsNext ? "X" : "O";

  const status = winner ? `Winner: ${winner}` : draw ? "Draw" : `Next player: ${next}`;

  function playMove(index: number) {
    if (winner || state[index] !== null) {
      return;
    }

    const nextState = [...state];
    nextState[index] = next;
    setState(nextState);
    setXIsNext(!xIsNext);
  }

  function reset() {
    setState(Array(9).fill(null));
    setXIsNext(true);
  }

  return (
    <main className="tic-tac-toe-demo" data-route="/tic-tac-toe">
      <h1 className="tic-tac-toe-title">Tic Tac Toe in Ferrite</h1>
      <p className="tic-tac-toe-copy">
        This is the same interaction model as React’s tutorial: local component state, immutable
        updates, and conditional rendering for winner/draw status. The app logic is built in
        TypeScript, and Ferrite handles the runtime contract around it.
      </p>
      <p role="status" aria-live="polite" className="tic-tac-toe-status">
        {status}
      </p>
      <div className="tic-tac-toe-board">
        {state.map((square, index) => (
          <Square key={index} value={square} onPlay={() => playMove(index)} />
        ))}
      </div>
      <button
        type="button"
        onClick={reset}
        className="tic-tac-toe-reset"
      >
        Reset board
      </button>
    </main>
  );
}
