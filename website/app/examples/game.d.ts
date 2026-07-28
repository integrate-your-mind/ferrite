export type Cell = "X" | "O" | null;
export declare const winningLines: ReadonlyArray<ReadonlyArray<number>>;
export declare function getWinner(board: Cell[]): Cell;
export declare function getStatus(board: Cell[]): string;
