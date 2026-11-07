# Feeld Swiper 🌱

A local web app that swipes Feeld for you. Each profile gets two scores from Claude: **P(veg*n)**, a Bayesian estimate that they are vegan, vegetarian, or otherwise not subsidizing factory farming (start from a base rate, update on the evidence in the bio, tags and photos), and **P(fit)**, how good a match they'd be for you, judged against your own date-me page (pasted into Settings). Either score can earn a like or a ping; profiles that clear both bars rank at the top. Same idea as the Tinder swiper, but Feeld has no web app, so this one drives the **real Feeld Android app running in an Android emulator** (or a real phone over USB) through ADB, and shows the phone live inside the dashboard. Built 2026-09-07/08 (first commit 2026-09-08); the review queue, fit score, ping drafting, Agent SDK backend and Dock launcher were added 2026-11-04 to 11-06.

## How it works

1. `npm run dev` starts the dashboard at http://localhost:4848 and boots the `feeld` virtual device **invisibly in the background**. The dashboard's **Phone** panel streams the phone screen; click to tap, drag to swipe, and type when the panel has focus. You never need the emulator's own window.
2. The **Setup** panel gets you from an empty phone to a logged-in Feeld: sign the phone into Google (Play Store), install Feeld, then log in to Feeld on the phone panel (phone number + SMS code, or Apple/Google). Your Feeld account is the same on every platform. Alternatively sideload an APK.
3. **Start batch** browses Discover for one session of random length (10–150 minutes by default). Feeld lets you move past a profile without liking or passing, and the app never votes on its own. For each **new** profile it scrolls through the card the way a person would, reading the text from Android's accessibility tree and taking a screenshot at each position, asks Claude for a probability, records a **provisional call** (recommend like / ping / pass), and browses on. Stage one sends the text plus the first screen; under the quick-pass threshold (15%) it decides on that alone, otherwise it sends every screen and re-scores.
4. Tiers: a **ping** when P(veg*n) ≥ 90% or P(fit) ≥ 80% (either route); a **like** when P(veg*n) ≥ 50% or P(fit) ≥ 60%; otherwise a pass. Thresholds are in Settings. Profiles the model recommends a ping for also get **three openers drafted by Claude Sonnet 5.5** (configurable), written in your voice from the "About you" notes in Settings, and informed by how you edited earlier drafts.
5. The **To review** tab is a **ranked list**: the **Ping** tier first (with the drafted message open in an editor), then **Like**, then **Pass**; within a tier, profiles that clear both the diet and fit bars come first, then by the two scores combined. Like and Ping cards show the whole profile text open and formatted. Under every card a **pass on everyone below this** cut line queues a pass on the rest of the list. For each you decide: **Pass**, **Like**, **Ping** (start from a draft, edit it, or write your own), or **Leave it** (no action on Feeld). Bulk buttons approve every recommended pass at once. Nothing is sent until you decide. Every edit is recorded as feedback: a like or pass grades the screener's call, moving a profile between tiers is reported to the screener, and the draft you started from versus the message you queued is shown to the drafter next time.
6. **Send to Feeld** (To review tab) runs a batch that only delivers your queued likes, pings and passes: it browses Discover, recognises each reviewed profile, acts, and passes by everyone else without judging, stopping when the queue is empty. A normal batch also applies reviews as it goes. Either way the app recognises reviewed profiles when they come round again in Discover (by name and age, cross-checked against the saved profile text) and does what you chose: taps Like or Pass, or opens the Ping composer, types your message, and sends. Already-judged profiles that you haven't reviewed yet are browsed past again without a vote. The batch ends when time is up, Feeld runs out of profiles, or it keeps showing profiles you've already seen.
7. **Re-score waiting profiles** re-judges everything waiting from the saved text and screens, without the phone: use it after changing the page, the thresholds or the model.
8. The **History** tab shows every profile: filter by probability, batch, the model's call, your review, what was actually done on Feeld; grade the diet call (should P(veg*n) have been higher or lower?) and the fit call (should the fit percentile have been higher or lower?) separately, give your own estimate for each, leave notes. Grades, notes, and the standing "Guidance for the model" box are fed into every future prompt as calibration feedback.

Set `FEELD_DATA_DIR` to run against a different data folder (handy for testing with fake profiles). Every decision is appended to `data/decisions.jsonl` with the profile text, photo crops, the screens it saw, your review, the ping drafts and the message you chose, and what was done on Feeld.

### Model calls

