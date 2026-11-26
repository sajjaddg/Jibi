# Sync protocol (v2)

The contract between `sync/` and its two clients, `app/` (`Sync.kt`) and `pwa/` (`sync.ts`).
The architecture and its reasons are in [backend-plan.md](backend-plan.md). Where this document
and the Worker disagree, the Worker is what runs: fix the drift here. `sync/test/protocol.test.ts`
fails when the kinds, the endpoints or the error codes listed here are not the Worker's, and
`sync/test/vectors.test.ts` when a golden vector no longer opens.

## 1. The parts

A **household** is one Durable Object with its own SQLite database, named by a random id (`hid`,
16–64 hex characters). It holds devices, one-time pairing codes and records. It has no key and
reads nothing.

A household has a **type**, set at `claim` and never changed:

| | `family` (default) | `personal` (the vault) |
|---|---|---|
| members | several | one: every device is that member |
| `pair` | the newcomer must be new | the device becomes the vault's member, whatever it sends |
| `remove`, `leave`, `revoke {member}` | yes | `403 forbidden_type` |
| `revoke {device}` | yes | yes, except the last device: `409 last_device` |
| ends with its last device | yes | never; only `destroy` |

A **device** holds a token `<hid>.<secret>` (secret: 64 hex), sent as `Authorization: Bearer …`
or `X-MuchToman-Token`. The server keeps only `sha256(secret)`. A device belongs to a **member**.

A **scope** is a keyed stream, today `family:<hid>`, with its own 32-byte AES-GCM key that only
devices have. The server also keeps each token's list of scopes, as a second lock.

Every POST carries `Content-Type: application/json`; anything else is `415`.

## 2. The envelope

```json
{ "id": "goal:…", "scope": "family:…", "kind": "goal", "updatedAt": 1795000000000,
  "device": "…", "ownerMemberId": "…", "authorMemberId": "…", "deleted": false,
  "nonce": "<base64>", "body": "<base64>" }
```

| Field | Rule |
|---|---|
| `id` | 1–256 characters, unique in the household. See § 4 |
| `scope` | 1–128 characters, one of the token's |
| `kind` | § 3. Absent means `legacy` |
| `updatedAt` | whole milliseconds, ≥ 0. The server clamps it (§ 6) |
| `device` | 1–64 characters. Ignored on write: the server stores the token's device |
| `ownerMemberId` | ≤ 64 characters |
| `authorMemberId` | set by the server from the token; whatever a client sends is ignored |
| `deleted` | a tombstone |
| `nonce` | 12 random bytes, standard base64, never reused with a key |
| `body` | AES-GCM ciphertext with its 16-byte tag, standard base64 without line breaks, ≤ 65536 characters |

### Sealing

AES-256-GCM over the UTF-8 bytes of a JSON string, with additional data

```
recordAad = mt1|<scope>|<kind>|<id>
```

so a body cannot be served under another id, kind or scope. The id goes last, so a `|` inside one
shifts nothing. The stamp is **not** bound, because the server may clamp it.

A reader opens with the AAD first and falls back to no AAD, the seal every record before
`recordAad` wore.

### Tombstones

`deleted: true`, and a body sealing exactly:

```json
{ "v": 1, "id": "<the record's own id>", "deleted": true }
```

A client honours a deletion only when that payload authenticates and names the record it arrived
on; the flag outside the seal is not believed. `note` has no tombstone (an empty note says it), and
`exclusion` is refused one (an empty list says it).

## 3. Kinds

The Worker accepts exactly the kinds in `sync/src/kinds.ts`. An unknown kind is `400 invalid_kind`
for the **whole batch**, so a new kind is deployed to `sync/` before any client sends it, and a
client sends only what `GET /v1/hello` lists, keeping the rest to try later.

### Accepted today

