# ESPN Fantasy Football Live Draft Assistant

A Chrome extension (Manifest V3) that runs as an overlay inside the ESPN fantasy football
draft room. It watches the draft in real time and continuously suggests who to pick next,
and why.

**It is advisory only.** It never drafts for you, never queues a player, and never clicks
anything in the ESPN UI. It only reads.

---

## Status: Phase 4 of 5

| Phase | Scope | State |
|-------|-------|-------|
| **1** | Read-only sync — detect draft room, pull settings + player pool, poll picks. League config UI. | **Done — needs mock-draft verification** |
| **2** | Recommendation engine + replay harness. Scoring, VOR, tiers, survival, strategy weights. | **Done — 74 unit tests pass** |
| **3** | On-page panel rendering the top 5 live. | **Done — needs mock-draft verification** |
| **4** | Hardening — DOM observation, degraded modes, log buffer, injury narrative. | **Done — needs mock-draft verification** |
| 5 | Tuning `engine/strategy.js` constants against replayed drafts. | Not started |

The panel appears in the top-right of the draft room. Drag it by the header, collapse it
with the `−` button; both stick across reloads. Console logging from phase 1 is still on.

### Running the tests and the replay

```bash
npm test          # 74 unit tests, no dependencies — uses node:test
npm run replay    # replays a synthetic draft, printing the top 5 at each of your turns
```

`npm run replay -- draft.json --team 104` replays a captured draft instead. See the header
of `tools/replay.js` for the capture format.

---

## Loading the extension in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (toggle, top right).
3. Click **Load unpacked**.
4. Select the repository root: `D:\git\FantasyDraftExtension`
   — the folder containing `manifest.json`, not a subfolder.
5. "ESPN Fantasy Draft Assistant" appears in the list. Pin it to the toolbar so the
   config popup is one click away.

### After changing code

Click the **reload icon** on the extension card in `chrome://extensions`, then reload the
ESPN tab. Changes to `popup/` take effect when you next open the popup; changes to
`content/` need the ESPN tab reloaded.

