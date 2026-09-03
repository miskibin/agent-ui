import { createClient } from "@supabase/supabase-js";

// The anon key is public by design (row access is governed by RLS on the server).
const url = import.meta.env.VITE_SUPABASE_URL ?? "https://xonvauehqxbjavckoorx.supabase.co";
const key =
  import.meta.env.VITE_SUPABASE_ANON_KEY ?? "sb_publishable_i_NslV3Rn9NwuHv2cR8FnA_63toHjY9";

export const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
