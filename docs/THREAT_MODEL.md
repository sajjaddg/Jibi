# Threat model: sync, the vault, family and Pro

What is protected, from whom, and where it is not. Written 2026-11-26 against `main`, for the
server (`sync/`, `billing/`). The clients' side of the vault, recovery and purchase is not built
yet and is **not** reviewed here; neither is any payment code, which does not exist.

The promise being tested: the server stores ciphertext and cannot read amounts, names, messages,
categories or notes ([PRODUCT.md](../PRODUCT.md)).

## 1. Assets

| Asset | Where it lives | If lost |
|---|---|---|
| Vault key, family key (AES-256) | her devices; the pairing QR's URL fragment; the recovery kit; the backup file (passphrase-encrypted). Never sent to a server | everything in that household is readable by whoever also has its records |
| Recovery secret (256-bit) | her kit. The server keeps its SHA-256 | with the vault id: enrol a device. Reading still needs the vault key |
| Device token | the device. The server keeps its SHA-256 | act as that device until it is revoked or rotates |
| Entitlement signing key | a `billing/` secret | forge Pro. No access to anyone's data |
| Payment providers' keys | `billing/` secrets (none yet) | fraudulent verification or refunds |
| The PWA's code | served by `sync/` | **see § 3, «whoever can deploy»** |
| APK signing key | CI secrets and a local file | ship an update installed phones accept |

## 2. What the server can see

It cannot read a body. It does see, and a database dump contains:

- per household: its random id, type, the founder's member id, counters, the sequence head and
  compaction horizon, the hash of a recovery secret, the plan with the day it runs out and a hash
  of a slot nonce;
- per device: random device and member ids, the hash of its token, its scopes, its role, **when it
  joined**, and how far it has read (a number, not a time);
- per open invitation: the hash of the code, its scopes and expiry;
- per record: **id, kind, scope, order, time of writing** (the client's clock, clamped), writing
  device, owner and author member, whether deleted, and the size of the ciphertext.

So it can tell how many records of each kind a household has, how big, and when they were written:
how active a person is, roughly how many bank messages they get, whether they keep loans or
cheques. Ids carry more than they look:

- a **family** record made from a bank message has the SHA-256 of the message inside its id
  (`txn:…`, and the `share_split` that names it). Someone holding the ids and a guess at a message
  can confirm it. Accepted on 2026-11-20 (plans/README.md): changing it is a format migration for
  an exposure that needs the server's data and the message text.
- **vault ids say nothing**: each is an HMAC under a key derived from the vault key (#105), so a
  bank's name, an asset, a category or a message hash is not readable from them. No client writes
  these yet, so this is a rule the clients have to keep (`sync/test/vectors/`).

Cloudflare, as the host, sees addresses and request metadata of every call, whatever this code
logs. Invocation logs are off; the code logs one line on an internal error, with no id and no
body. Analytics holds endpoint, status, client version and error code only.

Removed data may stay in Cloudflare's point-in-time recovery for up to 30 days.

## 3. Who, what they can do, and what stops them

| Who | Sees | Can | Stopped by | Not stopped |
|---|---|---|---|---|
| **A stolen server database** | § 2 | nothing: token and secret hashes are of 256-bit values | AES-GCM; keys never uploaded | the metadata |
| **A hostile server** (or Cloudflare account) | § 2 | withhold or delete records; replay an old body under its own id with a newer stamp; flip `deleted`; add a device of its own | the AAD binds scope, kind and id; a deletion is believed only from a sealed tombstone; an added device has no key | rollback and withholding are not detectable. Records sealed before the AAD can be copied under another id |
| **Whoever can deploy `sync/`** | everything the PWA does | serve PWA code that sends keys away | deploys come from a clean git tree and record the commit; CSP limits where the page may connect, but the same deploy sets the CSP | **For PWA users, «the server cannot read» holds only while the deployed code is honest.** Android is not affected |
| **A family member with a tampered client** | everything shared with the family | overwrite shared records (category, note, budget, goal, fund, split), dated up to a day ahead; while `ROLES_RESTRICT_MEMBERS` is off, invite people and remove other non-admins | owner fences on `member`, `transaction`, `asset`; the founder and admins cannot be removed by a member; vault kinds are refused in a family | the server cannot check what a sealed payload claims (a split that does not add up) |
| **A read-only member** | the same | delete their own shared rows, leave | roles enforced per record | they still read everything |
| **A removed member** | what they already had | nothing new: their token is refused and their codes are swept | revocation takes effect on the next request; renewing the family gives a new key (`sync/test/renewal.test.ts`) | old rows they hold; they can tell the old household still exists (#102) |
| **A stolen phone** | what the app shows, unless locked | act as that device | app lock; revoke; token rotation; Android backup is disabled | if it holds the recovery kit, revoking is not enough (#100). The PWA keeps the key's bytes beside the non-extractable key, to draw invite codes |
| **Someone who photographed a pairing code** | — | join as a device and read, with the key in the link | one use; ten minutes, or a day if she chose it; an admin can cancel it (#42) | the URL stays in the browser's history until replaced |
| **A stranger** | nothing | claim households of their own; call `recover` | rate limits; 128-bit household ids; 256-bit secrets; a request for an unclaimed id writes nothing | — |
| **A blocked or watching network** | that this app is in use | block it | HTTPS; custom domains, never `workers.dev` | no second domain yet (#55) |
| **A stolen billing database** | license hashes, expiry, source, payment-reference hashes, slot hashes | — | license keys are random; nothing names a person or a household | see § 4 |
| **A stolen signing key** | — | sign Pro for anyone | rotation with two keys accepted (docs/RUNBOOK.md) | valid until each client drops the old public key |

## 4. Keeping billing and households apart

The design: `billing/` never learns a household id, and a household never learns a license.

- Holds today: no shared id. The slot nonce is hashed under a different label on each side; the
  vault's `entitlement` record has a random id (#96).
- **Open:** one entitlement can be shown to any number of households (#98).
- **Open:** a plan's expiry day can narrow a household down to a license (#99).
- **To do before #46/#47:** `source_ref_hash` must be an HMAC under a billing secret, not a bare
  SHA-256: a gateway's reference numbers are short enough to guess, and a bare hash of one is as
  good as the number.
- The same person's requests reach both Workers from the same address within seconds. Nothing
  records that here, and nothing can stop the host from seeing it.

## 5. Security review

**2026-11-26, `sync/src` and `billing/` at `main`** (static review, no live system exists to test).
No high or medium severity finding. Observations written up as issues:

| Issue | What | State |
|---|---|---|
| #96 | the `entitlement` record id would have joined the two databases | fixed |
| #97 | devices older than identity slipped past member-level checks | fixed |
| #98 | one entitlement, many households | open, needs a decision |
| #99 | expiry correlation | open, needs a decision |
| #100 | revoking a vault device leaves the recovery secret valid | open |
| #101 | the server trusts a `deleted` flag it cannot check | open |
| #102 | `pair` and `claim` reveal that a household exists | open, proposed to accept |

Found while writing this document:

| Issue | What | State |
|---|---|---|
| #105 | vault ids as first specified would have named banks and assets in the clear | fixed |

No open critical finding.

**Still to be reviewed:** the clients' vault, recovery and entitlement code before R1; every
payment route in `billing/` and the same-origin proxy before R3 (#56, #52).