All calls go through `src/llm.ts` (`structuredCall`), on whichever backend Settings selects: the Claude API with the key in `.env`, or the Claude Agent SDK (Claude Code as a library, every built-in tool off) using this machine's Claude Code sign-in. Each call follows the agent-coding LLM standard: the system prompt starts with `../shared/llm-system-prompt-preamble.md` word for word (read at call time), the `contact_eli` tool from `../shared/contact_eli_tool.json` is offered (on the Agent SDK path it is served as an in-process MCP tool, `mcp__eli__contact_eli`), and every response is piped to `python3 ../shared/llm_contact.py check`. If the model called the tool or wrote an `@ELI:` line, the call throws `ContactedEliError`: a batch stops with status *error* (the profile is recorded as skipped with that message), a re-score run stops, background drafting stops, and the review-card redraft reports it. Nothing is retried; Eli reads and answers with `llm-inbox`.

### Safety rails

Nothing is liked or passed without your review. Every tap and swipe the driver makes is gated on Feeld being the foreground app. Screens that look like your own profile, settings, membership, or a payment sheet are recognised as off-limits and only ever left with the Back key. Popup dismissal matches an explicit allowlist of "decline" labels (Not now, Maybe later, No thanks, Keep swiping…), never generic ones like Continue or OK. Like/Pass/Ping are only ever tapped by their button, found by label in the lower half of the screen; if the button isn't found the app reports it and does nothing. Moving past a profile uses the "next profile gesture" from Settings; if that gesture ever produces a match screen (meaning it registered as a like on your build) the batch stops itself and tells you. What you do by hand on the phone panel is not gated.

### Drafts are never lost

Every text box in the dashboard keeps what you typed. Settings boxes (date-me page, About you, guidance, device fields) auto-save to `data/settings.json` a moment after you stop typing, and a pending save is flushed with `keepalive` when the tab closes. Per-profile ping messages and notes, the phone text box, the Google email and the APK paths are mirrored to the browser's `localStorage` on every keystroke (keys `feeld:draft:<field>:<decision id>`) and restored before the box is shown; they are cleared only when the ping is queued, the note is saved, the text is sent, or the setup step succeeds. The Google password is never stored.

### What the real app looks like (Nov 2026)

Checked against Feeld on the emulator: Discover is a vertical card with three floating buttons found by stable ids (`profile.actions.like.button`, `profile.actions.dislike.button`, `profile.actions.ping.button`, the last labelled "17 Pings left"). The name is the `profile.imaginaryName` node and the age line reads "26 · Woman · Queer". The bio is one `profileBio` node, so the whole bio is in the accessibility tree even when truncated on screen. A horizontal swipe moves to the next profile (no match screen, ping count unchanged). The Ping button opens a bottom sheet ("Send a Ping") with an "Add a note…" field that becomes an EditText once tapped, a "Send Ping" button and Cancel. The Connections/Chats tab is a secure window: screenshots come back black there, which is why the phone panel goes dark on that tab. Feeld's own "Exploring <city>" travel mode overrides the GPS; leave it on "current location" and set the city in Settings → Device.

Profiles are recognised again by three independent signals (name and age, bio text, a perceptual hash of the first photo); two are required before a queued like, ping or pass is sent, so the order Feeld shows profiles in never matters.

### Tuning the driver

Feeld's Android UI isn't something I could see while building this (the app needs a Google account to install), so the screen recognition in `src/feeld.ts` (`SELECTORS`) is heuristic: like/pass buttons by content-description or resource id, match/out-of-likes/logged-out screens by text patterns. Once Feeld is installed and logged in, press **Inspect screen** on the Discover tab and check that `likeButton`, `passButton` and `pingButton` are found and `state` is `discover`. If not, look through `nodes` for the real labels and extend the regexes. Then press **Next (no vote)** and watch the phone panel: the next profile should appear with no heart or X animation and no match screen. If the gesture votes on your build, change "Next profile gesture" in Settings. The ping flow (Ping button → composer → Send) was checked with **Test ping (no send)** on the phone panel: it opens the composer, types a note, confirms the Send Ping button is there, and cancels. Run it again after a Feeld update. Inspect's `recognised` field shows whether the profile on screen would be matched to a saved decision (and by which signals). `texts` shows exactly what the bot can read; photos are cropped from `ImageView` nodes, with the full screenshots as fallback.

## Files

