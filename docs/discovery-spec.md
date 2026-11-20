# Discovery — implementation spec (v1)

Goal: user names **any** restaurant ("get me Saturday at Loya, Bengaluru"); the
daemon figures out how that restaurant takes bookings, writes a typed Recipe,
and starts a Watch — without human engineering. Discovery is rare
(once per restaurant, ever), so it may be slow and use the LLM; everything
downstream stays pure code.

---

## 1. The invariant that shapes everything

**Recipes are data, connectors are code, and discovery writes data.**

A Recipe is *just enough* typed data for an existing connector to probe the
platform. Discovery never writes code. New platform + recipe that the generic
connector can't drive → that platform needs a new connector written by a human
(but the recipe still captures the recon, so the human work shrinks to the
connector itself).

## 2. Recipe schema v1 (the actual deliverable)

```jsonc
{
  "name": "guerilladiner",              // canonical slug
  "version": 1,                          // schema version, migration hook
  "restaurant": {
    "displayName": "Guerilla Diner",
    "city": "Bangalore",
    "website": "https://...",             // as discovered
    "bookingPage": "https://bookings.airmenus.in/guerilladiner/order",
    "platformId": "airmenus",             // fingerprint match or "generic-http"
    "ids": {                              // opaque dict, connector-defined
      "shortName": "guerilladiner", "outletId": 1406, "restaurantId": 1360
    }
  },
  "probe": {                              // how the watcher polls
    "kind": "days-config",                // airmenus: per-day is_open+slot groups
    "intervalSeconds": 4,                 // connector's courtesy floor
    "match": {                            // what counts as "bookable"
      "openDays": true,                   // day-level flip
      "slotGroupTitles": [],              // empty = all groups
      "times": []                         // from the request, not the recipe
    }
  },
  "booking": {                            // what phase-3 will eventually need
    "method": "POST /reservations/booking/",
    "payloadShape": "...-encoded json idiom...",
    "paymentModes": ["nopay", "paynow"],
    "auth": { "otp": true, "captcha": "recaptcha-enterprise", "guest": false },
    "notes": "converted JS bundle: checkout.js"
  },
  "validation": {                         // what discovery verified before publishing
    "probeOk": true, "slotsEnumerated": 6, "checkedAt": "2026-11-20T..."
  }
}
```

`recipes/guerilladiner.json` gets migrated to this shape (it currently holds
free-form recon notes — good raw material, wrong schema).

## 3. The DiscoverTask — a durable state machine with an agent inside

`src/tasks/discover.ts`, `defineTask<DiscoverInput, DiscoverCheckpoint,
DiscoverResult, {}>`. Phases commit a checkpoint **on entry**, so a crash
never redoes completed phases (and never re-spends their tokens):

| Phase | Work | LLM? |
|---|---|---|
| `locate` | restaurant name → booking page URL | yes, 1 agent turn + `curl` |
| `fingerprint` | match booking page against `platforms/` library | **no** — pure code |
| `recon` | download bundles, find API, endpoints, booking flow | yes, multi-turn agent |
| `draft` | emit the Recipe JSON to `state/discovery/<slug>.draft.json` | yes (structured output) |
| `validate` | replay recipe read-only: probe, enumerate, slot-check | **no** — pure code |
| `gate` | ask user the human questions (signals), get Confirm | no |
| `publish` | move draft → `recipes/<slug>.json`, update Recipes doc, spawn Watch | no |

Fingerprint match short-circuits: AirMenus/New-restaurant → `locate` +
`fingerprint` only, ~1 LLM turn total. The Guerilla-tier recon (custom/unknown
platform) is the expensive path, once ever per platform, not per restaurant.

## 4. The agent (recon phase, built on what pi-durable already ships)

- `harness.createConversation({ agent })` with pi-durable's tools: `bash`,
  `read`, `write`, `edit` — the exact stack that produced the Guerilla recon.
