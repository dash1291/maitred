# maitred architecture

How maitred is built, and why. It records the decisions as they stand and the
failures that led to them.

## 1. Principles

1. **The model decides what to do next.** Code never routes, matches names or
   sequences steps.
2. **It uses a site the way a person does.** It opens the page in a browser,
   reads what it says and clicks through it. What the page shows is the truth.
   It does not call a site's private API.
3. **A recipe is one action that has been done**, written and read by the
   model. "Book a table at Guerilla Diner", "order a burger from Guerilla
   Diner" and "order a kebab from X on Zomato" are three recipes. The model
   builds a new action from the recipes it has; code does not compose them.
4. **A recipe records only what was done and seen**, and how far it got.
5. **Code exists only where it must**: the loop that watches without a model,
   the alert on a match, and the gate on anything typed on the person's behalf.

## 2. The assistant

The harness root conversation is the assistant. A message from the person is
submitted to it; the final answer of every run is sent back to them.

Each input is prefixed with the person's local time. It goes in the message,
not the system prompt, so the prompt cache stays warm.

It runs on Claude Opus 5.5 with thinking set to high (`MAITRED_MODEL`
overrides the model). The harness leaves thinking off unless told otherwise;
the first versions ran that way without anyone noticing.

### Tools

| Tool | What it does | What code enforces |
|---|---|---|
| `browser` | Headless Chromium: open a page, click, select, type; each action returns the page text, its numbered controls and the requests the page made | Typing asks the person first unless they pre-approved that text for that site; private and loopback hosts are blocked for every request the page makes; no saved logins |
| `recipes` | List, read and write recipes | Confined to `state/recipes/` |
| `watch` | Start, list and stop watches | At most one visit a minute; a watch must be proven before it starts |

It has no shell, no raw HTTP tool and no way to call a site's private API.

## 3. Recipes

One markdown file per action. The first line is the action in plain words; the
rest is whatever the model found worth keeping: the page to open, the steps
that reach the answer, the venue's booking rules, sign-in or payment steps
met, the watch steps and rule used, what was verified and when, and how far
the action got. There is no schema, no platform registry and no connector per
platform.

While the recipes are few they are put in the system prompt in full, so one
that applies cannot be overlooked. Past a size budget only their first lines
are shown and each has to be read with the tool.

Shipped recipes live in `recipes/`. Ones written at run time live in
`state/recipes/` and win over a shipped recipe of the same name.

## 4. Watches

A watch is the one loop that runs without a model. On every probe it does what
a person would: opens the page in a browser, follows a short recorded path,
and reads what the page shows. Its input, all supplied by the model:

- `label`: what is being watched, for people
- `steps`: the path, as open / click / select actions. Targets are named by
  what a person sees, and `{name}` inserts a value from `params`, so one path
  serves the wanted date and the proof date
- `rule`: a small script, run in a sandbox with no network, that reads
  `input.page` (text and controls) and returns the matches. It throws when the
  page is not the one it expected
- `params`: what the person wants (date, party size)
- `proof`: params for which the page shows something available right now
- `then`: the assistant's note to itself about what to do on a match
- `timezone`, `intervalSeconds` (60 at least; 300 by default), optional
  `until`, and `alert`, the text to send on a match

How it behaves:

- **Proof before trust.** The path and rule are run with `proof` and must find
  something. A watch that runs cleanly and finds nothing proves nothing: a
  wrong path looks exactly like "not available yet". If nothing anywhere can
  prove it, the watch may start with `unproven` set to the reason, and is
  shown as unproven for as long as it runs.
- **Loud failure.** A step whose target is not on the page fails the probe. A
  failed probe is retried once; three failed probes in a row are reported to
  the assistant, and the watch keeps going.
- **Match.** The watch sends `alert` and the matches to the person at once,
  hands them to the assistant with its `then` note, and ends. The assistant
  acts on the note in that run, so acting on a match does not depend on the
  conversation still holding the request.
- **Light on the site.** One visit at a time across all watches; pictures,
  fonts and media are not fetched.
- A watch can also be started without the model, through the console API or
  the CLI. It passes the same checks.

An older kind of watch, whose rule fetches a URL itself, still runs for watches
started by hand. The assistant cannot create that kind.

## 5. Gates

The gate is on typing. A page fires many requests of its own, and they cannot
be told apart from a booking by their method. What a booking, an order, a
payment or a code request all need is typed details, so clicking and choosing
options are free and anything typed is shown to the person first, with
Approve and Decline.

The person can pre-approve their own details for one site (name, phone, email,
a payment address). Typing exactly one of those texts on that hostname then
happens without asking; anything else still asks. The console lists what is
pre-approved per site and can forget it. This is what lets a booking run
without a tap per field.

What stays with the person:

- **A one-time code.** The assistant asks for it in chat and types what they
  send.
- **A payment.** The assistant may type a payment address the person gave,
  such as a UPI ID; the person approves the request in their own payment app.
  It never types card numbers, PINs or passwords.
- **A captcha.** If a site challenges the browser, the assistant stops and
  hands over the page. Nothing is built to get around one.

The browser starts with no cookies or logins, so a click alone cannot act as
the person.

## 6. Channels

Telegram, through grammY, when `MAITRED_TELEGRAM_TOKEN` is set. The daemon
long-polls, so the server needs no inbound port.

- Messages from the one chat named in `MAITRED_TELEGRAM_CHAT` go to the
  assistant; every other chat is ignored. With no chat set, the bot only
  replies to a chat with that chat's id, which is how it gets paired.
- The final answer of every run is sent to the chat, whoever started the run.
- A watch match is sent by the watch itself, before any model runs.
- A pending approval is sent with Approve and Decline buttons.

The web console (loopback, reached through an ssh tunnel) is a second view of
the same conversation, the watches, pending approvals and recipes. The CLI is
a client of the daemon, so it never opens the database itself.

## 7. What was tried and dropped

- **A parse-and-dispatch pipeline.** The first version parsed each message
  with one model call, routed it in code, and ran a six-phase discovery task
  that produced a typed "recipe" for a single hard-coded booking platform.
  Every new capability was a new code path. Replaced by the assistant.
- **Working out each site's API.** The assistant first had a raw page fetcher,
  sandboxed scripts and an approval-gated request tool, and was expected to
  find each site's endpoints. Every failure in its first real runs came from
  that step: parameters sent as a string, a POST endpoint it could not call,
  and then a guessed endpoint that answered "nothing available" for every
  date, which made a watch poll 913 times and miss the opening it was for.
  Replaced by the browser, and by the proof requirement.
- **Trusting a watch that merely runs.** See above; a rule that returned
  nothing passed every check.
- **Showing only recipe titles.** The assistant skipped reading a recipe that
  held the working steps, rediscovered a page quirk the recipe described, and
  misread it. Recipes are now shown in full while they fit.

## 8. What is verified, and what is not

Tests (`npm test`) run the real harness with a scripted model against local
sites and a stand-in for the Telegram API: the browser tool, the typing gate
and pre-approvals, every way a watch starts, ends or is refused, a watch
surviving a restart, the recipe store, and the Telegram round trip.

Seen working against live sites on 2026-11-22:

- A watch walking the real booking page of one venue, proven on a date the
  page offered and finding nothing on a date not yet released.
- The assistant, on its own, starting a proven watch from a saved recipe.

Not yet seen:

- A watch alert firing for a real opening.
- A booking completed by the assistant. Everything after choosing a time on a
  real booking page is unobserved.
- The assistant building a watch for a venue it has no recipe for.
- A payment form inside an embedded frame. The browser reads only the main
  page.
