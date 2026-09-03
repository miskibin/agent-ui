const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function makeCode(len = 5): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export function shuffle<T>(items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A random board of `size` tiles; `size` 0 means the whole pool. */
export function pickBoard(tileIds: readonly string[], size: number): string[] {
  const picked = shuffle(tileIds);
  return size > 0 ? picked.slice(0, Math.min(size, picked.length)) : picked;
}

export const BOARD_SIZES: { size: 0 | 9 | 16 | 25; label: string }[] = [
  { size: 9, label: "3×3" },
  { size: 16, label: "4×4" },
  { size: 25, label: "5×5" },
  { size: 0, label: "Wszystkie" },
];

const NICK_KEY = "bingo:nick";
const playerKey = (code: string) => `bingo:player:${code.toUpperCase()}`;

export function loadNick(): string {
  try {
    return localStorage.getItem(NICK_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveNick(nick: string) {
  try {
    localStorage.setItem(NICK_KEY, nick);
  } catch {
    /* private mode */
  }
}

export function loadPlayerId(code: string): string | null {
  try {
    return localStorage.getItem(playerKey(code));
  } catch {
    return null;
  }
}

export function savePlayerId(code: string, id: string) {
  try {
    localStorage.setItem(playerKey(code), id);
  } catch {
    /* private mode */
  }
}

export function clearPlayerId(code: string) {
  try {
    localStorage.removeItem(playerKey(code));
  } catch {
    /* private mode */
  }
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function roomUrl(code: string): string {
  return `${location.origin}${location.pathname}#/r/${code}`;
}

export async function shareRoom(code: string, name: string) {
  const url = roomUrl(code);
  const data = { title: name, text: `Dołącz do bingo „${name}” — kod ${code}`, url };
  if (typeof navigator.share === "function") {
    try {
      await navigator.share(data);
      return "shared" as const;
    } catch {
      /* cancelled, fall through to clipboard */
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return "copied" as const;
  } catch {
    return "failed" as const;
  }
}
