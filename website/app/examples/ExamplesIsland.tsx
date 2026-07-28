"use client";

import { useState } from "@ferrite/runtime";
import { getStatus, getWinner, type Cell } from "./game.js";

function DataProbe() {
  const [state, setState] = useState("idle");
  const [message, setMessage] = useState("No request yet.");
  async function request(path: string) { setState("loading"); setMessage(`GET ${path}`); try { const response = await fetch(path); if (!response.ok) throw new Error(`HTTP ${response.status}`); const body = await response.json() as { message: string }; setState("success"); setMessage(body.message); } catch (error) { setState("error"); setMessage(error instanceof Error ? error.message : "Unknown request error"); } }
  return <article className="demo-card"><h3>Data / loading / error / retry</h3><p className="demo-status" role="status" aria-live="polite">{state}: {message}</p><div className="demo-row"><button type="button" onClick={() => request("/demo-data.json")}>Fetch same-origin data</button><button className="secondary" type="button" onClick={() => request("/demo-data-missing.json")}>Fetch intentional 404</button><button className="secondary" type="button" onClick={() => request("/demo-data.json")}>Retry</button></div></article>;
}

function TodoForm() {
  const [items, setItems] = useState(["Inspect the artifact", "Read the limits"]);
  const [value, setValue] = useState("");
  function addItem() { const trimmed = value.trim(); if (!trimmed) return; setItems([...items, trimmed]); setValue(""); }
  return <article className="demo-card"><h3>Todo + form state</h3><form onSubmit={(event: { preventDefault: () => void }) => { event.preventDefault(); addItem(); }}><div className="demo-row"><input aria-label="New todo" value={value} onInput={(event: { target: { value: string } }) => setValue(event.target.value)} placeholder="Add a task"/><button type="submit">Add</button></div></form><ul className="todo-list">{items.map((item) => <li key={item}><label><input type="checkbox"/> {item}</label></li>)}</ul></article>;
}

function TicTacToe() {
  const [board, setBoard] = useState<Cell[]>(Array(9).fill(null)); const gameWinner = getWinner(board); const draw = !gameWinner && board.every(Boolean); const next = board.filter(Boolean).length % 2 === 0 ? "X" : "O";
  return <article className="demo-card"><h3>Tic-Tac-Toe</h3><p className="demo-status" role="status" aria-live="polite">{getStatus(board)}</p><div className="board">{board.map((cell, index) => <button type="button" key={index} aria-label={`Square ${index + 1}, ${cell ?? "empty"}`} onClick={() => { if (board[index] || gameWinner || draw) return; const nextBoard = [...board]; nextBoard[index] = next; setBoard(nextBoard); }}>{cell}</button>)}</div><button className="secondary" type="button" onClick={() => setBoard(Array(9).fill(null))}>Reset</button></article>;
}

export default function ExamplesIsland() {
  const [count, setCount] = useState(0);
  return <div className="demo-grid"><article className="demo-card"><h3>Counter island</h3><p>State lives in the browser; the server receives only serializable props.</p><div className="demo-row"><strong aria-live="polite">Count: {count}</strong><button type="button" onClick={() => setCount(count + 1)}>Increment</button><button className="secondary" type="button" onClick={() => setCount(0)}>Reset</button></div></article><TodoForm/><DataProbe/><article className="demo-card"><h3>Routing + navigation</h3><p>These ordinary anchors are real Ferrite routes; deep links are handled by the artifact server.</p><div className="demo-row"><a className="button" href="/docs/architecture">Architecture</a><a className="button" href="/blog/tic-tac-toe">Blog walkthrough</a><a className="button" href="/compare">Comparison</a></div></article><article className="demo-card"><h3>Component composition</h3><p>A page composes <code>ExamplesIsland</code>, <code>TodoForm</code>, <code>DataProbe</code>, and <code>TicTacToe</code> without a framework shim.</p><span className="status available">Available</span></article><article className="demo-card"><h3>TypeScript boundary</h3><p>Typed unions model board cells and request states. Ferrite validates the rendered tree and client reference props.</p><pre className="code">type Cell = "X" | "O" | null;</pre></article><TicTacToe/><article className="demo-card"><h3>Integrations</h3><p><span className="status experimental">Experimental</span> Small libraries such as date-fns, zod, clsx, or Three.js should be added only after a source-build check and browser proof. This page intentionally has no unverified dependency claim.</p></article></div>;
}
