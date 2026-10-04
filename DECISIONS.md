# Decisions

Every default chosen while building this server, grouped by area, with a one-line reason. Items marked **Owner action** need a check or a decision from the repository owner.

## Reference code

- **Smoobu client written from the public docs.** The brief asked to reuse a Smoobu client from a local Windows path (`C:/Users/User/Documents/ReactNativeApps/Medical/smoobu-booking-engine/api/src/smoobuClient.ts` and `search.ts`). That path was not reachable from the cloud environment this was built in, so `src/smoobu/client.ts` was written from the official Smoobu API docs (docs.smoobu.com). **Owner action:** compare with that client and reconcile any differences in endpoints, field names or auth.

## Smoobu authentication

- **HMAC when `SMOOBU_API_SECRET` is set, legacy `Api-Key` header otherwise.** Smoobu sunsets legacy keys on 2026-10-31, so HMAC is the default and the fallback keeps older setups working until then.
- **HMAC headers:** `X-API-Key`, `X-Timestamp`, `X-Nonce`, `X-Signature`, as described in the Smoobu docs.
- **Canonical string** (`src/smoobu/auth.ts`): seven lines joined with `\n`: method, path, sorted query, timestamp, nonce, SHA-256 hex of the body, API key. Built from the Smoobu docs; the live API is the final check.
- **Query encoding:** keys and values are RFC 3986 encoded (like `encodeURIComponent`, plus `!'()*`) and sorted by key, then value. The same string is used on the wire and in the signature, so they cannot drift apart.
- **Body hash:** SHA-256 hex of the exact JSON string sent; an empty string for GET. Hashing the bytes actually sent avoids serialisation mismatches.
- **Signature:** base64 of HMAC-SHA256 over the canonical string, keyed with the secret.
- **Timestamp:** ISO 8601 UTC with second precision (`2026-10-04T18:00:00Z`), as in Smoobu's examples.
- **Nonce:** `crypto.randomUUID()`, fresh per attempt. Retries are re-signed, so a retry never reuses a nonce.
- **HMAC on `/booking/checkApartmentAvailability` is unverified.** The Smoobu docs do not say explicitly whether this endpoint accepts HMAC. **Owner action:** verify on go-live. If it rejects HMAC, leave `SMOOBU_API_SECRET` empty to use the legacy header until 2026-10-31, and raise it with Smoobu.

## Catalog

- **Placeholder catalog with two fictional properties** (`casa-caribe`, `jungle-studio`) and `CATALOG_IS_PLACEHOLDER = true`. No real property data was available; the flag makes the state obvious and `npm run check-catalog` warns about it.
- **Hand-written catalog is the only source of public identity.** Keeps Smoobu internal names and ids out of every output.
- **Currency stored per property in the catalog.** `/api/rates` does not return a currency, so `get_calendar` reports the catalog currency. `check_availability` reports the currency Smoobu returns with the price.
- **Catalog validated at startup** (url-safe unique slugs, unique positive apartment ids, ISO 4217 currency, non-empty names). A malformed catalog fails fast instead of serving wrong data.

## MCP transport and server

- **Stateless Streamable HTTP with JSON responses** (`enableJsonResponse: true`, no session id generator). Serverless instances do not share memory, so sessions and SSE streams would break across instances.
- **A fresh `McpServer` and transport per request**, closed in `finally`. No state can leak between callers.
- **Plain `GET /mcp` (without `Accept: text/event-stream`) returns a JSON description** of the server and its tools. Gives a human or a health check something useful instead of an error.
- **`GET /mcp` with `Accept: text/event-stream` returns 405.** A stateless server has no server-initiated messages, so a standalone SSE stream would only hold a serverless function open.
- **One Web-standard handler** (`src/http.ts`, `Request` to `Response`) shared by Vercel (`api/mcp.ts`) and the local server (`src/nodeServer.ts`). One code path to test; no Express dependency.
- **`/healthz` only in the local server.** On Vercel, the plain GET on `/mcp` serves the same purpose.
- **Server instructions** describe the workflow, the date convention and the read-only nature, so an agent can use the tools without extra prompting.
- **Runtime dependencies are only `@modelcontextprotocol/sdk` and `zod`.** Smaller attack surface and fewer supply-chain risks for a public service.

