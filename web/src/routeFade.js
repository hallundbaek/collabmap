// Routes fade linearly to 0 opacity over ROUTE_FADE_DAYS days.
export const ROUTE_FADE_DAYS = 14;

// SQLite stores `created_at` as "YYYY-MM-DD HH:MM:SS" in UTC.
export function routeDate(createdAt) {
  return new Date(String(createdAt).replace(" ", "T") + "Z");
}

export function routeOpacity(createdAt, now = Date.now()) {
  const t = routeDate(createdAt).getTime();
  if (!Number.isFinite(t)) return 1;
  const days = (now - t) / 86400000;
  return Math.max(0, Math.min(1, 1 - days / ROUTE_FADE_DAYS));
}
