-- Applied to the Supabase project "bingo" (xonvauehqxbjavckoorx) as migrations `bingo_schema`, `toggle_tile_rpc` and `board_size_all`.
create extension if not exists pgcrypto;

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  status text not null default 'lobby' check (status in ('lobby', 'playing')),
  board_size int not null default 9 check (board_size in (0, 9, 16, 25)), -- 0 = every tile in the pool
  host_id uuid,
  round int not null default 1,
  created_at timestamptz not null default now()
);

create table public.players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 24),
  board uuid[] not null default '{}',
  checked uuid[] not null default '{}',
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  unique (room_id, name)
);

create table public.tiles (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  author_id uuid references public.players(id) on delete set null,
  text text not null check (char_length(text) between 1 and 120),
  created_at timestamptz not null default now()
);

alter table public.rooms
  add constraint rooms_host_fk foreign key (host_id) references public.players(id) on delete set null;

create index players_room_idx on public.players(room_id);
create index tiles_room_idx on public.tiles(room_id);

-- Party game, no accounts: anyone with the anon key may read and write.
alter table public.rooms enable row level security;
alter table public.players enable row level security;
alter table public.tiles enable row level security;

create policy "rooms_all" on public.rooms for all to anon, authenticated using (true) with check (true);
create policy "players_all" on public.players for all to anon, authenticated using (true) with check (true);
create policy "tiles_all" on public.tiles for all to anon, authenticated using (true) with check (true);

-- Atomic toggle: the array is edited in one statement, so two fast taps can never overwrite each other,
-- and the finish timestamp comes from the database clock the moment the last tile lands.
create or replace function public.toggle_tile(p_player uuid, p_tile uuid)
returns public.players
language plpgsql
security definer
set search_path = public
as $$
declare
  row public.players;
begin
  update public.players
     set checked = case
           when p_tile = any(checked) then array_remove(checked, p_tile)
           else array_append(checked, p_tile)
         end
   where id = p_player
     and finished_at is null
     and p_tile = any(board)
  returning * into row;

  if row.id is null then
    select * into row from public.players where id = p_player;
    return row;
  end if;

  if row.board <@ row.checked then
    update public.players set finished_at = now() where id = p_player and finished_at is null
    returning * into row;
  end if;

  return row;
end;
$$;

grant execute on function public.toggle_tile(uuid, uuid) to anon, authenticated;

alter publication supabase_realtime add table public.rooms, public.players, public.tiles;
