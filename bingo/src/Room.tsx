import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { supabase } from "./supabase";
import { joinRoom, message } from "./Home";
import { clearPlayerId, formatTime, loadNick, loadPlayerId, pickBoard, saveNick, shareRoom } from "./lib";
import { navigate } from "./router";
import type { Player, Room as RoomRow, Tile } from "./types";

type Toast = { text: string; kind?: "ok" | "error" };

export function Room({ code }: { code: string }) {
  const [room, setRoom] = useState<RoomRow | null | undefined>(undefined);
  const [players, setPlayers] = useState<Player[]>([]);
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [playerId, setPlayerId] = useState<string | null>(() => loadPlayerId(code));
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const [fetchedAt, setFetchedAt] = useState(0);
  const playerSetAt = useRef(0);

  const notify = useCallback((text: string, kind: Toast["kind"] = "ok") => {
    setToast({ text, kind });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  const mutatedAt = useRef(0);
  const refresh = useCallback(async () => {
    const startedAt = Date.now();
    const { data: r, error } = await supabase.from("rooms").select("*").eq("code", code).maybeSingle();
    if (error) return;
    if (!r) {
      setRoom(null);
      return;
    }
    const [{ data: ps }, { data: ts }] = await Promise.all([
      supabase.from("players").select("*").eq("room_id", r.id).order("created_at"),
      supabase.from("tiles").select("*").eq("room_id", r.id).order("created_at"),
    ]);
    setRoom(r);
    setPlayers((prev) => {
      const fresh = ps ?? [];
      if (mutatedAt.current <= startedAt) return fresh;
      // My own row changed while this fetch was in flight: keep the newer local copy.
      const mine = prev.find((p) => p.id === playerId);
      return mine ? fresh.map((p) => (p.id === mine.id ? mine : p)) : fresh;
    });
    setTiles(ts ?? []);
    setFetchedAt(Date.now());
  }, [code, playerId]);

  const onJoined = useCallback(
    async (id: string) => {
      await refresh();
      playerSetAt.current = Date.now();
      setPlayerId(id);
    },
    [refresh],
  );

  // Initial load, polling fallback and refresh when the tab comes back.
  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 8000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  // Realtime: any change in this room's rows triggers a refetch.
  const roomId = room?.id;
  useEffect(() => {
    if (!roomId) return;
    const channel = supabase
      .channel(`room-${roomId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: `id=eq.${roomId}` }, () => void refresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "players", filter: `room_id=eq.${roomId}` }, () => void refresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "tiles", filter: `room_id=eq.${roomId}` }, () => void refresh())
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [roomId, refresh]);

  const me = useMemo(() => players.find((p) => p.id === playerId) ?? null, [players, playerId]);

  // A stored player id that no longer exists (deleted room/player) → back to the nick form.
  // Only trusted once the list was fetched after the id was set, so a join never races its own refresh.
  useEffect(() => {
    if (room && playerId && !me && fetchedAt > playerSetAt.current) {
      clearPlayerId(code);
      queueMicrotask(() => setPlayerId(null));
    }
  }, [room, playerId, me, code, fetchedAt]);

  // Late joiner or a race at start: deal myself a board when the game is running and I have none.
  const dealing = useRef(false);
  useEffect(() => {
    if (!room || room.status !== "playing" || !me || me.board.length > 0 || tiles.length === 0 || dealing.current) return;
    dealing.current = true;
    const board = pickBoard(tiles.map((t) => t.id), room.board_size);
    void supabase
      .from("players")
      .update({ board, checked: [], finished_at: null })
      .eq("id", me.id)
      .then(() => {
        dealing.current = false;
        void refresh();
      });
  }, [room, me, tiles, refresh]);

  if (room === undefined) return <main className="page center"><p className="muted">Ładuję…</p></main>;
  if (room === null) {
    return (
      <main className="page center">
        <h1>Nie ma takiej gry</h1>
        <p className="muted">Kod <b>{code}</b> nic nie znalazł.</p>
        <button className="btn" onClick={() => navigate("/")}>Wróć</button>
      </main>
    );
  }

  if (!me) {
    return <JoinForm room={room} onJoined={onJoined} />;
  }

  const isHost = room.host_id === me.id;

  return (
    <main className="page room">
      <header className="room-head">
        <div>
          <h1>{room.name}</h1>
          <p className="muted">
            kod <b className="code">{room.code}</b> · runda {room.round} · {me.name}{isHost ? " (host)" : ""}
          </p>
        </div>
        <button
          className="btn small"
          onClick={async () => {
            const r = await shareRoom(room.code, room.name);
            notify(r === "copied" ? "Link skopiowany" : r === "failed" ? "Nie udało się skopiować" : "Udostępniono");
          }}
        >
          Zaproś
        </button>
      </header>

      {room.status === "lobby" ? (
        <Lobby room={room} me={me} players={players} tiles={tiles} isHost={isHost} notify={notify} refresh={refresh} />
      ) : (
        <Game
          room={room}
          me={me}
          players={players}
          tiles={tiles}
          isHost={isHost}
          notify={notify}
          refresh={refresh}
          applyMe={(row) => {
            mutatedAt.current = Date.now();
            setPlayers((ps) => ps.map((p) => (p.id === row.id ? row : p)));
          }}
        />
      )}

      <footer className="room-foot">
        <button
          className="link"
          onClick={() => {
            clearPlayerId(code);
            setPlayerId(null);
          }}
        >
          Zmień nick
        </button>
        <button className="link" onClick={() => navigate("/")}>Strona główna</button>
      </footer>

      {toast && <div className={`toast ${toast.kind ?? "ok"}`}>{toast.text}</div>}
    </main>
  );
}

function JoinForm({ room, onJoined }: { room: RoomRow; onJoined: (id: string) => Promise<void> }) {
  const [nick, setNick] = useState(loadNick);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const n = nick.trim();
    if (!n || busy) return;
    setBusy(true);
    setError(null);
    try {
      saveNick(n);
      await onJoined(await joinRoom(room, n));
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  return (
    <main className="page center">
      <div className="hero">
        <div className="hero-emoji">🎯</div>
        <h1>{room.name}</h1>
        <p className="muted">kod <b className="code">{room.code}</b></p>
      </div>
      <form className="card" onSubmit={submit}>
        <label className="field">
          <span>Twój nick</span>
          <input value={nick} onChange={(e) => setNick(e.target.value)} placeholder="np. Kasia" maxLength={24} autoFocus enterKeyHint="go" />
        </label>
        <button className="btn primary" disabled={!nick.trim() || busy}>
          {busy ? "Dołączam…" : "Dołącz"}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </main>
  );
}

interface ViewProps {
  room: RoomRow;
  me: Player;
  players: Player[];
  tiles: Tile[];
  isHost: boolean;
  notify: (text: string, kind?: Toast["kind"]) => void;
  refresh: () => Promise<void>;
}

function Lobby({ room, me, players, tiles, isHost, notify, refresh }: ViewProps) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const names = useMemo(() => new Map(players.map((p) => [p.id, p.name])), [players]);

  async function addTile(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    const { error } = await supabase.from("tiles").insert({ room_id: room.id, author_id: me.id, text: t });
    setBusy(false);
    if (error) return notify(message(error), "error");
    setText("");
    void refresh();
  }

  async function removeTile(tile: Tile) {
    const { error } = await supabase.from("tiles").delete().eq("id", tile.id);
    if (error) return notify(message(error), "error");
    void refresh();
  }

  async function setSize(size: number) {
    await supabase.from("rooms").update({ board_size: size }).eq("id", room.id);
    void refresh();
  }

  async function start() {
    if (tiles.length === 0) return notify("Dodajcie najpierw jakieś hasła", "error");
    if (tiles.length < room.board_size && !confirm(`Jest tylko ${tiles.length} haseł, plansze będą mniejsze niż ${room.board_size}. Startować?`)) return;
    setBusy(true);
    const ids = tiles.map((t) => t.id);
    try {
      await Promise.all(
        players.map((p) =>
          supabase.from("players").update({ board: pickBoard(ids, room.board_size), checked: [], finished_at: null }).eq("id", p.id),
        ),
      );
      const { error } = await supabase.from("rooms").update({ status: "playing" }).eq("id", room.id);
      if (error) throw error;
      void refresh();
    } catch (err) {
      notify(message(err), "error");
    } finally {
      setBusy(false);
    }
  }

  const mine = tiles.filter((t) => t.author_id === me.id).length;

  return (
    <>
      <section className="card">
        <h2>Hasła <span className="count">{tiles.length}</span></h2>
        <p className="muted">Każdy dopisuje, co może się dziś wydarzyć. Plansze losują się ze wspólnej puli.</p>
        <form className="row" onSubmit={addTile}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="np. ściągnie koszulkę"
            maxLength={120}
            enterKeyHint="send"
          />
          <button className="btn primary" disabled={!text.trim() || busy}>Dodaj</button>
        </form>
        {tiles.length === 0 ? (
          <p className="muted empty">Jeszcze pusto. Ty pierwszy/a!</p>
        ) : (
          <ul className="tiles">
            {tiles.map((t) => (
              <li key={t.id}>
                <span className="tile-text">{t.text}</span>
                <span className="tile-meta">
                  {t.author_id ? names.get(t.author_id) ?? "?" : "startowe"}
                  {(t.author_id === me.id || isHost) && (
                    <button className="x" aria-label="Usuń" onClick={() => void removeTile(t)}>×</button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {mine === 0 && tiles.length > 0 && <p className="muted">Nie dodałeś/aś jeszcze nic.</p>}
      </section>

      <section className="card">
        <h2>Gracze <span className="count">{players.length}</span></h2>
        <ul className="players">
          {players.map((p) => (
            <li key={p.id}>
              {p.name}
              {p.id === room.host_id && <span className="tag">host</span>}
              {p.id === me.id && <span className="tag me">ty</span>}
            </li>
          ))}
        </ul>
      </section>

      {isHost ? (
        <section className="card host">
          <h2>Start</h2>
          <div className="sizes" role="radiogroup" aria-label="Rozmiar planszy">
            {[9, 16, 25].map((s) => (
              <button
                key={s}
                role="radio"
                aria-checked={room.board_size === s}
                className={`chip${room.board_size === s ? " on" : ""}`}
                onClick={() => void setSize(s)}
              >
                {Math.sqrt(s)}×{Math.sqrt(s)}
              </button>
            ))}
          </div>
          <p className="muted">Każdy dostanie {Math.min(room.board_size, tiles.length) || room.board_size} losowych haseł z {tiles.length}.</p>
          <button className="btn primary big" disabled={busy || tiles.length === 0} onClick={() => void start()}>
            {busy ? "Rozdaję…" : "Rozdaj plansze i start"}
          </button>
        </section>
      ) : (
        <p className="muted center-text">Czekamy aż {players.find((p) => p.id === room.host_id)?.name ?? "host"} wystartuje grę.</p>
      )}
    </>
  );
}

function Game({ room, me, players, tiles, isHost, notify, refresh, applyMe }: ViewProps & { applyMe: (row: Player) => void }) {
  const tileById = useMemo(() => new Map(tiles.map((t) => [t.id, t])), [tiles]);
  const board = me.board.filter((id) => tileById.has(id));
  const checked = new Set(me.checked);
  const done = board.filter((id) => checked.has(id)).length;
  const cols = board.length > 16 ? 5 : board.length > 9 ? 4 : 3;
  const [busy, setBusy] = useState(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const wasFinished = useRef(Boolean(me.finished_at));

  const ranking = useMemo(() => rank(players), [players]);
  const finished = ranking.filter((p) => p.finished_at);
  const winner = finished[0];
  const myPlace = finished.findIndex((p) => p.id === me.id) + 1;

  function toggle(tileId: string) {
    if (me.finished_at) return;
    const turningOn = !checked.has(tileId);
    const willFinish = turningOn && board.every((id) => id === tileId || checked.has(id));
    if (willFinish && !confirm("Ostatnie hasło! Ogłosić BINGO?")) return;
    // Optimistic flip; the server answers with the row as it really is.
    applyMe({ ...me, checked: turningOn ? [...me.checked, tileId] : me.checked.filter((id) => id !== tileId) });
    queue.current = queue.current.then(async () => {
      const { data, error } = await supabase.rpc("toggle_tile", { p_player: me.id, p_tile: tileId });
      if (error || !data) {
        notify(error ? message(error) : "Nie udało się zapisać", "error");
        void refresh();
        return;
      }
      const row = data as Player;
      applyMe(row);
      if (row.finished_at && !wasFinished.current) {
        wasFinished.current = true;
        notify("BINGO! 🎉");
      }
    });
  }

  async function newRound() {
    if (!confirm("Nowa runda? Plansze i skreślenia się wyzerują, hasła zostają.")) return;
    setBusy(true);
    try {
      await Promise.all(players.map((p) => supabase.from("players").update({ board: [], checked: [], finished_at: null }).eq("id", p.id)));
      await supabase.from("rooms").update({ status: "lobby", round: room.round + 1 }).eq("id", room.id);
      void refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {winner && (
        <div className={`banner${winner.id === me.id ? " mine" : ""}`}>
          🏆 <b>{winner.name}</b> ma BINGO{finished.length > 1 ? ` (${finished.length} osób skończyło)` : ""}
          {myPlace > 0 && winner.id !== me.id && <span> · ty {myPlace}.</span>}
        </div>
      )}

      {board.length === 0 ? (
        <p className="muted center-text">Losuję twoją planszę…</p>
      ) : (
        <>
          <div className="progress" aria-label="Postęp">
            <div className="progress-bar" style={{ width: `${(done / board.length) * 100}%` }} />
            <span>{done} / {board.length}</span>
          </div>
          <div className={`board cols-${cols}${me.finished_at ? " locked" : ""}`}>
            {board.map((id) => {
              const on = checked.has(id);
              return (
                <button
                  key={id}
                  className={`cell${on ? " on" : ""}`}
                  aria-pressed={on}
                  onClick={() => toggle(id)}
                >
                  <span>{tileById.get(id)!.text}</span>
                </button>
              );
            })}
          </div>
        </>
      )}

      <section className="card">
        <h2>Ranking</h2>
        <ol className="ranking">
          {ranking.map((p, i) => {
            const size = p.board.length;
            const n = p.checked.filter((id) => p.board.includes(id)).length;
            return (
              <li key={p.id} className={p.id === me.id ? "me" : ""}>
                <span className="pos">{p.finished_at ? medal(finished.indexOf(p)) : `${i + 1}.`}</span>
                <span className="name">{p.name}</span>
                <span className="score">
                  {p.finished_at ? formatTime(p.finished_at) : size ? `${n}/${size}` : "—"}
                </span>
              </li>
            );
          })}
        </ol>
      </section>

      {isHost && (
        <button className="btn" disabled={busy} onClick={() => void newRound()}>
          Nowa runda (wróć do lobby)
        </button>
      )}
    </>
  );
}

function rank(players: Player[]): Player[] {
  const progress = (p: Player) => (p.board.length ? p.checked.filter((id) => p.board.includes(id)).length / p.board.length : 0);
  return players.slice().sort((a, b) => {
    if (a.finished_at && b.finished_at) return a.finished_at.localeCompare(b.finished_at);
    if (a.finished_at) return -1;
    if (b.finished_at) return 1;
    return progress(b) - progress(a) || a.name.localeCompare(b.name);
  });
}

function medal(i: number): string {
  return ["🥇", "🥈", "🥉"][i] ?? `${i + 1}.`;
}
