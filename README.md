# Feeld Swiper 🌱

A local web app that swipes Feeld for you, liking only profiles that are likely vegan, vegetarian, or otherwise not subsidizing factory farming (plus an "intellectual exception"). Each profile is scored by Claude with a Bayesian prompt: start from a base rate, update on the evidence in the bio, tags, and photos, and like only when the posterior clears your threshold. Same idea as the Tinder swiper, but Feeld has no web app, so this one drives the **real Feeld Android app running in an Android emulator** (or a real phone over USB) through ADB, and shows the phone live inside the dashboard.

## How it works

1. `npm run dev` starts the dashboard at http://localhost:4848 and boots the `feeld` virtual device **invisibly in the background**. The dashboard's **Phone** panel streams the phone screen; click to tap, drag to swipe, and type when the panel has focus. You never need the emulator's own window.
2. The **Setup** panel gets you from an empty phone to a logged-in Feeld: sign the phone into Google (Play Store), install Feeld, then log in to Feeld on the phone panel (phone number + SMS code, or Apple/Google). Your Feeld account is the same on every platform. Alternatively sideload an APK.
3. **Start batch** browses Discover for one session of random length (10–150 minutes by default). Feeld lets you move past a profile without liking or passing, and the app never votes on its own. For each **new** profile it scrolls through the card the way a person would, reading the text from Android's accessibility tree and taking a screenshot at each position, asks Claude for a probability, records a **provisional call** (recommend like / ping / pass), and browses on. Stage one sends the text plus the first screen; under the quick-pass threshold (15%) it decides on that alone, otherwise it sends every screen and re-scores.
4. Profiles the model recommends a **ping** for (P ≥ 90% by default) also get **three openers drafted by a stronger model** (Claude Opus 5 by default), written in your voice from the "About you" notes in Settings.
5. In the **To review** tab you decide: **Pass**, **Like**, **Ping…** (pick one of the three drafts, or write your own), or **Leave it** (no action on Feeld). Bulk buttons approve every recommended pass at once. Your choice is queued; your like or pass also counts as a grade on the model's call.
6. The **next batch** recognises reviewed profiles when they come round again in Discover (by name and age, cross-checked against the saved profile text) and does what you chose: taps Like or Pass, or opens the Ping composer, types your message, and sends. Already-judged profiles that you haven't reviewed yet are browsed past again without a vote. The batch ends when time is up, Feeld runs out of profiles, or it keeps showing profiles you've already seen.
7. The **History** tab shows every profile: filter by probability, batch, the model's call, your review, what was actually done on Feeld; grade each call, give your own estimate, leave notes. Grades, notes, and the standing "Guidance for the model" box are fed into every future prompt as calibration feedback.

Every decision is appended to `data/decisions.jsonl` with the profile text, photo crops, the screens it saw, your review, the ping drafts and the message you chose, and what was done on Feeld.

### Safety rails

Nothing is liked or passed without your review. Every tap and swipe the driver makes is gated on Feeld being the foreground app. Screens that look like your own profile, settings, membership, or a payment sheet are recognised as off-limits and only ever left with the Back key. Popup dismissal matches an explicit allowlist of "decline" labels (Not now, Maybe later, No thanks, Keep swiping…), never generic ones like Continue or OK. Like/Pass/Ping are only ever tapped by their button, found by label in the lower half of the screen; if the button isn't found the app reports it and does nothing. Moving past a profile uses the "next profile gesture" from Settings; if that gesture ever produces a match screen (meaning it registered as a like on your build) the batch stops itself and tells you. What you do by hand on the phone panel is not gated.

## Setup

```bash
brew install --cask android-platform-tools android-commandlinetools   # if you don't have them
brew install openjdk@21
npm install
cp .env.example .env    # put your ANTHROPIC_API_KEY in .env
npm run emulator        # one time: creates the "feeld" device (Pixel 8, Android 15 with Play Store) and boots it once
npm run dev
```

On this machine the `feeld` device already exists. `npm run dev` boots it headless if it isn't running; the phone keeps running (and stays logged in) when you quit, unless you turn on "Shut the emulator down" in Settings → Device.

## Settings (dashboard sidebar, stored in `data/settings.json`)

| Setting | Default | Meaning |
|---|---|---|
| Like threshold | 0.50 | Recommend a like when P(meets criteria) ≥ this |
| Ping | on, ≥ 0.90 | Recommend a ping (a like with a message) above this; three openers are drafted for you |
| Drafting model / About you | claude-opus-5 / empty | Who writes the openers, and notes about you (interests, voice) they draw on |
| Intellectual exception | on | Recommend a like regardless of diet when the model's probability of "exceptionally intellectual and open-minded" reaches 60%. Flag reference cases with 🧠 |
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
| Model / effort | claude-opus-5 / medium | The screener |
| Device | feeld | AVD name, emulator window on/off, stop on exit, or a specific adb serial |

## Tuning the driver

Feeld's Android UI isn't something I could see while building this (the app needs a Google account to install), so the screen recognition in `src/feeld.ts` (`SELECTORS`) is heuristic: like/pass buttons by content-description or resource id, match/out-of-likes/logged-out screens by text patterns. Once Feeld is installed and logged in, press **Inspect screen** on the Discover tab and check that `likeButton`, `passButton` and `pingButton` are found and `state` is `discover`. If not, look through `nodes` for the real labels and extend the regexes. Then press **Next (no vote)** and watch the phone panel: the next profile should appear with no heart or X animation and no match screen. If the gesture votes on your build, change "Next profile gesture" in Settings. The ping flow (Ping button → composer → Send) is likewise untested against the real app. `texts` shows exactly what the bot can read; photos are cropped from `ImageView` nodes, with the full screenshots as fallback.

## Caveats

- Automation is against Feeld's terms; accounts can be restricted. Keep sessions modest.
- Emulators can trip Play Integrity checks. If Feeld refuses to run or log in on the emulator, a real Android phone with USB debugging works the same way (set its serial in Settings → Device).
- Reading a profile takes 10–25 s (a UI dump is ~1 s, plus human-like pauses). The phone panel streams at 2–8 fps depending on what's on screen.
- Cost: roughly 4–10k input tokens per profile with 6 screens; a few cents on Opus 5.
