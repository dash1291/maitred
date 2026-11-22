# maitred

A personal assistant for getting things done at restaurants and similar
venues. You message it in plain language; it works out how a place takes
bookings, watches until something opens, tells you on Telegram, and can go on
to book.

Built on **pi-durable** (durable conversations, tasks and tools). The design
and the reasons behind it are in [docs/architecture.md](docs/architecture.md).

## How it works

- One assistant conversation. Your message goes to the model; the model decides
  what to do next. Code does not parse, route or sequence anything.
- It uses a site the way a person does, through three tools:
  - `browser`: a headless Chromium. It shows a page's text and controls.
    Clicking and choosing options are free; typing is shown to you and waits
    for your approval, unless you pre-approved that detail for that site.
  - `recipes`: read and write recipes.
  - `watch`: keep checking a page until something is available.
- A **recipe** is one action that has been done ("Book a table at Guerilla
  Diner, Bangalore"), written by the model as markdown. The model builds new
  actions from the recipes it has. Shipped recipes live in `recipes/`; ones
  written at run time live in `state/recipes/` and win over a shipped recipe of
  the same name.
- A **watch** is the one loop that runs without a model. Every few minutes it
  opens the page in the browser, follows a short recorded path, and reads what
  the page shows. It must be proven on something available now before it
  starts. On a match it tells you at once and hands the match to the
  assistant, with the assistant's own note about what to do next.

## Layout

```
src/
  web.ts          daemon and console; the only process that opens the database
  main.ts         CLI, a client of the daemon
  harness.ts      wiring: model, tools, storage, Telegram
  assistant.ts    the assistant's instructions
  watch.ts        watch task and the checks a watch passes before it starts
  rule.ts         runs a watch rule in a sandbox
  browser.ts      the headless browser: act on a page, read what it shows
  approval.ts     asking the person, and what they have pre-approved
  telegram.ts     the Telegram channel
  http.ts         GET with host checks on every hop
  tools/          browser, recipes, watch
recipes/          shipped recipes
test/             node:test suites
state/            SQLite database, run-time recipes, console token (gitignored)
```

## Run

Needs Node 22 or newer, and Chromium for the browser tool:

```
npm install
npx playwright install chromium
echo "ANTHROPIC_API_KEY=..." > .env
npm start
```

Then open the console at http://127.0.0.1:8681, or use the CLI:

```
node --experimental-strip-types src/main.ts say "table for 2 at guerilla diner"
node --experimental-strip-types src/main.ts state
```

Without a model key the daemon still runs watches started by hand.

## Settings

Read from the environment; `npm start` also loads `.env` if present.

| Variable | Meaning | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | key for the default provider | none |
| `MAITRED_MODEL` | model the assistant runs on | `claude-opus-5-5` |
| `MAITRED_MODEL_PROVIDER` | `anthropic` or `doubleword` (needs `DOUBLEWORD_API_KEY`) | `anthropic` |
| `MAITRED_TELEGRAM_TOKEN` | bot token from @BotFather; enables Telegram | none |
| `MAITRED_TELEGRAM_CHAT` | the one chat allowed to talk to the assistant | none |
| `MAITRED_TZ` | your timezone | `Asia/Kolkata` |
| `MAITRED_STATE_DIR` | where the database and run-time recipes live | `./state` |
| `MAITRED_WEB_PORT`, `MAITRED_WEB_BIND` | console address | `8681`, `127.0.0.1` |

To pair Telegram: set the token, start the daemon, and send the bot any
message. It replies with your chat id; set that as `MAITRED_TELEGRAM_CHAT` and
restart. From then on you can talk to the assistant there, a watch match is
pushed to you at once, and approvals arrive with Approve and Decline buttons.

## Test

```
npm test
npm run typecheck
```

The browser tests need Chromium installed (`npx playwright install chromium`).

## Deploy

`deploy.sh` syncs the source to a server and runs it under Docker Compose. See
[DEPLOY.md](DEPLOY.md).
