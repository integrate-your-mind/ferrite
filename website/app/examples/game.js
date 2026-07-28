export const winningLines = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

export function getWinner(board) {
  for (const [a, b, c] of winningLines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  return null;
}

export function getStatus(board) {
  const gameWinner = getWinner(board);
  if (gameWinner) return `Winner: ${gameWinner}`;
  if (board.every(Boolean)) return "Draw";
  return `Next player: ${board.filter(Boolean).length % 2 === 0 ? "X" : "O"}`;
}