<!-- kinds -->
| Kind | Id | Written by | Payload |
|---|---|---|---|
| `legacy` | anything not reserved below | its author | records from builds older than kinds |
| `member` | `member:<memberId>` | that member only | `memberId, name, sharesSms, avatar` |
| `transaction` | `txn:<memberId>:<hex of local ref>` | its owner only | `ownerMemberId, sourceKind, at, amountRial, direction, bank, categoryId, categoryName, categoryKind, transfer, categoryGlyph, categoryEditorId, categoryUpdatedAt, categoryEditedAt, merchant, member?` |
| `category` | `category:<sha256 of family ref>` | any member | `target, categoryId, categoryName, categoryKind, categoryGlyph, editedByMemberId, categoryEditedAt, split?, splitCategories?` |
| `asset` | `asset:<memberId>` | that member only | `memberId, totalToman, items[{name, toman}]` |
| `note` | `note:<sha256 of family ref>` | any member | `target, note, editedByMemberId` |
| `goal` | `goal:<goal id>` | any member | `goalId, nameFa, targetRial, goalKind, categoryId, period, startsOn, endsOn, createdAt, ownerMemberId, editedByMemberId` |
| `exclusion` | `exclusion:report` | any member | `categoryIds, editedByMemberId` |
| `fund` | `fund:<fund id>` | any member | `fundId, nameFa, ownerMemberId, createdAt` |
| `fund_entry` | `fund_entry:<entry id>` | any member | `fundId, amountRial`, and what #40's clients add |
| `share_split` | `share_split:<transaction ref>` | any member | `txnRef, parts[{memberId, amountRial}]` |
| `settlement` | `settlement:<id>` | any member | `fromMember, toMember, amountRial, at` |
| `sms` | `sms:<message SHA-256>` | vault only | set by #29 |
| `manual_txn` | `manual_txn:m:<uuid>` | vault only | set by #29 |
| `anchor` | `anchor:<row id>` | vault only | set by #29 |
| `rule` | `rule:<rule id>` | vault only | set by #30 |
| `decision` | `decision:<ref>:<decision kind>` | vault only | set by #30 |
| `link` | `link:<row id>` | vault only | set by #30 |
| `holding` | `holding:<asset id>` | vault only | set by #32 |
| `bank` | `bank:<bank or account name>` | vault only | set by #32 |
| `loan_person` | `loan_person:<person id>` | vault only | set by #32 |
| `override` | `override:<asset id>` | vault only | set by #32 |
| `day` | `day:<date>` | vault only | set by #33 |
| `pref` | `pref:<key name>` | vault only | set by #33 |
| `entitlement` | `entitlement:<slot nonce>` | vault only | set by #45 |
<!-- /kinds -->

Every payload also carries `kind`, which Android leaves out when it equals the class default
(`encodeDefaults` is off), as it does any defaulted field. A reader accepts both, and ignores a
field it does not know. Money is `Long` Rial (`amountRial`, `targetRial`); `asset` carries a
displayed Toman figure, priced on the owner's phone.

An id starting with `member:`, `txn:`, `category:`, `asset:`, `note:`, `goal:`, `exclusion:`,
`fund:`, `fund_entry:`, `share_split:` or `settlement:` must carry that kind (`400 invalid_kind`), and a record of one of those
kinds must have an id that starts so (`400 invalid_id`).

A fund's balance is added up from its entries on each device and stored nowhere. Paying a shared
transaction out of a fund is an entry that names the transaction.

A `share_split`'s parts add up to the transaction's amount, in `Long` Rial, with what does not
divide going to whoever paid. The clients enforce that; the server cannot see it. Who owes whom is
shown only from the reader's own side, and never as a table that orders members (PRODUCT.md).

### Vault kinds

Accepted only in a household of type `personal`. In a family each such record is refused on its
own: the push answers `200` with `rejected: [{id, code: "kind_not_allowed"}]`, the rest of the
batch is stored, and `accepted` counts without them. A client treats a rejected record as not
sent.

In a vault the id of a vault-only record starts with `<kind>:` (`400 invalid_id`), so two kinds
can never land on one row. Payload shapes are set by the client issues that introduce them, each
replacing the placeholder in its golden vector.