## Tools and validation

- **Four tools:** `list_properties`, `check_availability`, `get_calendar`, `get_booking_link`. Covers discover, check, browse, book-link; nothing that writes.
- **Annotations on every tool:** `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`. Tells clients the tools are safe to call without confirmation.
- **"Today" is computed in `America/Costa_Rica`.** The properties are there; a UTC date would be wrong for six hours each evening.
- **Arrival at most 18 months ahead.** Bounds how far ahead anonymous callers can probe and the work per request. Month arithmetic clamps to the end of the month.
- **1 to 60 nights per stay.** Covers real vacation stays and bounds upstream work.
- **Guests 1 to `maxGuests`.** With `property`, the bound is that property's limit. Without it, the bound is the largest `maxGuests` in the catalog, and smaller properties are returned as unavailable with a reason instead of failing the whole call.
- **Input schema caps** `guests` at 50 and slugs at 80 characters. Rejects absurd input before any logic runs.
- **Calendar `to` is inclusive, at most 92 days per call, and must fall within the 18-month horizon.** 92 days covers any three consecutive months.
- **Unknown slug errors list the known slugs and do not echo the caller's value.** Helps an agent correct itself in one step without turning the error into a reflection channel.
- **`get_booking_link` does not check availability and does not call Smoobu.** It only fills the URL template; the tool description tells agents to call `check_availability` first.
- **`BOOKING_URL_TEMPLATE` must be an absolute http(s) URL containing `{arrival}` and `{departure}`.** `{property}` and `{guests}` are optional. Values are URL-encoded when filled.

## Rejection reasons

- **Smoobu rule codes mapped to fixed English sentences:** 400 guest limit, 401 minimum stay, 402 check-in weekday not allowed, 403 lead time, 404 gap between bookings. Numbers such as the minimum stay are filled in when Smoobu provides them.
- **Any other code, or none, gives "Not available for these dates."** Booked and blocked are indistinguishable to the caller.
- **Smoobu `message` strings and `arrivalDays` are never forwarded.** Upstream text could contain anything; the weekday in a 402 reason is computed from the requested arrival date instead.

## Availability, prices and calendar

- **One `checkApartmentAvailability` request for all candidate apartments.** One upstream call per question instead of one per property.
- **An apartment is available only if it is in `availableApartments` and has a price.** Anything ambiguous is reported as unavailable.
- **Prices rounded to cents; nightly average = total / nights**, also rounded. Smoobu returns a stay total; the average is a convenience for comparison.
- **`pricesExcludeTaxes` is the literal `true`, plus a note text** on every priced output. Taxes and fees are added on the booking page, and the caller must not present the total as final.
- **Days missing from the rates response are reported as unavailable with a null price.** Conservative: never advertise a night that Smoobu did not confirm.
- **`minStay` is reported only when positive;** zero or missing becomes null.

## Caching

- **Availability cached for 120 s**, keyed by sorted apartment ids, arrival, departure and guests. Short enough for a booking to show up quickly, long enough to absorb repeated agent calls.
- **Rates cached for 300 s**, keyed by apartment id and date range. Calendar browsing is less time-sensitive than a concrete stay check.
- **Single-flight deduplication.** Concurrent identical misses share one upstream call.
- **In memory, per instance, at most 5000 entries** (oldest evicted). No extra infrastructure. For a shared cache, implement the `Cache` interface in `src/cache.ts` on Redis, Upstash or Vercel KV.
- **TTLs tunable by environment variable; `0` disables a cache.** Lets the owner trade freshness for upstream load.

## Rate limiting

