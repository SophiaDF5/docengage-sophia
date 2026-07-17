import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// A throw here used to happen at module-evaluation time, before React ever
// mounts — an ErrorBoundary can't catch that, so a missing env var (e.g. a
// Netlify/Vercel build where the site's env vars weren't configured) meant
// a permanent blank white screen with no message anywhere. Instead, flag it
// and let App.tsx render a real, visible configuration error.
export const supabaseConfigError =
  !supabaseUrl || !supabaseAnonKey
    ? "Missing Supabase environment variables (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY). Check the build's environment configuration."
    : null;

export const supabase = createClient(
  supabaseUrl || "https://placeholder.invalid",
  supabaseAnonKey || "placeholder"
);
