// Config checks. Pure module.

const PLACEHOLDER_URL = 'YOUR-PROJECT';
const PLACEHOLDER_KEY = 'YOUR-ANON-KEY';

/**
 * Demo mode when DEMO_MODE is true, or when the Supabase values are still placeholders.
 * In demo mode the app is local only (IndexedDB), with no login and no network sync.
 */
export function isDemoMode(cfg) {
  if (!cfg || cfg.DEMO_MODE === true) return true;
  const url = String(cfg.SUPABASE_URL ?? '');
  const key = String(cfg.SUPABASE_ANON_KEY ?? '');
  if (!url || !key) return true;
  return url.includes(PLACEHOLDER_URL) || key === PLACEHOLDER_KEY;
}