| Source on the device | Kind | Key | Merge |
|---|---|---|---|
| `sms_source` | `sms` | the message's SHA-256 | append-only; delete = tombstone |
| `manual_txn` | `manual_txn` | `m:<uuid>` | LWW |
| `balance_anchor` | `anchor` | row id | LWW |
| `category` | `category` (existing) | category id | LWW |
| `rule` | `rule` | rule id | LWW |
| `txn_decision` | `decision` | `<ref>:<decision kind>` | LWW |
| `link_decision` | `link` | row id | LWW |
| `goal` (budget, goal, installment, bill, cheque) | `goal` (existing) | row id | LWW |
| prefs `holdings` | `holding` | asset id | LWW per asset |
| prefs `bankAccounts`, `disabledBanks`, `extraBankNumbers` | `bank` | bank or account name | LWW; `balance` stays the Toman `Double` |
| prefs `loans` | `loan_person` | person id | LWW per person |
| prefs `overrides` | `override` | asset id | LWW |
| prefs `history`, `rateHistory` | `day` | the date | append-only, one a day |
| other shared prefs (`name`, `quipTone`, `showRial`, `textSize`, `reportExcluded`, `ledgerStartsOn`, `installmentReminder`) | `pref` | key name | LWW per key |
| Pro entitlement | `entitlement` | its slot nonce | LWW |

**Never synced** (they belong to one device): `lockEnabled`, `widgetLock`, `themeMode`, `seenSms`,
`smsScannedTo`, `notifyScannedTo`, `smsSchema`, `smsFoldNeedsRefresh`, `dismissedUpdate`,
`onboarded`, `smsEnabled`, every notification mark (`budgetMarks`, `filingMark`, …), and
`derived.db`, which each device rebuilds from `sms`.

## 4. Endpoints

<!-- endpoints -->
| Call | Body | Answer |
|---|---|---|
| `POST /v1/claim?hid=` | `{scopes, memberId?, deviceId?, type?, recovery?}` | `{secret, memberId, deviceId}` — once per household |
| `POST /v1/recover` | `{hid, recovery, deviceId?, revoke?}` | `{secret, scopes, memberId, deviceId}` — no token |
| `POST /v1/recovery/rotate` | `{recovery}` | `{rotated: true}`; the old secret stops at once |
| `POST /v1/invite` | `{scopes?, expiresIn?}` | `{code, expiresIn, places}` — a one-time code for ten minutes (default) or a day (`86400000`); at most 16 outstanding; `places` is how many more may join |
| `GET /v1/invites` | — | `{invites: [{id, expiresAt}]}`; admins. `id` cannot redeem |
| `POST /v1/invites/cancel` | `{id}` | `{cancelled: true}`; admins. The code then answers `invalid_code` |
| `POST /v1/pair` | `{code, memberId?, deviceId?}` | `{secret, scopes, memberId, deviceId}` |
| `POST /v1/identity` | `{memberId, deviceId}` | the same — one rebinding for a token older than identity |
| `GET /v1/hello` | — | without a token `{protocol, kinds}`; with one, also `{type, plan, quota, used, minClient}` |
| `GET /v1/sync?since=&limit=&live=` | — | § 5 |
| `POST /v1/sync` | `{records}` (≤ 500, ≤ 2 MiB) | `{seq, accepted, clamped: [{id, updatedAt}]}` |
| `POST /v1/remove` | `{member, record}` — the member's tombstone | `{revoked, seq, clamped}` |
| `POST /v1/leave` | `{record}` — the caller's tombstone | `{revoked, seq, clamped}` |
| `POST /v1/destroy` | `{}` | `{destroyed: true}` |
| `POST /v1/revoke` | `{device}` or `{member}` | `{revoked}`; every outstanding code dies |
| `POST /v1/rotate` | `{secret?}` | `{secret}`; the old one stops at once |
| `GET /v1/devices` | — | `{devices: [{memberId, addedAt}]}`; a vault's also carry `id` |
| `POST /v1/role` | `{member, role}` | the same; families only, admins only |
| `GET /v1/roles` | — | `{role, members: [{memberId, role}]}`; families only |
<!-- /endpoints -->