| File | Purpose |
|---|---|
| `src/server.ts` | Entry point: Express API, static dashboard, `/ws` phone stream, SSE events, review/draft/rescore endpoints. Header comment says where config and logs live. |
| `src/swiper.ts` | The batch loop: boot the device, open Discover, read each profile, judge it, apply queued reviews, move on; batch timing and breaks. |
| `src/feeld.ts` | `FeeldDriver`: screen recognition (`SELECTORS`), profile reading, voting, the ping composer, popup dismissal, image saving. |
| `src/android.ts` | Thin ADB client: shell, UI dumps, taps, swipes, screenshots, text input. |
| `src/emulator.ts` | Finds, boots and stops the `feeld` AVD headlessly. |
| `src/screen.ts` | `ScreenStream`: streams the phone screen over the WebSocket and relays taps, drags and keys. |
| `src/setup.ts` | `SetupWizard`: Google sign-in, Play Store install of Feeld, APK sideload. |
| `src/location.ts` | Sets the emulator's GPS to the city chosen in Settings → Device. |
| `src/llm.ts` | `structuredCall`: one structured Claude call on the API or Agent SDK backend, plus the shared preamble, `contact_eli` tool and inbox check. |
| `src/classifier.ts` | Builds the screener request (text + screens), parses the two probabilities, computes the arithmetic posterior, decides the tier. |
| `src/prompt.ts` | The screener's system prompt (Bayesian procedure, fit guidance) and the calibration-feedback block. |
| `src/drafts.ts` | Drafts three ping openers in your voice from the profile and your past edits. |
| `src/rescore.ts` | Re-scores saved profiles without the phone; re-tiers the queue when thresholds change. |
| `src/store.ts` | `data/decisions.jsonl` read/write, reviews, grades, fit pool and percentiles. |
| `src/config.ts` | `Settings` schema (zod) and `data/settings.json` load/update. |
| `src/paths.ts` | `DATA_DIR` (or `$FEELD_DATA_DIR`), photos, errors, settings and decisions paths. |
| `src/test-llm.ts` | `npm run test:llm`: scores one fake profile end to end without the phone. |
| `public/index.html`, `public/app.js`, `public/style.css` | The dashboard: Live, To review and History tabs, settings sidebar, phone panel. |
| `scripts/emulator.sh` | One-time creation of the `feeld` AVD (Pixel 8, Android 15 with Play Store). |
| `scripts/install-app.sh`, `app/` | Build and install **Feeld Swiper.app**, a Dock launcher (`launcher.sh`, `Info.plist`, icon). |
| `.env.example` | Template for `.env` (`ANTHROPIC_API_KEY`, `PORT`). |
| `package.json`, `tsconfig.json` | Dependencies (see Why these dependencies) and TypeScript config; run with `tsx`, no build step. |

Why these dependencies: `express`/`ws` for the dashboard and phone stream, `sharp` for resizing screenshots and perceptual hashes, `zod` for settings and model output schemas, `@anthropic-ai/sdk` and `@anthropic-ai/claude-agent-sdk` for the two backends, `dotenv` for `.env`, `tsx` to run TypeScript directly.

## Runtime locations

- Project and installed copy: `~/Documents/agent-coding/feeld-swiper` (runs in place; `Feeld Swiper.app` in `/Applications` is only a launcher pointing here).
- Secrets: `.env` in the project (untracked; `.env.example` is the template).
- Settings: `data/settings.json`, edited from the dashboard sidebar.
- State: `data/decisions.jsonl` (every profile and decision), `data/photos/<id>/` (screens and crops), `data/errors/` (screenshots on failure). `FEELD_DATA_DIR` replaces `data/` wholesale. The whole `data/` folder is gitignored (personal, ~200 MB).
- Logs: the dashboard's Live tab (also `GET /api/state` → `log`); `data/server.log` when started from the Dock launcher, stdout under `npm run dev`.
- Android: the `feeld` AVD under `~/.android/avd/`; platform tools and command-line tools from Homebrew.
- LLM inbox (shared): `~/Library/Application Support/LLMInbox/messages.jsonl`, read with `llm-inbox`.

## Common tasks

Setup (once):

```bash
brew install --cask android-platform-tools android-commandlinetools   # if you don't have them
brew install openjdk@21
npm install
cp .env.example .env    # put your ANTHROPIC_API_KEY in .env (or set Backend to the Agent SDK in Settings and use your Claude Code login)
npm run emulator        # one time: creates the "feeld" device (Pixel 8, Android 15 with Play Store) and boots it once
```

Run, test, stop:

```bash
npm run dev                                   # dashboard at http://localhost:4848, reloads on source changes
npm start                                     # same, no reload (what the Dock launcher runs)
npm run typecheck                             # tsc --noEmit
npm run test:llm                              # one fake profile through the screener with the current settings; no phone needed
npm run test:llm -- --backend api --model claude-haiku-5-5   # cheapest end-to-end check of the API path
npm run test:llm -- --contact                 # asks the model to call contact_eli; a test message lands in `llm-inbox list`
FEELD_DATA_DIR=/tmp/feeld-test npm run dev    # a clean data folder for trying things out
kill $(pgrep -f 'tsx src/server.ts')          # stop a dashboard started by the launcher (then relaunch from the Dock)
tail -f data/server.log                       # launcher-started server log
```

