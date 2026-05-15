// Resolve the API base URL. In dev (no env var) we use relative paths so the
// Vite proxy in vite.config.ts forwards /api → http://127.0.0.1:8787. In prod
// (Pages deploy), VITE_API_BASE points at the worker's domain.
const ENV_BASE = (import.meta as any).env?.VITE_API_BASE as string | undefined;
const BASE = ENV_BASE ? ENV_BASE.replace(/\/$/, "") : "";

export function api(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return `${BASE}${path.startsWith("/") ? path : `/${path}`}`;
}
