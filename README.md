# maitred

Personal reservation agent. "Get me 4 seats at Guerilla Diner sometime next
weekend" — it figures out how that restaurant books, watches until a slot
opens, grabs it, and gates payments/OTPs through Telegram.

Built as a thin layer over **pi-durable** (durable tasks, signals, docs).

## Architecture

Two tiers, split by cost:

- **Discovery (LLM, rare):** unknown restaurant → a Claude-backed agent turns
  over the website/JS like a coding agent, writes a `Recipe` (typed connector
  description) into the `recipes/` dir. Runs inside a pi-durable task so a
  crash mid-discovery resumes cleanly.
- **Execution (pure code, always-on):** `WatchTask` polls the recipe's probe
  endpoint on a durable sleep loop — no LLM in the loop, sub-100ms reaction
  when a slot flips open. Human gates (confirm / OTP) are pi-durable
  **signals** delivered via Telegram.

```
Telegram (grammY) ── request intake ──┐
                                     ▼
   ┌────────────── maitred harness (SQLite) ──────────────┐
   │                                                       │
   │  AcceptRequestTask ──► DiscoverTask (if no recipe)    │
   │        │                                              │
   │        ▼                                              │
   │  WatchTask ──probe── sleep(2s)──probe── ──open!──►   │
   │        │                     (durable; crash-resumes) │
   │        ▼                                              │
   │  BookTask ──► signals: confirm / otp ── your phone    │
   │                                                       │
   │  Recipes (defineDoc + files in ./recipes/*.json)      │
   └───────────────────────────────────────────────────────┘
```

## Layout

```
src/
  harness.ts      Harness bootstrap, storage, registry, task defs
  tasks/
    accept.ts     parse a request, find/produce recipe, fan out
    discover.ts   LLM reverse-engineering → recipe doc/file
    watch.ts      pure-code polling loop, sleep phases
    book.ts       booking attempt + human gates
  signals/        confirm/otp/giveup signal definitions
  connectors/
    airmenus.ts   AirMenus platform client (config, probe, book)
    http.ts       generic recipe-execution helpers
  bot/
    telegram.ts   grammY bridge: intake + signal delivery
state/            SQLite db (gitignored)
recipes/          learned connector recipes (git commit these)
  guerilladiner.json
```

## Recipes

A recipe is the *learned knowledge* per restaurant: platform, endpoints,
payload shapes, and instructions for fallback behavior. Seeded with
Guerilla Diner (AirMenus) from the 2026-11-20 recon session. Any other
AirMenus restaurant (RestShortName + outlet id) is instant to add.

## State model (pi-durable docs)

- `RequestDoc` — your booking request, pax, date window, status
- `RecipeDoc` — learned connector per restaurant (also mirrored on disk)
- `WatchDoc` — per-watch poll bookkeeping (last probe, hits)

## Run

```
MAITRED_TELEGRAM_TOKEN=... npm start    # daemon; runs watch tasks
```
