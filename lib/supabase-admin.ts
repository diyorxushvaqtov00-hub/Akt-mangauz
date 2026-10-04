import { createClient } from "@supabase/supabase-js";
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Supabase server environment is not configured.");
export const supabaseAdmin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
