# Reach spike (B0.4, #18)

Can a Cloudflare Worker reach the Iranian stores' and payment gateways' APIs? `billing/` cannot
verify a purchase it cannot ask about, so this is answered before any provider code is written.

**Not deployed.** Deploying creates a Worker, a custom domain and a secret, which is the owner's
call.

## Run it

```bash
cd worker && pnpm install                       # for wrangler; the spike has no package of its own
KEY=$(openssl rand -hex 16)
pnpm exec wrangler deploy --config ../tools/reach-spike/wrangler.jsonc
printf %s "$KEY" | pnpm exec wrangler secret put SPIKE_KEY --config ../tools/reach-spike/wrangler.jsonc
curl -s -H "x-spike-key: $KEY" https://reach-spike.muchtoman.com/ | tee reach-$(date +%F-%H%M).json
```

A Worker runs in the Cloudflare location nearest whoever calls it, and its requests leave from
there. Run the `curl` from more than one place — an Iranian connection above all, since that is the
location serving users — at least twice each, on different days. `colo` in the answer says which
location it was.

Then **remove it**, domain included:

```bash
pnpm exec wrangler delete --config ../tools/reach-spike/wrangler.jsonc
```

and check in the dashboard that `reach-spike.muchtoman.com` is gone from DNS.

## Reading an answer

- A `status`, any status, with a body from the API itself (`401`, `404 not_found`, an error code
  about the merchant) → **reachable**.
- A `status` with an HTML block page, a CAPTCHA or a CDN's refusal → **blocked** for this purpose.
  Read `answer`.
- `error` (timeout, connection reset, certificate) → **not reachable**.
- `documented: false` means the vendor's page could not be read when this was written (client-side
  rendering; IDPay's certificate had expired), so a `404` there may be a wrong path rather than a
  refusal. Check the path against the vendor's panel before concluding anything.

## Results

Copy into #18 and fill in.

| Service | Call | From (colo) | Reachable? | Status | Time (ms) | IP allow-list needed? | Notes |
|---|---|---|---|---|---|---|---|
| Cafe Bazaar | validate in-app | | | | | | |
| Cafe Bazaar | subscription | | | | | | |
| Myket | verify purchase | | | | | | |
| Zarinpal | request | | | | | | |
| Zarinpal | verify | | | | | | |
| Zibal | request | | | | | | |
| Zibal | verify | | | | | | |
| PayPing | pay | | | | | | |
| IDPay | payment | | | | | | |

What each gateway asks of the buyer, and whether it can be kept from us:

| Gateway | Mobile number mandatory? | E-mail mandatory? | Returns buyer details to the merchant? | Needs enamad / legal merchant? | Fee | Webhook? |
|---|---|---|---|---|---|---|
| Zarinpal | no (v4 docs, `metadata.mobile` optional, read 2026-11-26) | no (same) | | | | |
| Zibal | | | | | | |
| PayPing | | | | | | |
| IDPay | | | | | | |

**Conclusion** (date, who): …

If the answer is «not reachable», the fallback named in #18 is a small relay on a server inside
Iran that forwards only the verify call, over mTLS with `billing/`, and keeps nothing. Its design,
cost and threat model are to be written only if the table says it is needed.
