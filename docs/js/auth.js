// Magic-link login and team lookup through supabase-js. Browser only. Used only when not in demo mode.
import { getClient } from './sync.js';

export async function currentSession() {
  const { data } = await getClient().auth.getSession();
  return data.session;
}

/** Sends a magic link. The link returns to this page, where supabase-js picks up the session. */
export async function sendMagicLink(email) {
  const { error } = await getClient().auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${location.origin}${location.pathname}` },
  });
  if (error) throw error;
}

export async function signOut() {
  await getClient().auth.signOut();
}

/** Teams the user is a member of (from team_members, protected by RLS). */
export async function myTeams(userId) {
  const { data, error } = await getClient()
    .from('team_members')
    .select('team_id, role, teams(id, name)')
    .eq('user_id', userId);
  if (error) throw error;
  return data.map((r) => ({ id: r.team_id, name: r.teams?.name ?? 'Ekip', role: r.role }));
}

export function onAuthChange(fn) {
  return getClient().auth.onAuthStateChange((_event, session) => fn(session));
}
