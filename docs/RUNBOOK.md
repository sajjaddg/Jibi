# Runbook

What to do when something is broken. Operations that are routine are in
[DEVELOPMENT.md](../DEVELOPMENT.md); this is the other kind. Cloudflare's behaviour quoted here was
read from its documentation on 2026-11-26; check again before relying on a limit.

| Service | Directory | Domain | State it holds |
|---|---|---|---|
| `muchtoman-rates` | `worker/` | rates.muchtoman.com | R2 bucket `muchtoman-history` (public prices) |
| `muchtoman-sync` | `sync/` | sync.muchtoman.com | one SQLite Durable Object per household (ciphertext) |
| `muchtoman-sync-staging` | `sync/` `env.staging` | staging-sync.muchtoman.com | its own households |
| `muchtoman-billing` (not deployed) | `billing/` | pay.muchtoman.com | D1: licenses and redemptions |
| `muchtoman-billing-staging` (not deployed) | `billing/` `env.staging` | staging-pay.muchtoman.com | its own D1 |

Never answer an incident by pointing anything at `workers.dev`: Iran sinkholes the whole domain.

## First five minutes

1. `cd sync && pnpm run tail` (or `worker && pnpm run tail`). The Workers log only their own
   `console.error` lines; there are no request logs, on purpose.