`pair` is the one call a device makes before it has a secret: it sends `<hid>.` followed by 64
zeros, which only routes the request.

`protocol` changes only when an old client could no longer talk to the server at all. `minClient`
is the oldest build (`versionCode`) that should sync; 0 is no floor.

A client may check whether its token still works with `since` set to the largest number it has.
That is answered normally and does **not** count as having read anything.

### Recovery (vaults only)

`recovery` is 32 random bytes in hex, made on the client, given at `claim` and kept in her kit
beside the `hid` and the vault key. The server stores only its SHA-256. Sending it to a family's
claim is `403 forbidden_type`.

`recover` with it enrols a new device as the vault's member. Every failure — no such household, a
family, no kit, a wrong or replaced secret — is `404 not_recoverable`. The device limit applies: a
full vault answers `409 {code: "too_many_devices", devices: [{id, addedAt}]}`, and the same call
with `revoke: <id>` swaps that device for the new one. `revoke` may be sent even when there is room.

`recover` is limited to 5 a minute per address and per household.

### Push

Shape is checked for the whole batch first: one bad record is a `4xx` and nothing is written.
Ownership and size are checked record by record as they are written, so on such an error the
records **before** the failing one are stored. Re-sending is always safe (§ 6).

### Who may do what

Any device of a vault may destroy it. In a family every member has a **role**:

| | `admin` | `member` | `readonly` |
|---|---|---|---|
| pull, `hello`, `devices`, `roles`, `rotate`, `leave`, revoke own devices | yes | yes | yes |
| push | yes | yes | no, except deleting their own `transaction` and `asset` rows |
| `invite`, `remove`, revoke someone else | yes | yes, until `ROLES_RESTRICT_MEMBERS`; never against an admin | no |
| `role` | yes | no | no |
| `destroy`, once the only member | yes | no | no |

A refused call is `403 forbidden_role`; a read-only push answers `200` with those records in
`rejected` as `{id, code: "read_only"}`.

The founder (the member who claimed) is an admin while there, cannot be removed or revoked by
anyone else, and cannot have another role. New members are `member`. A family is never without an
admin: `role` refuses to take the last one away (`409 last_admin`), and if the founder leaves
having named nobody, the longest-standing member who is not read-only is the admin.

**`ROLES_RESTRICT_MEMBERS` is off** (`sync/src/roles.ts`): released clients let any member invite
and remove, so a plain member keeps that until the builds that know about roles are out.

A member leaves with `leave`. A family whose last device goes is wiped, and its id can be claimed
again from nothing. A vault differs as § 1 says.

## 5. Pull, cursors, compaction

`GET /v1/sync?since=N&limit=L` (L ≤ 1000, default 500) answers

```json
{ "seq": 41, "records": [ … ], "hasMore": false, "horizon": 0,
  "rotationClientSecret": true, "memberId": "…", "deviceId": "…", "primaryMemberId": "…" }
```

Records after `since`, oldest first, only in the token's scopes; a page also stops near 768 KiB.
The next request uses `seq` as `since`. Keep going while `hasMore`.

`seq` is the household's counter: it moves up with every stored write, and a replaced record takes
a new one.

Asking after `N` records that the device holds everything up to `N`: a number, never a time. With
compaction on (`COMPACTION`, off until both clients handle what follows), a daily alarm removes
tombstones that every device has read and whose stamp is over 90 days old. A device whose first
unread row is over 180 days old is no longer waited for. `horizon` is the highest `seq` a
tombstone was ever removed at.

A pull with `since < horizon` and without `live=1` answers `410 {code: "resync_required",
horizon}`. The client then pulls `since=0&live=1` to the end, which omits tombstones at or below
the horizon and sends those above it. **What that walk delivers is everything that is live:** the
client drops synced rows that did not arrive, keeping only what it has not yet published.

## 6. Merging

Last write wins, on the server and again on each client.

- The server stores `min(updatedAt, now + 24 h)` (`MAX_STAMP_SKEW_MS`) and returns changed stamps
  in `clamped`, so both sides agree.
