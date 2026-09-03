# Bingo

Imprezowe bingo na telefon: wspólna pula haseł, każdy gracz dostaje własną losową planszę, kto pierwszy
skreśli wszystko, wygrywa. Bez logowania — tożsamość to nick zapamiętany w `localStorage` per pokój.

- **Stack:** Vite + React 19 + TypeScript, Supabase (Postgres + Realtime) jako backend.
- **Hosting:** GitHub Pages pod `https://miskibin.github.io/agent-ui/bingo/` — `.github/workflows/pages.yml`
  buduje tę apkę (`BASE_PATH=/agent-ui/bingo/`) i publikuje ją obok strony produktu. Routing jest hashowy
  (`#/r/KOD`), bo Pages nie ma SPA fallbacku. `vercel.json` zostaje na wypadek importu do Vercela
  (root directory: `bingo`).
- **Baza:** projekt Supabase `bingo` (`xonvauehqxbjavckoorx`, eu-central-1). Schemat w `supabase/schema.sql`
  (zaaplikowany jako migracje `bingo_schema` i `toggle_tile_rpc`). RLS włączone z otwartymi politykami dla
  klucza publicznego — to gra dla znajomych, nie ma kont.
- **Klucz:** `src/supabase.ts` ma wpisany URL i klucz *publishable* (jest publiczny z założenia); można je
  nadpisać przez `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`.

## Przebieg gry

1. Host tworzy grę, dostaje kod i link `#/r/<KOD>`.
2. W lobby każdy dopisuje hasła (autor lub host może usunąć). Host wybiera rozmiar planszy: 3×3 / 4×4 / 5×5
   (losowy podzbiór puli) albo „Wszystkie” (każdy gra na całej puli, a hasła można dopisywać też w trakcie —
   nowe trafiają na planszę każdego). Nie ma żadnych wbudowanych haseł, tylko te wpisane przez graczy.
3. „Rozdaj plansze i start” rozdaje plansze. Spóźnialscy losują sobie planszę sami.
4. Skreślanie to atomowe RPC `toggle_tile` — czas ukończenia nadaje baza, więc ranking jest sprawiedliwy.
5. Host może zrobić „Nową rundę”: plansze się zerują, hasła zostają.

Pokój bez hosta (zasiany z SQL) przypisuje hosta pierwszemu, kto dołączy.

## Komendy

```bash
npm install
npm run dev
npm run build     # tsc -b && vite build
```