- **Token bucket per client IP: burst 20, refill 60 per minute** (`RATE_LIMIT_BURST`, `RATE_LIMIT_PER_MINUTE`). Generous for an agent, tight enough to stop a single client from draining the Smoobu quota.
- **Client IP:** the socket address when the local server provides it, otherwise the first entry of `x-vercel-forwarded-for`, then `x-forwarded-for`, then `x-real-ip`. Vercel sets `x-vercel-forwarded-for` itself, so it is the most reliable source there.
- **Applied to MCP traffic only;** `OPTIONS` preflights and the plain GET description are not counted.
- **Denied requests get HTTP 429, a `Retry-After` header and a JSON-RPC error body** (code -32000). Standard signals that clients and agents understand.
- **In memory, per instance, at most 10 000 tracked IPs** (least recently seen dropped). Blunts abuse without infrastructure, but it is not a global quota. In production, back the `RateLimiter` interface with a shared store or use Vercel WAF rate limiting.

## Upstream retries and timeouts

- **3 attempts in total, 500 ms base delay, doubling, up to 25% jitter, capped at 4 s.** Rides out short Smoobu hiccups while keeping a tool call under about 40 s in the worst case.
- **Retried on 429, 5xx, network errors and timeouts.** Other 4xx responses fail at once since retrying cannot help.
- **`Retry-After` (seconds) and Smoobu's `X-RateLimit-Retry-After` (unix seconds) are honoured,** still capped at 4 s. Respects Smoobu's limits without letting a caller hang.
- **10 s timeout per attempt.** Bounds each request on a serverless function.
- **Redirects refused** (`redirect: 'error'`). Signed requests and credentials must never be sent to another host.
- **A 2xx with an unexpected shape is not retried** and becomes the generic "temporarily unavailable" message. The shape will not change on retry.

## HTTP

- **Request body limit 64 KB.** A tool call is a few hundred bytes; this blocks oversized payloads.
- **CORS `*`** with the MCP headers allowed and exposed. The service is public and browser-based MCP clients must be able to reach it.
- **`Cache-Control: no-store` on every response.** Prices and availability must not be cached by intermediaries.
- **No authentication on the MCP endpoint.** Public, read-only data by design.

## Errors and output

- **Every output validated with a zod `strictObject` schema** before it is returned. An unknown key causes a generic error instead of a leak.
- **Successful results carry both `structuredContent` and a JSON text block.** Works for clients that read either.
- **Errors use `isError: true` with plain text** and no `structuredContent`. Validation errors explain the rule; upstream failures say "The booking system is temporarily unavailable. Please try again in a minute."; anything else gets a generic message. No stack traces.

## Logging

- **Structured JSON lines to stderr** (`{"t":..., "event":"...", ...}`), with a fixed set of event names and number or boolean fields only. Useful for operations, incapable of carrying a body, URL, message or key.
- **ESLint `no-console` is an error in `src/`**, with exceptions for the logger, the local entry point and the operator script. Prevents ad hoc logging of sensitive values.

## Tooling

- **TypeScript 5.9** (not 7), strict mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Stable toolchain that typescript-eslint supports.
- **ESLint 9 flat config with typescript-eslint type-checked rules.** Catches unsafe `any` flows and floating promises.
- **vitest 3** for tests; **tsx** for `npm run dev` and `npm run check-catalog`. Fast, no build step during development.
- **Node.js 24 or later** (`engines`). An LTS line that provides `process.loadEnvFile`, global `fetch` and Web streams.
- **GPL-3.0-only**, inherited from the repository's `LICENSE` file and declared in `package.json`.

## Deployment

- **Target: Vercel Functions on the Node.js runtime,** via `api/mcp.ts` and a `/mcp` rewrite in `vercel.json`. Fits a low-traffic public endpoint with no servers to run.
- **Not deployed by this work.** The Vercel setup follows Vercel's documented conventions (Web-standard named exports in `api/`, ESM imports with `.js` extensions resolved by Vercel's bundler) but has not been run against a real project. **Owner action:** deploy to a preview first (`vercel`), verify with MCP Inspector as described in the README, then `vercel --prod`.

## Deliberately not built

- **OAuth or any auth on the MCP endpoint.** The data is public and read-only.
- **stdio transport.** The server is meant to be a hosted public endpoint.
- **Discount codes.** Not needed for public prices and would need extra Smoobu inputs.
- **Multi-currency conversion.** Prices are shown in the currency Smoobu or the catalog provides; conversion would add a rates dependency and rounding questions.
- **Booking creation, guest data, reservation lookups.** Out of scope by design and blocked by the allowlist.
