// GPS tracking rules. Pure module.
import { haversineM } from './geo.js';

export const ZIYARET_MIN_INTERVAL_MS = 15000; // default: at most one ziyaret per 15 s (configurable)
export const ZIYARET_MIN_MOVE_M = 10; // default: and only after moving more than 10 m (configurable)
export const TRACK_MIN_MS_RANGE = [5000, 300000]; // settings may use 5 s to 5 min
export const TRACK_MIN_MOVE_M_RANGE = [1, 200]; // and 1 m to 200 m
export const STREET_PROMPT_M = 25; // "you are near this street" radius
export const BUSINESS_NEAR_M = 30; // link a ziyaret to a business within this radius
export const MAX_ACCURACY_M = 50; // ignore fixes worse than this

/** True when a fix is accurate enough to use for prompts and logging. */
export function isUsableFix(fix, maxAccM = MAX_ACCURACY_M) {
  return Boolean(fix) && Number.isFinite(fix.lat) && Number.isFinite(fix.lon)
    && (fix.acc == null || fix.acc <= maxAccM);
}

/**
 * Should this fix be written to ziyaretler?
 * last: previous recorded fix { lat, lon, t } or null. fix: { lat, lon, t } with t in ms.
 */
export function shouldRecordFix(last, fix, opts = {}) {
  if (!last) return true;
  const minMs = opts.minMs ?? ZIYARET_MIN_INTERVAL_MS;
  const minMoveM = opts.minMoveM ?? ZIYARET_MIN_MOVE_M;
  if (fix.t - last.t < minMs) return false;
  return haversineM(last.lat, last.lon, fix.lat, fix.lon) > minMoveM;
}

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

/**
 * Turns user input for the record throttle into safe values. Missing or non-numeric
 * values fall back to the defaults; out-of-range values are clamped.
 * input: { minMs, minMoveM }. Returns { minMs, minMoveM }.
 */
export function normalizeTrackOpts(input = {}) {
  const ms = Number(input.minMs);
  const m = Number(input.minMoveM);
  return {
    minMs: clamp(Number.isFinite(ms) ? ms : ZIYARET_MIN_INTERVAL_MS, TRACK_MIN_MS_RANGE),
    minMoveM: clamp(Number.isFinite(m) ? m : ZIYARET_MIN_MOVE_M, TRACK_MIN_MOVE_M_RANGE),
  };
}
