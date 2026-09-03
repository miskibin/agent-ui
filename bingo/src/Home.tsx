import { useState, type FormEvent } from "react";
import { supabase } from "./supabase";
import { loadNick, makeCode, pickBoard, saveNick, savePlayerId } from "./lib";
import { navigate } from "./router";
import type { Room } from "./types";

export function Home() {
  const [nick, setNick] = useState(loadNick);
  const [gameName, setGameName] = useState("Bingo o Tomaszu");
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get("code") ?? "");
  const [busy, setBusy] = useState<"create" | "join" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const trimmedNick = nick.trim();

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!trimmedNick || busy) return;
    setBusy("create");
    setError(null);
    try {
      saveNick(trimmedNick);
      let room: Room | null = null;
      for (let attempt = 0; attempt < 5 && !room; attempt++) {
        const { data, error } = await supabase
          .from("rooms")
          .insert({ code: makeCode(), name: gameName.trim() || "Bingo" })
          .select()
          .single();
        if (error && error.code !== "23505") throw error;
        room = data;
      }
      if (!room) throw new Error("Nie udało się wylosować kodu");
      const { data: player, error: pErr } = await supabase
        .from("players")
        .insert({ room_id: room.id, name: trimmedNick })
        .select()
        .single();
      if (pErr) throw pErr;
      await supabase.from("rooms").update({ host_id: player.id }).eq("id", room.id);
      savePlayerId(room.code, player.id);
      navigate(`/r/${room.code}`);
    } catch (err) {
      setError(message(err));
      setBusy(null);
    }
  }

  async function join(e: FormEvent) {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (!trimmedNick || !c || busy) return;
    setBusy("join");
    setError(null);
    try {
      saveNick(trimmedNick);
      const { data: room, error: rErr } = await supabase.from("rooms").select("*").eq("code", c).maybeSingle();
      if (rErr) throw rErr;
      if (!room) throw new Error("Nie ma gry o takim kodzie");
      await joinRoom(room, trimmedNick);
      navigate(`/r/${room.code}`);
    } catch (err) {
      setError(message(err));
      setBusy(null);
    }
  }

  return (
    <main className="page home">
      <header className="hero">
        <div className="hero-emoji">🎯</div>
        <h1>Bingo</h1>
        <p>Wspólna pula haseł, każdy ma swoją planszę. Kto pierwszy skreśli wszystko, wygrywa.</p>
      </header>

      <label className="field">
        <span>Twój nick</span>
        <input
          value={nick}
          onChange={(e) => setNick(e.target.value)}
          placeholder="np. Kasia"
          maxLength={24}
          autoComplete="nickname"
          enterKeyHint="next"
        />
      </label>

      <form className="card" onSubmit={create}>
        <h2>Nowa gra</h2>
        <label className="field">
          <span>Nazwa</span>
          <input value={gameName} onChange={(e) => setGameName(e.target.value)} maxLength={60} />
        </label>
        <button className="btn primary" disabled={!trimmedNick || busy !== null}>
          {busy === "create" ? "Tworzę…" : "Stwórz grę"}
        </button>
      </form>

      <form className="card" onSubmit={join}>
        <h2>Dołącz do gry</h2>
        <label className="field">
          <span>Kod gry</span>
          <input
            className="code-input"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABC12"
            maxLength={8}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
          />
        </label>
        <button className="btn" disabled={!trimmedNick || !code.trim() || busy !== null}>
          {busy === "join" ? "Dołączam…" : "Dołącz"}
        </button>
      </form>

      {error && <p className="error">{error}</p>}
    </main>
  );
}

/** Creates the player row for `nick` in `room`; the first player of a hostless (seeded) room becomes its host. */
export async function joinRoom(room: Room, nick: string): Promise<string> {
  let board: string[] = [];
  if (room.status === "playing") {
    const { data: tiles } = await supabase.from("tiles").select("id").eq("room_id", room.id);
    board = pickBoard((tiles ?? []).map((t) => t.id), room.board_size);
  }
  const { data, error } = await supabase
    .from("players")
    .insert({ room_id: room.id, name: nick, board })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") throw new Error("Ktoś już gra pod tym nickiem — wybierz inny");
    throw error;
  }
  if (!room.host_id) {
    await supabase.from("rooms").update({ host_id: data.id }).eq("id", room.id).is("host_id", null);
  }
  savePlayerId(room.code, data.id);
  return data.id;
}

export function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err && "message" in err) return String((err as { message: unknown }).message);
  return "Coś poszło nie tak";
}