On the phone panel: **Inspect screen**, **Next (no vote)** and **Test ping (no send)** check the driver against the real app without voting (see Tuning the driver).

Dock launcher: `npm run install-app` builds **Feeld Swiper.app** in /Applications: a Dock launcher that starts the dashboard if needed and opens it in your browser (sources in `app/`). Open it once, then right-click its Dock icon → Options → Keep in Dock.

On this machine the `feeld` device already exists. `npm run dev` boots it headless if it isn't running; the phone keeps running (and stays logged in) when you quit, unless you turn on "Shut the emulator down" in Settings → Device.

## Settings that matter

Dashboard sidebar, stored in `data/settings.json`:

| Setting | Default | Meaning |
|---|---|---|
| Like threshold | 0.50 | Recommend a like when P(meets criteria) ≥ this |
| Ping | on, ≥ 0.90 | Recommend a ping (a like with a message) above this; three openers are drafted for you |
| Drafting model / About you | claude-sonnet-5-5 / empty | Who writes the openers, and notes about you (interests, voice) they draw on. Your past edits to drafts are shown to it too |
| Fit: your date-me page / like ≥ / ping ≥ | empty / 0.60 / 0.80 | The page the model judges fit against (independently of diet), and the fit bars for a like and a ping. Flag clear good fits with ⭐ as reference cases |
| Prior | 0.10 | Base rate in your pool |
| Batch length | 10–150 min | Random session length |
| After a batch | stop | Or a random break (90–360 min) within active hours |
| Max profiles / batch | 100 | Judged or acted on |
| Next profile gesture | swipe left | How to move past a profile without voting: swipe left, swipe right, or keep scrolling (vertical feed). Test with **Next (no vote)** on the phone panel |
| Delay between profiles | 2.5–7 s | Random pause |
| Browse like a human | on | Uneven scroll pacing, double-takes, slow scroll back up before a like |
| Quick pass below | 15% | Two-stage judging (text + first screen, then all screens) |
| Max screens sent to model | 6 | Evenly spaced screenshots of the profile; ~1k tokens each |
| Max scrolls per profile | 12 | How far down a profile it reads |
| Model / effort | claude-opus-5 / medium | The screener (Opus 5.5, Sonnet 5.5 and Haiku 5.5 are also offered) |
| Backend | api | How calls reach Claude. **Claude API**: the Anthropic SDK with the key in `.env`. **Claude Agent SDK**: Claude Code as a library, run as a subprocess with every tool switched off (one prompt in, one JSON object out); by default it is launched without the API key so it uses this machine's Claude Code sign-in, or choose "API key" to bill the API through it. Switch back any time; nothing else changes |
| Device | feeld | AVD name, emulator window on/off, stop on exit, or a specific adb serial |

Outside the app:

- Android platform tools, command-line tools and OpenJDK 21 from Homebrew; the `feeld` AVD must exist (`npm run emulator`).
- The Agent SDK backend relies on this machine's Claude Code sign-in (`claude` login); the API backend on `ANTHROPIC_API_KEY` in `.env`.
- A Google account on the phone is needed to install Feeld from the Play Store; Feeld's travel mode must stay on "current location" for the Settings → Device city to apply.
- nightblock closes `api.anthropic.com` from midnight to 6am, so batches in that window fail their model calls.

## Gotchas learned

- Automation is against Feeld's terms; accounts can be restricted. Keep sessions modest.
- Emulators can trip Play Integrity checks. If Feeld refuses to run or log in on the emulator, a real Android phone with USB debugging works the same way (set its serial in Settings → Device).
- Reading a profile takes 10–25 s (a UI dump is ~1 s, plus human-like pauses). The phone panel streams at 2–8 fps depending on what's on screen.
- Cost: roughly 4–10k input tokens per profile with 6 screens; a few cents on Opus 5.
- The Connections/Chats tab is a secure window: screenshots are black there, so the phone panel goes dark. Not a bug.
- Feeld's "Exploring <city>" travel mode overrides the emulator GPS; leave it on "current location".
- Haiku 4.5 predates adaptive thinking and the effort parameter; `src/llm.ts` leaves both out for it.
- The Dock launcher runs `npm start` (no file watching), so source edits need the server killed and relaunched to take effect: `kill $(pgrep -f 'tsx src/server.ts')`, then open the app again.
- On the Agent SDK path the harness prefixes MCP tool names (`mcp__eli__contact_eli`); `src/llm.ts` renames the block back to `contact_eli` before the inbox check, which looks for the bare name.
- The shared inbox check runs `python3` with `-I`; the whole exchange (including base64 screens) is piped through stdin, which is only written to disk when the model actually contacted Eli.
