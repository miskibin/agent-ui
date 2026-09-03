export type RoomStatus = "lobby" | "playing";

export interface Room {
  id: string;
  code: string;
  name: string;
  status: RoomStatus;
  /** 0 = every tile in the pool (and the pool may grow mid-game). */
  board_size: 0 | 9 | 16 | 25;
  host_id: string | null;
  round: number;
  created_at: string;
}

export interface Player {
  id: string;
  room_id: string;
  name: string;
  board: string[];
  checked: string[];
  finished_at: string | null;
  created_at: string;
}

export interface Tile {
  id: string;
  room_id: string;
  author_id: string | null;
  text: string;
  created_at: string;
}