- A write is skipped (not an error) when the stored stamp is later, or equal and the stored author
  member id is ≥ the pusher's. So a retried batch changes nothing, and an edit must move the stamp:
  `max(now, previous + 1)`.
- In a vault every device is the same member, so on an exact tie the first write stands. A client
  takes what the server sends.
- Clients clamp an arriving stamp to `now + 48 h` (`MAX_SYNC_STAMP_SKEW_MS`).
- Shared budgets, goals, exclusions and filings break a same-millisecond tie by editor member id.
- `sms` and `day` are append-only: two devices make the same id from the same message or date.

## 7. Limits

The hard ceilings, which hold for every household:

| | |
|---|---|
| live records | 120,000 (`409 household_full`) |
| rows including tombstones | 480,000 |
| ciphertext bytes | 256 MiB; a shrinking edit or a delete is always accepted |
| devices | 16 |
| per address, a minute | 1200 calls; 5 claims; 30 membership changes per household (`429`, `retry-after: 60`) |

### Plan quotas (`sync/src/plans.ts`)

**Switched off**: while `PLAN_LIMITS_ENFORCED` is false nothing below applies, and `hello` reports
the hard ceilings as the quota.

| | vault free | vault pro | family free | family pro |
|---|---|---|---|---|
| devices | 2 | 8 | 4 | 16 |
| members | 1 | 1 | 2 | 8 |
| ciphertext | 32 MiB | 256 MiB | 256 MiB | 256 MiB |

Pro counts until 7 days after the entitlement's `exp`, worked out each time and never written.

Over a limit the household takes nothing **new**; it loses nothing. Every edit that does not grow,
and every delete, is accepted, and no device or member is removed.

- `invite`, `pair`: `409 {code: "quota_exceeded", what: "devices" | "members", limit, used}`.
- `recover` without `revoke`: the same, with `devices: [{id, addedAt}]`. With `revoke` it swaps,
  which is always allowed.
- push: the record that would grow past `bytes` is listed in `rejected` as `{id, code:
  "quota_exceeded", what: "bytes", limit, used}`; the answer is `200` and the rest is stored.

## Entitlement (Pro)

What a purchase becomes. `billing/` signs it, and the app, the PWA and `sync/` check it offline.

```
base64url(payload) "." base64url(signature)          // no padding
payload  = {"exp":…,"iat":…,"plan":"pro","slot":"<32 hex>","v":1}
signature = Ed25519 over the UTF-8 of "mt1.entitlement." + the first part
```

- `exp` and `iat` are epoch milliseconds on whole UTC days, so they say no more than the day.
- `slot` is 16 random bytes the **client** makes, one for each household it wants Pro in. It names
  no license and no household.
- A verifier holds a **list** of raw 32-byte public keys (base64url), so a key can be rotated.
- It checks the signature first, then `v == 1`, `plan == "pro"`, and the shapes; then it is
  expired once `now > exp + 7 days`.