- System prompt embeds: the Recipe schema, the convention document ("probe
  read-only, never POST a booking, target output = recipe JSON"), and the
  `platforms/` fingerprint catalog so the agent knows known shapes.
- Sandbox: conversations get an `env` rooted at `state/discovery/<slug.workspace>/`
  (per-discovery scratch; gitignored; wiped on publish). No repo-wide write
  access — the agent writes the draft recipe, not source files.
- **Budgets**: a task-level `tokenBudget` from the Models' usage accounting
  (pi-ai reports per-turn usage) + `wallClockDeadline` (default 30 min). When a
  budget trips, phase parks with `waiting` on the `Control` signal saying
  "approve more budget?" — durable, resumable, not a crash.

## 5. Fingerprint library (`platforms/`)

Pure data, checked by pure code. Start small — Bangalore-relevant first:

```jsonc
// platforms/airmenus.json
{ "id": "airmenus", "connect": "airmenus",
  "urlHints": ["bookings.airmenus.in", "apis.airmenus.in"],
  "jsHints": ["airmenus"],
  "params": { "apiBase": "https://apis.airmenus.in/api" } }
```

Seed set: `airmenus` (done), then `easemytable`, `reserve-table/etg`,
`smoothops/`-style widgets found among Mumbai/BLR restos; defer global majors
(Tock/Resy/SevenRooms/Toast) until a target actually needs one.

## 6. Watch tier refactor (small, unlocks everything)

`AirMenusWatch` generalizes to `RecipeWatch`:
- Input gains `recipeName` and `requestId` (already has); resolves recipe via
  `recipes.ts`, dispatches probe to the recipe's `connect` connector.
- Connector registry: `src/connectors/index.ts` maps `platformId -> probe
  config` (AirMenus `days-config` today). If platformId's connector impl is
  missing → task fails with `platform.needs-connector`, request status
  `failed(needs-connector)` — honest stop, no silent garbage.
- The API surfaces (`startWatch`, web `/api/watch`) change from `outletId` to
  `recipe` — AirMenus stays a connector behind the same recipe format.

## 7. Validation gates (no bookings during discovery, ever)

`validate` phase runs **only** read endpoints the recipe declares; sequence:
1. `probeOk` — reservation config/availability fetch returns 200 + parses
2. `slotsEnumerated > 0` — at least one date yields slot data
3. `courtesy` — recipe's `intervalSeconds` >= connector floor (e.g. AirMenus ≥ 2s)
4. `booking.shadow` — the booking POST rendered to a payload and **held**
   (sent nowhere); recorded as `payloadShape` the human can inspect

Anything failing → recipe stays a draft, request status `failed(validation)`,
the draft file + agent scratch **persist for inspection** (don't delete on
failure — that's the debugging gold).

## 8. Human gates (signals we already defined)

- `Confirm` — publish recipe? (per-recipe approve, cheap insurance against a
  confidently-wrong recipe probing a wrong outlet), then later
  confirm-to-book (phase 3, separate)
- `Control` — budget/time extensions
- `Otp` — **not** used during discovery; reserved for live booking (phase 3)

Web UI renders pending gates; Telegram can deliver them later (push), but
gates ride on durable `waiting` state either way — no interface lock-in.

## 9. Cost discipline

- Fingerprint hits: ~1 LLM turn (<$0.05, seconds).
- Full recon (new platform): budget default ~$2 / 30 min, 1-2 attempts at
  ~$0.75; agent model = whatever `MAITRED_MODEL_PROVIDER` selected; the
  *watch tuns* it produces remain $0.
- Caching by `restaurant.name`+city — a published (or even `gate:rejected`)
  recipe short-circuits all future discoveries; retries check the draft first.

## 10. File plan & sketch sizes

| Piece | ~LOC | Notes |
|---|---|---|
| `src/recipe-schema.ts` (zod-free hand-rolled, pi-schema) | 80 | type + validator + migrate vN→vN+1 |
| `src/tasks/discover.ts` | 250 | phase machine, 7 phases |
| `src/agents/recon.ts` | 120 | conversation+tool wiring, budget checks |
| `platforms/airmenus.json` | 20 | first fingerprint |
| `src/connectors/index.ts` | 40 | platformId dispatch (AirMenus only, initially) |
| `src/tasks/watch.ts` refactor | ±40 | becomes RecipeWatch |
| migrate `recipes/guerilladiner.json` → schema | — | data edit |
| web UI: `discover` form + gate panel | 60 | start with recipe select populated by Recipes doc |
| signals: `Confirm` consumed by `gate` phase | 20 | first real signal use |

Total ≈ **600-650 lines**, honest estimate, mostly agentic-orchestration glue.
No new deps.

## 11. Open decisions (the ones I need from you)

1. **Publish gate**: auto-publish validated recipes, or require your `Confirm`
   per new recipe (my rec: gate it — one tap, catches wrong-outlet disasters)?
2. **Discovery trigger scope** in this pass: only from the web UI "watch"
   form (recipe selector → falls back to discover on unknown name) — or a
   dedicated discover form with name/city/url-hint fields?
3. **Scope of phase-3 booking** shape captured in recipes: v1 recipes record
   `booking` info as notes only (no `payloadShape` rendering) — full
   booking POST goes in phase 3 with the OTP/confirm/razorpay flow.
4. **Fingerprint seeds beyond AirMenus** for the first Bangalore test set
   (name 3-5 BLR restaurants you actually want to try, and I'll pre-check
   what platforms they run — likely AirMenus-heavy, maybe 1-2 others to
   prove the fingerprint path for real).
