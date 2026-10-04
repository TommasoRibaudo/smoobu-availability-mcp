# smoobu-availability-mcp

A public, read-only [Model Context Protocol](https://modelcontextprotocol.io) server for vacation rentals in Puerto Viejo de Talamanca, Costa Rica. It answers questions about prices and availability using the Smoobu API. It speaks Streamable HTTP at `/mcp` and exposes four tools. Any AI agent or MCP client can use it without credentials. It never creates, changes or cancels a booking, and it never returns guest or reservation data.

> [!WARNING]
> **Placeholder catalog.** `src/catalog.ts` ships with two fictional properties, `casa-caribe` and `jungle-studio`, and `CATALOG_IS_PLACEHOLDER = true`. Their Smoobu apartment ids are made up. Replace the catalog with your real properties before going live. See the [go-live checklist](#go-live-checklist).

## Tools

| Tool | Inputs | Returns |
| --- | --- | --- |
| `list_properties` | none | `count`, and `properties[]` with `slug`, `name`, `bedrooms`, `maxGuests`. |
| `check_availability` | `arrival`, `departure`, `guests`, optional `property` (slug) | For each property (or the one requested): either `available: true` with `currency`, `total`, `nightlyAverage`, `nights`, `pricesExcludeTaxes: true`, `bookingUrl`, or `available: false` with a plain-language `reason`. Also `availableCount` and a price `note`. |
| `get_calendar` | `property`, `from`, `to` | One entry per day: `date`, `available` (true/false), `price` (nightly, or null), `minStay` (or null). Also the property's `currency`. |
| `get_booking_link` | `property`, `arrival`, `departure`, `guests` | A booking-page `url` with the dates and guests filled in, plus `nights`. Does not check availability and does not call Smoobu. |

Limits:

- All dates are `YYYY-MM-DD`, interpreted in the `America/Costa_Rica` time zone.
- Stays (`check_availability`, `get_booking_link`): arrival is today or later, arrival is at most 18 months ahead, 1 to 60 nights.
- Guests: 1 up to the property's `maxGuests`. When `property` is omitted in `check_availability`, the upper bound is the largest `maxGuests` in the catalog, and properties that sleep fewer guests are returned as unavailable with a reason.
- Calendar (`get_calendar`): `from` is today or later, `to` is inclusive and at most 18 months ahead, at most 92 days per call.

Prices exclude taxes and any cleaning or service fees. The final total is shown on the booking page.

Every tool is annotated `readOnlyHint: true`, `openWorldHint: false`, `idempotentHint: true` and `destructiveHint: false`.

Typical flow for an agent: `list_properties` -> `check_availability` -> `get_booking_link`. `get_calendar` is for browsing open dates and nightly prices.

## Privacy guarantees

The Smoobu API key is account-wide. It can read reservations, guests and payments, not only rates. Privacy is therefore enforced by this code alone. The table lists each guarantee, where it is enforced and which test covers it.

| Guarantee | Enforced in | Tested by |
| --- | --- | --- |
| Only three Smoobu calls are possible | `src/smoobu/allowlist.ts`, `src/smoobu/client.ts` | `test/allowlist.test.ts`, `test/privacy.test.ts`, `test/e2e.test.ts` |
| Upstream JSON is never forwarded | `src/smoobu/client.ts`, `src/smoobu/types.ts`, `src/tools/*.ts`, `src/schemas.ts` | `test/privacy.test.ts` |
| Public identity comes only from the catalog | `src/catalog.ts`, `src/tools/*.ts` | `test/privacy.test.ts`, `test/e2e.test.ts` |
| Logs carry no data | `src/log.ts`, `eslint.config.js`, `src/errors.ts` | `npm run lint`, `npm run typecheck` |

### Endpoint allowlist

`src/smoobu/allowlist.ts` lists exactly three method and path pairs:

| Method | Path | Used for |
| --- | --- | --- |
| GET | `/api/apartments` | `npm run check-catalog` only |
| GET | `/api/rates` | `get_calendar` |
| POST | `/booking/checkApartmentAvailability` | `check_availability` |

`SmoobuClient.request()` in `src/smoobu/client.ts` is the only code path that calls `fetch`. Its first statement is `assertAllowed(method, path)`, so a call that is not on the list throws before any network activity. The match is exact: method in upper case, bare path, no query string. There is no code for reservations, guests, messages or payments anywhere in the repository.

`test/allowlist.test.ts` checks that every other method and path is refused, including `GET /api/reservations`, and that `fetch` is called zero times when that happens. `test/privacy.test.ts` and `test/e2e.test.ts` also record every outgoing call and check it is on the list.

### Upstream JSON is never forwarded

- `SmoobuClient` parses each response and copies only the fields it needs into the minimal internal types in `src/smoobu/types.ts`. The raw JSON is discarded inside the client.
- Each tool builds its output field by field from those internal types and the catalog.
- Every successful output is validated against a zod `strictObject` schema in `src/schemas.ts` before it is returned (`ok()` in `src/tools/shared.ts`). Strict objects reject unknown keys.
- If a field ever leaked into an output, validation would throw and the caller would get a generic error instead of the field.

### Public identity comes only from the catalog

- Property slugs, names, bedrooms and guest limits come from the hand-written `src/catalog.ts`. Nothing is read from Smoobu's apartment list at request time.
- Smoobu apartment ids, internal apartment names, channel names and the reason a day is closed (booked or blocked) never leave the server.
- A calendar day is only `available: true` or `available: false`.
- When `check_availability` rejects a stay, the `reason` is composed from Smoobu's numeric rule code (400 to 404) and numbers such as the minimum stay. Smoobu's own message text is never used.

### Logging

- `src/log.ts` is the only logger. Its field type allows numbers and booleans only, so a log line can carry a status code or an attempt number but never a string.
- ESLint `no-console` is an error in `src/`, with exceptions only for `src/log.ts`, the local entry point `src/local.ts`, the operator script `src/scripts/` and `api/mcp.ts`, which logs the name of a missing environment variable at startup.
- Response bodies, URLs and API keys are never logged.
- Upstream error messages (`SmoobuUpstreamError` in `src/errors.ts`) carry only the HTTP status and attempt count, never the body.
- Configuration errors name the missing variable, never its value.

### Poisoned test fixtures

The mock Smoobu in `test/mockSmoobu.ts` plants guest-like data from `test/fixtures/poison.ts` in every response: guest names, an email, a phone number, an address, reservation ids and references, a channel name, an internal apartment name, a block reason, a guest notice, the customer id and a string that looks like an API key. Unavailable days in the rates response carry a fake reservation. Booked apartments in the availability response carry a Smoobu message that names the guest.

`test/privacy.test.ts` calls every tool across many valid and invalid inputs and checks every output, including error outputs. It asserts that:

- no fixture value appears;
- no email or phone pattern appears;
- no Smoobu apartment id appears;
- no key outside the output schema appears.

### Robustness for anonymous traffic

| Measure | Details | Code |
| --- | --- | --- |
| Input validation | Friendly error text, `isError: true`, no stack traces | `src/validation.ts`, `src/tools/shared.ts` |
| Rate limit | Per-client token bucket (IPv4 address or IPv6 /64), in memory, per instance. Returns HTTP 429 with `Retry-After` and a JSON-RPC error body. JSON-RPC batches are rejected with 400 so one request is always one message | `src/rateLimit.ts`, `src/http.ts` |
| Upstream budget | A second token bucket in front of every Smoobu call (default 50 burst, 300 per minute, per instance) so no mix of callers can exhaust the account-wide Smoobu quota. After a Smoobu 429 with `Retry-After`, calls are refused for that long (up to 60 s) instead of retried | `src/smoobu/client.ts`, `src/app.ts` |
| Caching | Rates for 300 s, availability for 120 s, in memory, per instance. Concurrent identical requests share one upstream call (single flight) | `src/cache.ts` |
| Retry | Exponential backoff on 429, 5xx, network errors and timeouts. Honours `Retry-After` and `X-RateLimit-Retry-After`; a requested pause longer than 4 s fails the call instead of holding it open | `src/smoobu/client.ts` |
| Body limit | 64 KB per request | `src/http.ts` |
| CORS | Open (`Access-Control-Allow-Origin: *`). This is a public service | `src/http.ts` |

## Run locally

Prerequisites: Node.js 24 or later, and a Smoobu account with API access.

```sh
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable | Required | Meaning |
| --- | --- | --- |
| `SMOOBU_API_KEY` | yes | Smoobu API key. Create it in Smoobu under Settings > Advanced > API Keys. |
| `SMOOBU_API_SECRET` | recommended | The secret paired with the key. When set, requests are signed with HMAC. When empty, the client falls back to the legacy `Api-Key` header, which Smoobu sunsets on 2026-10-31. |
| `SMOOBU_CUSTOMER_ID` | yes | Your Smoobu customer (user) id. Required by `/booking/checkApartmentAvailability`. |
| `BOOKING_URL_TEMPLATE` | yes | Absolute http(s) URL of your public booking page. Placeholders: `{property}` (catalog slug), `{arrival}`, `{departure}`, `{guests}`. `{arrival}` and `{departure}` are mandatory. |
| `PORT` | no | Local server port. Default `3000`. |
| `RATE_LIMIT_PER_MINUTE` | no | Per-IP sustained rate. Default `60`. |
| `RATE_LIMIT_BURST` | no | Per-IP bucket size. Default `20`. |
| `UPSTREAM_RATE_LIMIT_PER_MINUTE` | no | Budget for outgoing Smoobu calls, all callers together. Default `300` (Smoobu allows 700). |
| `UPSTREAM_RATE_LIMIT_BURST` | no | Bucket size for that budget. Default `50`. |
| `CACHE_TTL_RATES_SECONDS` | no | Calendar cache lifetime. Default `300`. `0` disables it. |
| `CACHE_TTL_AVAILABILITY_SECONDS` | no | Availability cache lifetime. Default `120`. `0` disables it. |

`src/config.ts` also reads `SMOOBU_BASE_URL`, which overrides `https://login.smoobu.com`. It exists for testing, must be a bare https origin, and should be left unset in production.

Start the dev server:

```sh
npm run dev
```

It listens on `http://127.0.0.1:3000/mcp`.

- A plain `GET /mcp` returns a small JSON description of the server (name, version, tool names, `readOnly: true`). A `GET` asking for `text/event-stream` gets 405: the server is stateless and has nothing to stream.
- `GET /healthz` returns `ok`. This route exists only in the local server.

Check that every catalog entry points at a real apartment in your account:

```sh
npm run check-catalog
```

It prints `OK` or `MISSING` for each slug and its apartment id, and exits with code 1 if any id is missing. It warns if the catalog is still the placeholder.

## Testing

```sh
npm test            # vitest
npm run lint        # eslint, type-checked rules
npm run typecheck   # tsc including tests
npm run build       # tsc to dist/
```

No real Smoobu key is needed. Tests inject a mock `fetch` (`test/mockSmoobu.ts`) that:

- serves the three allowlisted endpoints with deterministic prices, booked dates, minimum stays and no-arrival weekdays;
- requires either the legacy or the HMAC auth headers, and returns 401 otherwise;
- can fail the next N responses with a chosen status and headers, or return a malformed body, to exercise retries and error handling;
- answers any other path with a pile of guest data, so an accidental call would be loud;
- plants guest-like values in every response (see [Poisoned test fixtures](#poisoned-test-fixtures)).

`test/e2e.test.ts` starts the real HTTP server on a random port and talks to it with the MCP SDK client over Streamable HTTP.

## Test with MCP Inspector

With `npm run dev` running:

```sh
npx @modelcontextprotocol/inspector
```

1. In the Inspector UI, set Transport Type to "Streamable HTTP".
2. Set URL to `http://127.0.0.1:3000/mcp`.
3. Click Connect.
4. Open Tools and click List Tools. You should see the four tools.
5. Call `check_availability` with, for example:

```json
{ "arrival": "2027-02-10", "departure": "2027-02-15", "guests": 2 }
```

While the catalog is still the placeholder, `check_availability` and `get_calendar` will not find the fictional apartment ids in your account. `list_properties` and `get_booking_link` do not call Smoobu and work regardless.

Raw JSON-RPC with curl:

```sh
curl -s http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Connect from an MCP client

Most clients that support remote servers accept a config like this:

```json
{
  "mcpServers": {
    "puerto-viejo-rentals": {
      "type": "streamable-http",
      "url": "https://<your-deployment>/mcp"
    }
  }
}
```

The exact key names vary by client. No authentication is required, by design: the server is public and read-only.

## Deploy to Vercel

The project deploys as a Vercel Function on the Node.js runtime.

- `vercel.json` rewrites `/mcp` to `/api/mcp` and allows the function 60 s (worst case with retries is about 40 s).
- `.vercelignore` uploads only `api/`, `src/`, `public/` and the package files. In particular it keeps a local `.env` out of the deployment: Vercel's built-in ignore list covers `.env.local` but not `.env`.
- `public/robots.txt` disallows crawling and makes `public/` the static root, so project files are never served as static assets.
- `api/mcp.ts` exports Web-standard `GET`, `POST`, `DELETE` and `OPTIONS` handlers. They share the same handler as the local server (`src/http.ts`).
- If configuration is missing, the function answers 503 `{"error":"Server is not configured"}` and logs the name of the missing variable.

Environment variables to set in the Vercel project:

| Variable | Sensitive |
| --- | --- |
| `SMOOBU_API_KEY` | yes |
| `SMOOBU_API_SECRET` | yes |
| `SMOOBU_CUSTOMER_ID` | yes |
| `BOOKING_URL_TEMPLATE` | no |
| `RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_BURST`, `CACHE_TTL_RATES_SECONDS`, `CACHE_TTL_AVAILABILITY_SECONDS` | no, optional |

Mark the `SMOOBU_*` variables as Sensitive in the Vercel dashboard (Project > Settings > Environment Variables).

Commands:

```sh
npm i -g vercel
vercel login
vercel link
vercel env add SMOOBU_API_KEY production
vercel env add SMOOBU_API_SECRET production
vercel env add SMOOBU_CUSTOMER_ID production
vercel env add BOOKING_URL_TEMPLATE production
vercel --prod
```

Each `vercel env add` prompts for the value. Add the optional tuning variables the same way if you need them.

Verify:

```sh
curl -s https://<project>.vercel.app/mcp

curl -s https://<project>.vercel.app/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The first returns the JSON description. The second returns the four tools. Also check that `https://<project>.vercel.app/.env` and `/package.json` return 404.

The cache and the rate limiter live in memory, so each function instance has its own. That is fine for a small public read-only service, but it is not a global quota. If you need one, implement the `Cache` interface (`src/cache.ts`) and the `RateLimiter` interface (`src/rateLimit.ts`) on a shared store such as Upstash Redis, or use Vercel WAF rate limiting in front of the function.

## Go-live checklist

1. Replace the entries in `src/catalog.ts` with your real properties: slug, public name, bedrooms, max guests, currency and Smoobu apartment id.
2. Set `CATALOG_IS_PLACEHOLDER = false` in `src/catalog.ts`.
3. With your real credentials in `.env`, run `npm run check-catalog`. Every line must say `OK`.
4. Run `npm test`, `npm run lint` and `npm run typecheck`.
5. Set the environment variables in Vercel (see [Deploy to Vercel](#deploy-to-vercel)).
6. Deploy with `vercel --prod`.
7. Deploy a preview first (`vercel` without `--prod`) and confirm `check_availability` works with `SMOOBU_API_SECRET` set. The Smoobu docs show only the legacy header for `/booking/checkApartmentAvailability`; if HMAC is rejected there, leave the secret empty for now and raise it with Smoobu before the 2026-10-31 sunset.
8. Open MCP Inspector, connect with Streamable HTTP to `https://<project>.vercel.app/mcp`, list the tools and call each one. Check that `check_availability` returns real prices for dates you know are open, and a reason for dates you know are booked.
9. If calendar changes must show up faster, lower `CACHE_TTL_RATES_SECONDS` and `CACHE_TTL_AVAILABILITY_SECONDS`.

## Project layout

```text
.
├── api/
│   └── mcp.ts                  Vercel function: GET/POST/DELETE/OPTIONS handlers
├── src/
│   ├── app.ts                  Composition root: config, Smoobu client, cache, rate limiter
│   ├── booking.ts              Booking URL template validation and filling
│   ├── cache.ts                Cache interface, in-memory cache, single-flight loader
│   ├── catalog.ts              Hand-written public catalog (placeholder)
│   ├── config.ts               Environment variable parsing
│   ├── errors.ts               User-facing and upstream error types
│   ├── http.ts                 Stateless Streamable HTTP handler, CORS, rate limit, batch rejection
│   ├── local.ts                Local entry point for npm run dev
│   ├── log.ts                  Structured logger (numbers and booleans only)
│   ├── nodeServer.ts           Node http to Web Request/Response adapter, /healthz
│   ├── rateLimit.ts            Rate limiter interface and per-IP token bucket
│   ├── schemas.ts              Strict zod output schemas for every tool
│   ├── server.ts               Builds the McpServer and registers the four tools
│   ├── validation.ts           Date, stay and calendar range rules
│   ├── scripts/
│   │   └── check-catalog.ts    Verifies catalog apartment ids against the account
│   ├── smoobu/
│   │   ├── allowlist.ts        The three permitted Smoobu calls
│   │   ├── auth.ts             HMAC and legacy auth headers
│   │   ├── client.ts           Smoobu client: allowlist, retry, response reduction
│   │   └── types.ts            Minimal internal views of Smoobu data
│   └── tools/
│       ├── checkAvailability.ts
│       ├── getBookingLink.ts
│       ├── getCalendar.ts
│       ├── listProperties.ts
│       └── shared.ts           Annotations, output validation, error handling
├── test/
│   ├── fixtures/poison.ts      Guest-like values planted in mock responses
│   ├── mockSmoobu.ts           Mock Smoobu fetch
│   ├── helpers.ts              Test app with fixed clock and test catalog
│   ├── e2e.test.ts             Full HTTP round trip with the MCP SDK client
│   ├── allowlist.test.ts       Non-allowlisted calls are refused before fetch
│   ├── privacy.test.ts         No fixture data in any tool output
│   └── *.test.ts               Unit tests: auth, booking, cache, catalog, client, config, http, rateLimit, tools, validation
│   ├── deploy.test.ts          .vercelignore, vercel.json and .env.example guards
├── public/robots.txt           Static root; disallows crawlers
├── .env.example
├── .vercelignore
├── vercel.json
├── DECISIONS.md                Defaults chosen and why
└── LICENSE
```

## License

GPL-3.0. See [LICENSE](LICENSE).