- Golden vectors: `billing/test/vectors/*.json`, made by `node tools/make-entitlement-vectors.mjs`.
  Each is `{name, keys, token, now, result: "ok"|"expired"|"invalid", claims}`. The Kotlin and
  PWA verifiers are still to be written (#45).

## 8. Errors

`{"code": "…"}` with the status. A client matches the code, never the text.

<!-- errors -->
| Code | Status | Meaning |
|---|---|---|
| `invalid_request` | 400 / 413 | not a JSON object, or a field the call needs is missing |
| `invalid_record` | 400 | a record is not an object |
| `invalid_id` | 400 | id empty, too long, or outside its kind's namespace |
| `invalid_scope` | 400 | scope empty or too long, or no scope asked for |
| `invalid_device` | 400 | `device` empty or too long |
| `invalid_kind` | 400 | unknown kind, a reserved id under another kind, or a tombstone where none is allowed |
| `invalid_member` | 400 | `ownerMemberId` too long |
| `invalid_updated_at` | 400 | not a whole, non-negative millisecond |
| `invalid_nonce` | 400 | nonce empty or too long |
| `invalid_identity` | 400 | `identity` without two ids |
| `invalid_type` | 400 | `claim` with a type that is neither `family` nor `personal` |
| `kind_not_allowed` | 200, per record | a vault-only kind pushed to a family, listed in `rejected` |
| `invalid_since` | 400 | |
| `invalid_limit` | 400 | |
| `invalid_secret` | 400 | a rotation secret that is not 64 hex |
| `invalid_expiry` | 400 | `expiresIn` that is neither of the two |
| `invalid_recovery` | 400 | a recovery secret that is not 64 hex |
| `invalid_member_tombstone` | 400 | `remove`/`leave` record does not bury that member |
| `invalid_hid` | 400 | |
| `unauthorised` | 401 | no token, or not one of this household's |
| `invalid_code` | 403 | pairing code unknown, used or expired |
| `forbidden_scope` | 403 | a scope the token does not hold |
| `forbidden_owner` | 403 | writing a record only another member may write |
| `forbidden_primary` | 403 | only the founder may, or nobody may do this to the founder |
| `forbidden_type` | 403 | a call that is not for this type of household |
| `forbidden_role` | 403 | the caller's role does not allow it |
| `read_only` | 200, per record | a read-only member's write, listed in `rejected` |
| `invalid_role` | 400 | not `admin`, `member` or `readonly` |
| `last_admin` | 409 | the family would be left with no admin |
| `unknown_member` | 404 | |
| `not_recoverable` | 404 | § 4, recovery |
| `unknown_device` | 404 | `revoke` names no device of this vault |
| `unknown_invite` | 404 | no open code of that id |
| `already_claimed` | 409 | |
| `identity_exists` | 409 | `pair` with an id somebody has had |
| `identity_locked` | 409 | |
| `device_exists` | 409 | |
| `member_exists` | 409 | |
| `too_many_devices` | 409 | |
| `last_device` | 409 | revoking a vault's only device |
| `household_full` | 409 | § 7 |
| `quota_exceeded` | 409, or 200 per record | § 7, plan quotas |
| `members_remain` | 409 | `destroy` while others are members |
| `resync_required` | 410 | § 5 |
| `body_too_large` | 413 | |
| `too_many_records` | 413 | |
| `unsupported_media_type` | 415 | a POST not labelled JSON |
| `rate_limited` | 429 | |
| `internal` | 500 | |
| `unavailable` | 502 | the rates Worker behind a proxied path did not answer |
<!-- /errors -->

Only `/v1/*` answers are counted (endpoint, status, client version, code — `sync/src/metrics.ts`).
Clients send `X-MuchToman-Client: <version> <platform>`.

## 9. Release order

1. A new **kind**: `sync/src/kinds.ts`, deployed, then clients.
2. A new **shape** a client must be able to read: bump `SYNC_READ_VERSION` in `Sync.kt` and
   `sync.ts` together, so each updated client pulls the household from the start once. An older
   client drops what it cannot open and moves its cursor past it.
3. Never point anything at `workers.dev`: Iran sinkholes it.

## 10. Golden vectors

`sync/test/vectors/*.json`, made by `node tools/make-sync-vectors.mjs` and never by hand. Each is

```json
{ "name": "goal", "kind": "goal", "scope": "…", "id": "…", "aad": "mt1|…" , "key": "<base64url>",
  "nonce": "<base64>", "plaintext": "…", "body": "<base64>" }
```

`aad` is `null` for the unbound legacy seal. The vault kinds' vectors carry a placeholder payload
(`{"kind": …}`) until their shapes exist; they pin the seal and the id, nothing about the content.
A reader must open `body` to `plaintext`, and sealing
`plaintext` with the same key, nonce and AAD must give `body` byte for byte. An unknown field fails
the run, as in the SMS corpus. There is one vector for every accepted kind. The keys are public
test keys and the nonces are fixed, which no real record may ever be.

The Kotlin (`SyncVectorsTest`) and PWA tests that read these files are still to be written (#17).
