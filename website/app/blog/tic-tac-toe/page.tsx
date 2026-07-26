const demoRoute = "/tic-tac-toe";

export const metadata = {
  title: "Ferrite Tic Tac Toe | Ferrite Blog",
  description:
    "A Ferrite walk-through modeled after the React Tic Tac Toe tutorial, using the same interactive game loop with Ferrite runtime primitives.",
  alternates: {
    canonical: "/blog/tic-tac-toe",
  },
};

export default function BlogTicTacToePost() {
  return (
    <article style={{ maxWidth: 900, margin: "0 auto", padding: "120px 22px 92px" }}>
      <div className="kicker">Demo Walkthrough</div>
      <h1 style={{ marginTop: "0.4rem", marginBottom: "0.8rem" }}>Build a Tic Tac Toe app in Ferrite</h1>
      <p style={{ color: "#4b5563", lineHeight: 1.6 }}>
        This is a practical, step-by-step copy of the React tutorial flow using Ferrite instead of
        React APIs. Same mechanics, same state model, different runtime guarantees.
      </p>

      <section aria-labelledby="who" style={{ marginTop: "2rem" }}>
        <h2 id="who">Who this is for</h2>
        <ul>
          <li>Developers evaluating Ferrite as a React-like runtime.</li>
          <li>People comparing local state behavior and predictable serialized props.</li>
          <li>Teams building interactive TypeScript demos with Rust-backed execution.</li>
        </ul>
      </section>

      <section aria-labelledby="import-ferrite" style={{ marginTop: "2rem" }}>
        <h2 id="import-ferrite">Step 1: import from Ferrite</h2>
        <p>
          In Ferrite route components, use <code>@ferrite/runtime</code> for client hooks:
        </p>
        <pre
          style={{
            background: "#111827",
            color: "#e5e7eb",
            padding: "1rem",
            borderRadius: 6,
            overflowX: "auto",
          }}
        >
          <code>{`import { useState } from "@ferrite/runtime";`}</code>
        </pre>
        <p>
          Unlike React demos that import from <code>react</code>, Ferrite keeps interaction within its own
          runtime module graph and serialization model.
        </p>
      </section>

      <section aria-labelledby="step-board" style={{ marginTop: "2rem" }}>
        <h2 id="step-board">Step 2: define board state</h2>
        <p>Set up the state shapes once:</p>
        <pre
          style={{
            background: "#111827",
            color: "#e5e7eb",
            padding: "1rem",
            borderRadius: 6,
            overflowX: "auto",
          }}
        >
          <code>{`type SquareValue = "X" | "O" | null;
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
];`}</code>
        </pre>
      </section>

      <section aria-labelledby="step-square" style={{ marginTop: "2rem" }}>
        <h2 id="step-square">Step 3: create a reusable Square</h2>
        <p>Each square receives a value and an action callback:</p>
        <pre
          style={{
            background: "#111827",
            color: "#e5e7eb",
            padding: "1rem",
            borderRadius: 6,
            overflowX: "auto",
          }}
        >
          <code>{`function Square({ value, onPlay }: { value: SquareValue; onPlay: () => void }) {
  return (
    <button type="button" className="ferrite-tictactoe-square" onClick={onPlay}>
      {value}
    </button>
  );
}`}</code>
        </pre>
      </section>

      <section aria-labelledby="step-move" style={{ marginTop: "2rem" }}>
        <h2 id="step-move">Step 4: immutable move updates</h2>
        <p>Copy state before writing, then flip turns:</p>
        <pre
          style={{
            background: "#111827",
            color: "#e5e7eb",
            padding: "1rem",
            borderRadius: 6,
            overflowX: "auto",
          }}
        >
          <code>{`function playMove(index: number) {
  if (winner || state[index] !== null) {
    return;
  }

  const nextState = [...state];
  nextState[index] = next;
  setState(nextState);
  setXIsNext(!xIsNext);
}`}</code>
        </pre>
      </section>

      <section aria-labelledby="step-winner" style={{ marginTop: "2rem" }}>
        <h2 id="step-winner">Step 5: winner and draw state</h2>
        <pre
          style={{
            background: "#111827",
            color: "#e5e7eb",
            padding: "1rem",
            borderRadius: 6,
            overflowX: "auto",
          }}
        >
          <code>{`function getWinner(squares: BoardState): SquareValue {
  for (const [a, b, c] of lines) {
    if (squares[a] !== null && squares[a] === squares[b] && squares[b] === squares[c]) {
      return squares[a];
    }
  }
  return null;
}`}</code>
        </pre>
        <p>UI status is derived from computed state:</p>
        <pre
          style={{
            background: "#111827",
            color: "#e5e7eb",
            padding: "1rem",
            borderRadius: 6,
            overflowX: "auto",
          }}
        >
          <code>{`const winner = getWinner(state);
const draw = winner === null && state.every((square) => square !== null);
const next = xIsNext ? "X" : "O";
const status = winner ? "Winner: " + winner : draw ? "Draw" : "Next player: " + next;`}</code>
        </pre>
      </section>

      <section aria-labelledby="step-style" style={{ marginTop: "2rem" }}>
        <h2 id="step-style">Step 6: wire styles in CSS</h2>
        <p>
          Because Ferrite server rendering requires serializable props, keep layout styles in
          <code>examples/basic/app/tic-tac-toe/page.css</code> and keep JSX class names in code.
        </p>
        <pre
          style={{
            background: "#111827",
            color: "#e5e7eb",
            padding: "1rem",
            borderRadius: 6,
            overflowX: "auto",
          }}
        >
          <code>{`import "./page.css";`}</code>
        </pre>
      </section>

      <section aria-labelledby="step-visuals" style={{ marginTop: "2rem" }}>
        <h2 id="step-visuals">Step 7: visual checkpoints</h2>
        <figure style={{ margin: "1rem 0" }}>
          <img
            src="/demos/tic-tac-toe-step-1-start.png"
            alt="Ferrite Tic Tac Toe initial board"
            style={{ width: "100%", maxWidth: "740px", borderRadius: 8, border: "1px solid #d1d5db" }}
          />
          <figcaption>Initial state (blank board).</figcaption>
        </figure>
        <figure style={{ margin: "1rem 0" }}>
          <img
            src="/demos/tic-tac-toe-step-2-first-move.png"
            alt="Ferrite Tic Tac Toe after first move"
            style={{ width: "100%", maxWidth: "740px", borderRadius: 8, border: "1px solid #d1d5db" }}
          />
          <figcaption>First move updates state and status.</figcaption>
        </figure>
        <figure style={{ margin: "1rem 0" }}
          >
          <img
            src="/demos/tic-tac-toe-step-3-x-wins.png"
            alt="Ferrite Tic Tac Toe showing X win"
            style={{ width: "100%", maxWidth: "740px", borderRadius: 8, border: "1px solid #d1d5db" }}
          />
          <figcaption>Win line found and status becomes winner.</figcaption>
        </figure>
        <figure style={{ margin: "1rem 0" }}>
          <img
            src="/demos/tic-tac-toe-step-4-reset.png"
            alt="Ferrite Tic Tac Toe reset state"
            style={{ width: "100%", maxWidth: "740px", borderRadius: 8, border: "1px solid #d1d5db" }}
          />
          <figcaption>Reset restores a clean board and next player.</figcaption>
        </figure>
      </section>

      <section aria-labelledby="step-run" style={{ marginTop: "2rem" }}>
        <h2 id="step-run">Step 8: run the demo locally</h2>
        <pre
          style={{
            background: "#111827",
            color: "#e5e7eb",
            padding: "1rem",
            borderRadius: 6,
            overflowX: "auto",
          }}
        >
          <code>{`pnpm build:example
cargo run -p ferrite-cli -- dev --project examples/basic --request-path /tic-tac-toe`}</code>
        </pre>
        <p>Then open <code>{demoRoute}</code> in your Ferrite server.</p>
      </section>

      <section aria-labelledby="full-source" style={{ marginTop: "2rem" }}>
        <h2 id="full-source">Full source</h2>
        <pre
          style={{
            background: "#111827",
            color: "#e5e7eb",
            padding: "1rem",
            borderRadius: 6,
            overflowX: "auto",
          }}
        >
          <code>{`"use client";

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

function getWinner(squares: BoardState): SquareValue {
  for (const [a, b, c] of lines) {
    if (squares[a] !== null && squares[a] === squares[b] && squares[b] === squares[c]) {
      return squares[a];
    }
  }
  return null;
}

function Square({ value, onPlay }: { value: SquareValue; onPlay: () => void }) {
  return (
    <button type="button" className="ferrite-tictactoe-square" onClick={onPlay}>
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
  const status = winner ? "Winner: " + winner : draw ? "Draw" : "Next player: " + next;

  function playMove(index: number) {
    if (winner || state[index] !== null) {
      return;
    }

    const nextState = [...state];
    nextState[index] = next;
    setState(nextState);
    setXIsNext(!xIsNext);
  }

  return (
    <main className="tic-tac-toe-demo" data-route="/tic-tac-toe">
      <h1>Tic Tac Toe in Ferrite</h1>
      <p aria-live="polite" role="status">{status}</p>
      <div className="tic-tac-toe-board">
        {state.map((square, index) => (
          <Square key={index} value={square} onPlay={() => playMove(index)} />
        ))}
      </div>
      <button
        type="button"
        onClick={() => {
          setState(Array(9).fill(null));
          setXIsNext(true);
        }}
        className="tic-tac-toe-reset"
      >
        Reset board
      </button>
    </main>
  );
}`}</code>
        </pre>
      </section>

      <section aria-labelledby="run-next" style={{ marginTop: "2rem" }}>
        <h2 id="run-next">Run through this post like a tutorial</h2>
        <ol>
          <li>Read one step at a time.</li>
          <li>Apply only that snippet to <code>examples/basic/app/tic-tac-toe/page.tsx</code>.</li>
          <li>Re-run the local serve command after each change.</li>
          <li>Match each screenshot against the expected visual state.</li>
        </ol>
      </section>
    </article>
  );
}
