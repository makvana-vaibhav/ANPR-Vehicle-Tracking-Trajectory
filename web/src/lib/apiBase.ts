/**
 * Where the browser sends API calls and opens the live feed.
 *
 * The bundle is built with `VITE_API_BASE_URL` — `http://localhost:8000` in the
 * demo compose file — and the same bundle is served on two origins: plain HTTP
 * on :8080, and HTTPS on :8443. From the HTTPS page an `http://` API is mixed
 * content, and the CORS allow-list does not name the HTTPS origin either. Both
 * servers proxy `/api/` and `/ws/` to the API, so an HTTPS page uses its own
 * origin instead; the HTTP page keeps the configured base, exactly as before.
 *
 * Over the HTTPS origin the API also returns crops and video on that origin
 * (services/api/app/core/public_origin.py), so nothing on the page is fetched
 * over plain HTTP.
 */
export function resolveApiBase(configured: string, pageProtocol: string): string {
  if (pageProtocol === 'https:' && configured.startsWith('http:')) return ''
  return configured
}