2. Run the error query below. `endpoint` and `code` usually name the problem.
3. `pnpm exec wrangler deployments list` in the package: did it start with a deploy? Every deploy
   carries its commit as the message. If so, read [Rollback](#rollback) **before** rolling back.

## What to watch

Read the `muchtoman_sync` dataset with an *Account Analytics: Read* token
([DEVELOPMENT.md](../DEVELOPMENT.md) § What the sync Worker counts):

```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $TOKEN" \
  --data "SELECT blob1 AS endpoint, blob2 AS status, blob4 AS code, SUM(_sample_interval) AS n
          FROM muchtoman_sync
          WHERE timestamp > NOW() - INTERVAL '1' HOUR AND blob2 >= '400'
          GROUP BY endpoint, status, code ORDER BY n DESC FORMAT JSONEachRow"
```

Nothing sends an alert by itself: no notification is configured, and configuring one is a cloud
resource the owner creates. Until then, run the query after every deploy and once a day.

| Signal | Act when | Likely cause, first step |
|---|---|---|
| status `5xx` | over 1% of requests in an hour, or any after a deploy | `tail`; roll back if it began with the deploy |
| `household_full` | any | a household at a ceiling (`MAX_*` in `sync/src/index.ts`); is compaction on? |
| `quota_exceeded` | a step up | a plan limit set too low, or plan limits switched on by mistake |
| `invalid_kind` | any | a client is ahead of the server: deploy `sync/` (below) |
| `resync_required` | any while `COMPACTION` is `off` | should be impossible; check which version is deployed |
| `rate_limited` | a step up | a flood, or a client retrying in a loop |
| billing verify errors | any sustained | a store or gateway is unreachable from Cloudflare |

For billing, run the same query against `muchtoman_billing`. A `200` push that rejected records
(`quota_exceeded`, `read_only`) is not counted by code: only refused requests are.

The rates Worker's own trouble is the `rates build degraded` log line, and a failed cron run is a
missing day in `/history` (`history point not recorded`).

## Deploy order

Server before client, always, for anything a client starts to send. And between the servers:

1. `billing/`
2. `worker/`
3. `sync/` (it builds and serves the PWA, and proxies `worker/`)
4. Android tag.

`worker/` needs the R2 bucket `muchtoman-history` to exist or its deploy fails.

`COMPACTION` in `sync/wrangler.jsonc` stays `off` until the Android and PWA builds that handle
`410 resync_required` are released and in use.

## Rollback

```bash
cd sync   # or worker
pnpm exec wrangler deployments list
pnpm exec wrangler rollback <version-id> --message "why"
```

A rollback changes the code that runs and **nothing it has stored**. It reaches the last 100
versions, and is refused across a Durable Object class migration (the `migrations` array in
`wrangler.jsonc`) or when a bound bucket no longer exists.

Before rolling `sync/` back, check each of these:

- **Kinds.** The server-first rule holds backwards too. If clients already send a kind the older
  version does not know, it answers `400 invalid_kind` to the whole batch, and those phones stop
  syncing entirely. Read `sync/src/kinds.ts` at the target commit. If a released client sends
  anything not on that list, do not roll back; fix forward.
- **Compaction.** Never roll back to a commit between `a906d9c` and `cadfac3` (compaction without
  its switch): it purges tombstones, and released clients cannot handle what follows.
- **Schema.** Safe to run: `sync/src/migrations.ts` only adds, and older code ignores columns and
  steps it does not know. What it also ignores is what they mean:
- **Vaults.** Once any client has made one, never roll back past #79 (`1c17f3b`). Older code takes
  a vault for a family: it would wipe it when its last device leaves, and refuses its kinds.
- **Roles.** Rolling back past #85 stops read-only being enforced.
- **PWA.** The PWA ships inside this Worker, so it goes back too. Its IndexedDB does not: check the
  older PWA can still open what the newer one wrote.

The PWA's fix-forward is usually safer than its rollback.

## Restoring a household (Durable Object point-in-time recovery)

SQLite-backed objects can be put back to any moment of the **last 30 days**. There is no dashboard
or CLI button: it is called from code inside the object, and it **does not work under
`wrangler dev`**, so it can only be rehearsed on staging.

What it can and cannot do:

- One household at a time, and only one whose id you have. The server logs no ids and cannot list
  them; the owner has to give theirs (it is the part of their token before the dot). Never ask for
  the whole token.
- It restores everything the object holds, **devices included**. A phone revoked since that moment
  gets its access back, and a phone that rotated its token since gets `401` and has to pair again.
  After a restore, tell the owner to check the device list and revoke again.
- `seq` goes backwards. Phones have already "read" past the restored rows, so they would never be
  sent them again, and would also miss new writes that reuse those numbers. Step 4 below, which
  renumbers every row above anything a phone has read, is not optional.
- Whether storage removed by `/v1/destroy` (`deleteAll()`) can be recovered is not documented. Do
  not promise it. (For the privacy text the opposite assumption applies: say it may remain in
  Cloudflare's backups for up to 30 days.)

### The temporary patch

Deliberately not part of the Worker: an endpoint that can rewind a household is not something to
leave deployed. Apply it, deploy, restore, remove it, deploy again. (On 2026-11-26 the patch
typechecked and the renumbering was tried locally; the restore itself cannot be.)

In `sync/src/index.ts`, add to `class Household`:

```ts
  /** TEMPORARY: docs/RUNBOOK.md. Never commit. */
  async opsRestore(at: number): Promise<string> {
    const target = await this.ctx.storage.getBookmarkForTime(at);
    const undo = await this.ctx.storage.onNextSessionRestoreBookmark(target);
    setTimeout(() => this.ctx.abort(), 100);
    return undo;
  }

  /**
   * TEMPORARY: moves every row, and the head, past anything a phone can have read, so each phone
   * is sent the whole restored household on its next ordinary pull. Rewrites `seq` and nothing
   * else; no row is added or removed.
   */
  async opsResequence(): Promise<number> {
    const shift = 10_000_000;
    const seq = this.head() + shift;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('UPDATE record SET seq = seq + ?', shift);
      this.sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', 'seq', String(seq));
    });
    return seq;
  }
```

and at the top of `handler.fetch`'s `try`:

```ts
      // TEMPORARY: docs/RUNBOOK.md. Never commit.
      if (path === '/ops/restore' || path === '/ops/resequence') {
        const key = (env as unknown as { OPS_KEY?: string }).OPS_KEY;
        if (!key || !timingSafeEqual(await sha256Hex(request.headers.get('x-ops-key') ?? ''), await sha256Hex(key))) {
          return textResponse('not found\n', 404);
        }
        const household = env.HOUSEHOLD.getByName(url.searchParams.get('hid') ?? '');
        if (path === '/ops/resequence') return jsonResponse({ seq: await household.opsResequence() });
        return jsonResponse({ undo: await household.opsRestore(Number(url.searchParams.get('at'))) });
      }
```

### Steps

```bash
cd sync
openssl rand -hex 32                                  # the one-off key
pnpm exec wrangler secret put OPS_KEY --env staging   # drop `--env staging` for a real incident
pnpm run build --prefix ../pwa && pnpm exec wrangler deploy --env staging   # patched, uncommitted: on purpose
```

1. Note the moment to return to, in milliseconds: `date -u +%s000`.
2. `curl -s -X POST "$ORIGIN/ops/restore?hid=$HID&at=$AT" -H "x-ops-key: $OPS_KEY"`. **Save the
   `undo` bookmark it prints**: restoring to it reverses the restore.
3. Wait a few seconds for the object to restart.
4. `curl -s -X POST "$ORIGIN/ops/resequence?hid=$HID" -H "x-ops-key: $OPS_KEY"`. Run it once.
5. Pull as the owner would and check the rows.
6. Remove the patch (`git checkout src/index.ts`), `pnpm run deploy:staging`, and
   `pnpm exec wrangler secret delete OPS_KEY --env staging`.

Phones apply what they are sent by last-write-wins. A phone that already holds a newer version of
a row, or a deletion of it, keeps its own: a restore repairs the server and any phone that does not
have something newer, which includes every newly paired one. Rows written only between the restore
point and now are gone from the server, and a phone that holds them does not send them again by
itself, because it remembers publishing them.

### The drill

Not yet done. On staging: claim a household, push two records, note the time, delete one and add a
third, restore to the noted time, and confirm the first two are back, the third is gone and the old
token still works. Then restore to the `undo` bookmark and confirm the change is back. Record here:

| Date | Who | Restored to the right state? | Undo worked? | Notes |
|---|---|---|---|---|
| | | | | |

## The rates history (R2)

R2 keeps no versions here. A month object that is wrong is edited by hand
(`wrangler r2 object get muchtoman-history/v1/2026-11.json`, fix, `put`); a month object that cannot
be parsed is never overwritten by the cron, which fails instead and says so. Losing the bucket
loses chart history and nothing of anyone's.

## D1 (billing)

Time Travel reaches back 30 days on the paid plan. A restore overwrites the database in place:

```bash
cd billing
pnpm exec wrangler d1 time-travel info muchtoman-billing --timestamp="2026-11-26T09:00:00+00:00"
pnpm exec wrangler d1 time-travel restore muchtoman-billing --bookmark=<bookmark>
```

It prints the bookmark that undoes it; write it down. Purchases recorded after the restore point
are lost from the database while the money was still taken: reconcile against the store's and the
gateway's own records before and after.

## Rotating the entitlement signing key

No signing key exists yet. Every verifier (app, PWA, `sync/`) holds a **list** of public keys, so
two can be valid at once. The same steps make the first one.

1. Generate the new Ed25519 pair offline. `billing/` takes the private key as PKCS#8, base64 or
   PEM (`openssl genpkey -algorithm ed25519`); verifiers take the raw 32-byte public key in
   base64url (`openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64 | tr '+/' '-_' | tr -d '='`).
2. Add the new **public** key beside the old one in `ENTITLEMENT_PUBLIC_KEYS`
   (`sync/wrangler.jsonc`, comma-separated), and in the app and the PWA. Deploy `sync/`, release the
   clients.
3. Once those builds are in use, put the new private key in `billing/`
   (`wrangler secret put ENTITLEMENT_SIGNING_KEY`) and deploy.
4. After the longest entitlement lifetime plus the 7-day offline grace, remove the old public key
   and release again.

If the old private key **leaked**, do step 3 at once and ship step 4 with step 2: every entitlement
signed with it stops working, which is the point. Subscribers fetch a new one with «restore
purchase» or their license key. Nothing of theirs is deleted either way.

## What «deleted» means

`/v1/destroy`, and a household closing with its last device, remove everything the object holds.
Cloudflare's point-in-time recovery may keep it for up to 30 days after, and the privacy text has
to say so:

> «از سرور پاک شد؛ نسخهٔ پشتیبان سرویس تا ۳۰ روز می‌ماند و رمزنگاری‌شده است.»

## Secrets

Where each one lives, never its value: `ANALYTICS_ACCOUNT_ID` and `ANALYTICS_TOKEN` (rates Worker),
`ENTITLEMENT_SIGNING_KEY` (`billing/`, not set yet), the Android signing values (CI secrets and a
local `keystore.properties`). A leaked analytics token
is revoked in the Cloudflare dashboard and replaced with `wrangler secret put`.