> Never reload the ESPN tab during a live draft. See [Draft-day rules](#draft-day-rules).

---

## Configuring your leagues

Config is **per-league**, so running three drafts in three different leagues does not make
them clobber each other. Each league keeps its own team ID and verified settings.

### The zero-setup path

Just open a draft room. The extension reads `leagueId` from the URL, saves it, makes it
active, and auto-detects which team is yours by matching your `SWID` cookie against the
league's team owners. **You usually never need to type anything.**

### The popup

Click the extension icon:

- **Detected banner** — appears when the current tab has a league the extension hasn't saved.
- **Leagues** — every saved league. `Use` switches which one is active; `Remove` deletes it.
- **My team** — auto-detected. Type a team ID here to override if detection fails.
- **Verify** — fetches live settings and shows the real league name, team count, scoring
  format, draft type, and round count. Use this to confirm the API agrees with what you
  think your league is.
- **Add league** — manual entry, for setting up before a draft room exists.

Find a league ID in any league URL: `fantasy.espn.com/football/league?leagueId=`**`123456`**

Config changes are pushed to the running content script immediately. The page is never
reloaded.

> `Verify` needs an open `fantasy.espn.com` tab. ESPN's CORS policy allows only the
> `fantasy.espn.com` origin, so the request is proxied through the content script rather
> than made from the popup directly.

---

## What to expect in a mock draft

The panel should appear top-right within a few seconds of the draft room loading, showing
picks-until-your-turn, five ranked suggestions with a one-line reason each, your roster
grid, and a connection health footer.

Open the console (F12) and filter for `[FDA]` to see the underlying sync:

```
[FDA] Detected and saved new league 123456
[FDA] League "My League" | 12 teams | PPR (receptions = 1 pts) | SNAKE
[FDA] Starting slots: slot0x1 slot2x2 slot4x2 slot6x1 slot16x1 slot17x1 slot23x1 | bench 7 | 16 rounds
[FDA] Auto-detected your team: Team Name (id 4)
[FDA] Your draft slot: 3 of 12 | your picks: 3, 22, 27, 46, ...
[FDA] Player pool: 500 loaded | 493 with projections | 500 with ADP
[FDA] Scoring verified: 40 players recomputed, 100% agree
[FDA] First parsed pick (verify shape): { playerId: 4429795, teamId: 1, round: 1, ... }
[FDA] Pick 1 (R1.1) team 1: Jahmyr Gibbs RB
[FDA] On the clock: pick 2 (R1) | your next: 3 (1 away) | your roster 0/16 | RB/WR bench 0
```

### Acceptance checklist

- [ ] League name, team count, and scoring match your actual league
- [ ] Round count equals your roster size
- [ ] Your draft slot and pick numbers are correct
- [ ] Player pool loads with projections and ADP
- [ ] `Scoring verified` reports high agreement — if not, the panel warns and VOR is approximate
- [ ] **`First parsed pick` shows real values, not zeros** — see below
- [ ] Each pick logs within a few seconds of happening
- [ ] The panel's pick counter matches the draft room's own clock
- [ ] Top 5 never contains a kicker before the final round, or a defense before the last two

### Where picks actually come from

`mDraftDetail` returns a slot for **every** pick in the draft, not just the ones that have
happened — unmade picks come back with `playerId: -1` and a real team, round and overall
number. And during a live draft it may return nothing but those placeholders, never filling
in the picks that have already been made.

So picks are read from two places in the same request:

| Source | When it wins | What it gives up |
|---|---|---|
| `mDraftDetail.picks` (`playerId > 0`) | Draft is over; more picks than the rosters show | Empty or placeholder-only while a draft runs |
| `teams[].roster.entries` | A live draft — whenever it knows about more picks | Sorted by lineup slot, so pick **order within a team** is approximated |

Whichever knows about more picks is believed. The roster path gets every player onto the
right team and the draft to the right depth, which is what the recommendations need; only
the ordering inside a team is a guess.

`inject.js` logs the first parsed pick so the field names (`roundId`, `roundPickNumber`,
`overallPickNumber`) can be checked. If `round`, `roundPick`, or `overall` come back as `0`,
report what that line prints.

---

## Verified API behaviour

These were confirmed against the live 2026 endpoints, not assumed:

- **`appliedTotal` is already scored for the requesting league.** The same player projects
  364.98 under PPR and 297.08 under standard — a delta of exactly his projected reception
  count. So projections do **not** need recomputing from component stats in the normal
  path. Startup still recomputes a 40-player sample from component stats and warns in the
  panel if they disagree, because custom league rules could diverge.
- **The API is a different origin.** `lm-api-reads.fantasy.espn.com` is not the same origin
  as `fantasy.espn.com`. It works because ESPN explicitly sets
  `access-control-allow-origin: https://fantasy.espn.com` with `allow-credentials: true`.
  All fetches must pass `credentials: 'include'` or they are unauthenticated.
- **ESPN advertises its own rate limit** via a `Polling-Interval` response header. The poll
  loop honours it when present, with a 3s floor.
- **`livedraftresults` is not machine-readable** — it is a client-rendered shell with no ADP
  in the HTML. ADP comes from `ownership.averageDraftPosition` instead, which is populated
  for 100% of the pool.
- **No ADP standard deviation exists** anywhere in the API. Survival probability models it
  instead (see below).
- **Injury narrative is expensive** — the core API returns a paginated `$ref` collection
  requiring roughly 1,700 requests to enumerate. Since every player already carries an
  `injuryStatus`, narrative detail will be fetched lazily on hover for on-screen players
  only, and never on the draft loop.

---

## Strategy

The engine encodes a specific drafting philosophy. It is a **tunable prior, not a cage** —
every weight will live as a named constant in `engine/strategy.js`.

Positional priority: **RB/WR → TE → QB → DST → K**

The core rule: **RB/WR bench depth outranks filling remaining starting slots at TE, QB,
DST, and K.** A fourth good RB is worth more than a mediocre starting QB, because the
QB6-to-QB14 weekly gap is small and waiver-replaceable while the RB4-to-streamer gap is
large and RB is where injuries force your hand.

Three agreed amendments to that baseline:

- **Late-round decay** — the bench-depth rule weakens sharply in the last ~3 rounds. At
  pick 14.8 a "fourth good RB" is usually a handcuff who never plays.
- **TE tier-cliff carve-out** — the TE gate stays, but a tier-cliff alert can override it
  when an elite TE is the last in his tier. TE is the most tier-cliffed position in
  fantasy; a blanket gate would systematically miss the only edge there.
- **ADP-dependent sigma** — survival probability uses `σ ≈ max(1.5, 0.35 × ADP)` rather
  than a flat `σ = 8`. ADP variance is small at the top and grows with ADP; a flat sigma
  implies a player with ADP 1.35 might last to pick 15, which is nonsense.
- **Logistic, not normal** — the spec called for a normal distribution around ADP. A normal
  tail is too thin: it says a player with ADP 10 still on the board at pick 40 has
  essentially no chance of lasting four more picks, when in reality he is falling for a
  reason and will probably keep falling. The logistic has a constant hazard rate, which
  matches how players actually slide, and its conditional form stays numerically stable
  deep in the tail where a normal underflows to exactly zero.
- **Injury discount and off-plan value are computed on a shifted positive scale.** VOR goes
  negative below replacement, where multiplying by a discount makes a number *larger*. Left
  unshifted, an OUT player outranks an identical healthy one in the last rounds.

Players whose raw value greatly exceeds the best need-adjusted alternative are surfaced in
a separate **off-plan value** slot — labelled as breaking the stated priority, never
silently promoted into the top 5 and never suppressed. The point is to see when your own
rules are costing you and decide for yourself.

---

## Draft-day rules

- **Never reload the draft room page.** ESPN may force re-authentication and you can lose
  your seat. The extension recovers in place from every failure mode.
- Failures degrade, they do not cascade. API failure keeps serving the last good player
  pool with a staleness warning; the pool barely changes mid-draft.
- `mDraftDetail` is polled no more than every 3 seconds. The player pool is fetched once at
  startup and only re-fetched on an explicit refresh.

### The DOM layer, and why it is only ever a hint

ESPN's own UI updates a second or two before `mDraftDetail` reports the pick. That gap
matters exactly once per round — when the pick immediately before yours decides whether
your top recommendation survives. So a `MutationObserver` reads the pick feed and the draft
board and greys players out early.

It is never trusted. Every API sync overwrites the board wholesale, so a bad DOM read costs
at most one poll interval of a wrong name being crossed off, and the extension is fully
functional with the DOM layer dead.

The awkward part is that **ESPN's pick markup contains no player id.** A completed pick
reads `Puka Nacua / LAR WR` and nothing more, so each one has to be matched back to the API
pool by normalised name plus pro team plus position. Names are normalised so `A.J. Brown`
and `AJ Brown` collide and suffixes are dropped; defenses key off the pro team, because the
board shows a city where the pool shows `Ravens D/ST`. **When a match is ambiguous the pick
is dropped, never guessed** — a wrong id would cross off a player who is actually still
available, which is worse than being a second late. Unmatched picks are surfaced in the
health footer.

ESPN's own "On the Clock: Pick N" is read as an independent check on where the draft is. If
it disagrees with our pick count by two or more, the panel says so in a banner above the
turn bar — recommending confidently for the wrong turn is the worst way for this to fail,
and it is not something to leave in a tooltip nobody hovers on a 30-second clock.

That header is also the one place a naive read is actively dangerous: the pick number sits
directly beside the team name, so `PICK 77` next to `2 Gurls 1 Kupp` reads as pick **772**
if you take the container's text. The number is therefore read from a child element holding
nothing else where possible, and otherwise trimmed until it falls inside the round the page
is showing. A number that cannot be made plausible is discarded — a missing drift check is
much cheaper than a fabricated one.

The class names ESPN ships are styled-jsx build hashes (`jsx-553213854`) that change on
every deploy, so nothing depends on them. `content/selectors.js` tries `data-testid` hooks
first, then the stable human-readable class fragments, then text matching, and reports which
strategy is carrying each target. Re-run `tools/dom-probe.js` in the console to see where
the markup has drifted.

---

## Project structure

```
manifest.json          MV3, minimal permissions: storage + ESPN host permissions only
shared/
  log.js               500-entry ring buffer; the post-mortem when nobody was watching
  config.js            multi-league config, shared by content script and popup
  nfl-teams.js         proTeamId -> abbreviation
  persist.js           draft + player-pool snapshots to chrome.storage.local
content/
  espn-api.js          v3 API client, defensive parsing, safe accessors
  draft-state.js       snake pick order, drafted tracking, roster composition
  selectors.js         candidate-strategy element lookup; every miss degrades
  dom-observer.js      MutationObserver layer, front-runs the API by a beat
  inject.js            entry point, owns the poll loop and the render loop
engine/                pure, synchronous, no DOM and no network
  strategy.js          every tunable constant, in one place
  scoring.js           recomputes projections from components to verify appliedTotal
  vor.js               replacement level, VOR, tier detection
  survival.js          ADP availability model and opportunity cost
  recommend.js         the 2g contract: recommend(draftState, playerPool, strategy)
ui/
  panel.js/.css        the overlay — renders a view model, emits intent callbacks
popup/
  popup.html/.js/.css  league configuration UI
test/                  74 unit tests + the shared harness
tools/
  replay.js            replays a draft, printing the top 5 at each of your turns
  dom-probe.js         paste into the draft room console to re-check ESPN's markup
  api-probe.js         paste into the draft room console to see where ESPN is putting picks
```

Vanilla JS, no build step, no framework — it has to be debuggable at speed on draft day.
The engine modules are browser-global IIFEs so the same files load in a content script and
in Node tests without bundling.

### Development

Two gitignored harnesses render UI outside the extension host with stubbed `chrome.*` APIs:
`.scratch/preview.html` for the popup, `.scratch/panel-preview.html` for the overlay. The
panel harness drives real engine output through synthetic draft states, so it exercises the
same code path the draft room does.

---

## Permissions, and why

| Permission | Reason |
|---|---|
| `storage` | Persist league config and draft state locally |
| `https://fantasy.espn.com/*` | Inject the content script into the draft room |
| `https://lm-api-reads.fantasy.espn.com/*` | Read league settings, player pool, and picks |
| `https://sports.core.api.espn.com/*` | Injury narrative, fetched only when you expand a player |

No data leaves your browser. There is no backend and no analytics.

---

## Troubleshooting

**Nothing in the console.** Confirm the extension is enabled, that the tab is on
`fantasy.espn.com`, and reload the tab. Content scripts only inject on page load.

**"No league configured."** Open the popup and add a league ID manually. This happens in
mock draft lobbies, which have no `leagueId` in the URL until the room opens.

**"Could not auto-detect your team."** The console prints every team ID and name. Enter the
right one in the popup's *My team* field.

**Verify says "No content script in that tab."** Reload the ESPN tab — the extension was
loaded or updated after that tab was opened.

**401 or 403 errors.** You are signed out of ESPN. Sign in on `fantasy.espn.com` in the
same browser profile; the extension uses your existing session cookies.
