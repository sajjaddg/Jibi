# PRODUCT.md — چقدر تومن (MuchToman)

Inferred from README.md, DEVELOPMENT.md, and the codebase on 2026-08-21 (no interview; the
redesign brief asked for one pass). Assumptions are marked.

## What it is

An Android app that shows **what all your money adds up to in Toman**, and where it goes. Persian UI,
RTL, Persian digits, big type. Bank balances are read from SMS on the phone; everything else
(fiat, gold, coins, crypto, stocks, property) is valued at free-market rates. A household
ledger, budgets, savings goals, installments, and two reports (دخل و خرج, دارایی) sit on top.

## Who it is for

Persian speakers keeping track of their own money or a household's, on Android or, through the
PWA, on an iPhone. **Legibility beats density everywhere.** Figures are
truncated, never rounded up; every number can be traced back to a transaction; large amounts
are spelled out in words as a guard against misreading by a factor of ten.

## Platform

android, and the same app as a PWA for iPhone (`pwa/`) — every feature ships on both
(AGENTS.md). The PWA reads pasted bank messages instead of the SMS inbox.

Material 3, as Jetpack Compose renders it. minSdk 24. Two flavours (full / lite) × dev
sandbox build type. One typeface: Modam variable (wght 200–900, wdth 70–100) — the only face
with the required Persian coverage; tightness comes off the width axis, never tracking.

## Non-negotiables (from code and README)

- No points, streaks, confetti, or comparison with others (FCA finding; deliberate).
- No analytics SDK and no identifiers (2026-09-26). The app reports two things: one count a day
  (version + installing store, on the day's first rates request) and a crash report only after
  she says send. The totals are public at muchtoman.com/usage. Anything beyond that is a new
  decision. One was taken on 2026-09-27: the feedback form (تنظیمات ← درباره ← بازخورد) emails
  what she types, the contact she chooses to leave and the version to the developer, only
  when she presses send.
- The services count their own answers, not her (2026-11-26): one row per request to the sync and
  billing APIs holding the endpoint, the status, the client's version and platform, and, on a
  refusal, an error code from a fixed list. No household, device, member, token, address, scope or
  license, so no row can be traced to anyone or joined to another. Read by the developer only;
  none of it appears on muchtoman.com/usage. A fifth field is a new decision.
- Missing rates are never zero; stale rates are named in words, not colour alone.
- Gain is green — the convention every Iranian bank app shares.
- Warnings are words first; colour only confirms.
- Every destructive action is two taps; TalkBack hears the armed state.
- Charts run left-to-right even in RTL (Iranian bank-app convention).
- Light and dark are both first-class, following the system by default.

## Sync and the vault (decided 2026-11-26, #15)

Her own whole state — everything the encrypted backup carries — can be kept in step across her own
devices, through a **vault**: a household with one person in it, on the same service the family
ledger uses. The family stays what it was, a separate place holding only what members share.

- **Optional and off until she turns it on**, like sharing SMS. The app is complete without it.
- **Free for up to two devices.** Losing data is a harm, not a luxury to sell.
- **Raw bank messages go into the vault and never into the family.** A second device needs them to
  re-read with a newer parser.
- **No account.** A vault is a random id and the keys on her devices. No e-mail, number or password.
- **What the server holds:** the random ids of the vault, its devices and its one member; a hash of
  each device's token and of the recovery secret; when each device joined and how far it has read
  (a number, not a time); the plan and the day it runs out; and for each record an opaque id, its
  kind, scope, order, time of writing, size and ciphertext. Vault ids are keyed hashes, so they say
  nothing about a bank, an asset or a message. In the **family**, the id of a record made from a
  bank message still contains a hash of that message.
- **What it cannot read:** amounts, balances, message text, names, merchants, categories, notes. The
  key never leaves her devices, not even wrapped in a passphrase.
- **Recovery is the kit and nothing else** (`vault id + recovery secret + vault key`, as a QR code,
  as text, and inside the backup file). With no kit and no device, nothing comes back, and the app
  says so in words.
- **Never deleted for being unused.** Only `/v1/destroy`, which she asks for with two taps, removes
  a vault; its last device cannot simply be revoked. After that, Cloudflare's own point-in-time
  recovery may hold it for up to 30 days, and the privacy text says so.

## Pro (decided 2026-11-26, #16)

Pro pays for what costs the service something, and **never holds her data hostage**. When it ends,
nothing is deleted or locked: everything can still be read, edited, deleted and exported; only
something new beyond the free limits is not taken. Reading and export are never behind it.

| Server limit | Free | Pro |
|---|---|---|
| devices in a vault | 2 | 8 |
| members of a family | 2 | 8 |
| devices in a family | 4 | 16 |
| vault size | 32 MB | 256 MB |
| family size | 256 MB | 256 MB |
| households one license covers | — | one vault and one family |

- **No account.** A purchase becomes a signed entitlement the app checks offline, with seven days of
  grace after it runs out. The seller never learns which household it is used in.
- **No pressure.** No countdowns, «today only», nagging or comparison.
- **The `lite` flavour has no Pro** and stays as it is.
- The limits above are built and **switched off**: until there is something to buy, nothing is
  limited beyond the hard ceilings.
- Not decided yet: prices and periods (and product ids), the PWA's payment gateway (waits on #18),
  refunds, and the list of what is free today and stays free.

## Brand commitment (2026-08-21 redesign)

**Wise design language, adapted to Persian** (user-pinned): forest green `#163300` +
bright green `#9FE870` as the identity pair, white/near-white light theme with gray-green
cards, forest-black dark theme, amber caution, pill buttons, circular icon chips, flat
colour instead of gloss, spring motion. The previous world (deep teal-green + gold on warm
paper) is retired. ASSUMPTION: the Wise reference is the Wise *mobile app* (Operate mode),
not their marketing site.
