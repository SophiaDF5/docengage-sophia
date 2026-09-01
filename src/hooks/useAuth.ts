import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { queryClient } from "../lib/queryClient";
import type { User, Session } from "@supabase/supabase-js";

// Module-level, not per-hook-instance, on purpose: useAuth() is called
// independently from several components (AuthGuard, AppRoutes, AppLayout,
// Login), each with its own onAuthStateChange subscription. Tracking the
// last known user id at module scope means the cache only gets cleared
// once per actual account change, no matter how many of those instances
// are mounted. `undefined` = "haven't seen the first auth event yet",
// which keeps app boot from triggering a pointless clear of an empty cache.
let lastUserId: string | null | undefined = undefined;

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
      if (lastUserId === undefined) lastUserId = session?.user?.id ?? null;
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      const newUserId = session?.user?.id ?? null;

      // Wipe every cached query the moment the logged-in account changes
      // (sign-out, or signing in as a different account). Without this,
      // React Query's staleTime (60s) can keep showing the PREVIOUS
      // account's cached organization/leads data to whoever is now signed
      // in until something forces a refetch — a real cross-account data
      // leak in the UI, even though the database itself was always
      // correctly scoped by RLS. This must never be visible, even briefly.
      if (lastUserId !== undefined && newUserId !== lastUserId) {
        queryClient.clear();
      }
      lastUserId = newUserId;

      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  };

  const signOut = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  };

  return { user, session, loading, signIn, signOut };
}
