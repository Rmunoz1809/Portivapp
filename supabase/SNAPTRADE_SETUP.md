# SnapTrade integration — deploy runbook (Portiv)

Linked Supabase project: **`zblhifszlhdgkhnymwjh`** (Portiv).
Everything server-side lives in `supabase/functions/` + `supabase/migrations/`.
The Consumer Key is **never** in `index.html` — only in function secrets.

## What was built (backend)

| Piece | Path | Notes |
|---|---|---|
| Shared CORS | `functions/_shared/cors.ts` | Allowlist: portivapp.com + capacitor/ionic localhost + dev localhost |
| Shared SnapTrade+admin | `functions/_shared/snaptrade.ts` | SDK client factory, service-role client, `requireUser()` JWT check |
| `snaptrade-connect` | `functions/snaptrade-connect/` | Registers user (userId = Supabase uid), returns fresh `redirectURI` |
| `snaptrade-refresh` | `functions/snaptrade-refresh/` | 60-min cache; reads daily-synced holdings; **never triggers a paid sync** |
| `snaptrade-history` | `functions/snaptrade-history/` | Daily cache; experimental balance-history; graceful `{available:false}` |
| `snaptrade-webhook` | `functions/snaptrade-webhook/` | CONNECTION_ADDED/BROKEN/DELETED → profiles |
| `snaptrade-cleanup` | `functions/snaptrade-cleanup/` | Cron; deletes connections >5d after expiry (stops $1/mo) |
| `revenuecat-webhook` | `functions/revenuecat-webhook/` | Extended: stamps `subscription_expired_at` on EXPIRATION/CANCELLATION |
| Schema | `migrations/20260712170000_snaptrade.sql` | profiles columns + secret hardening |
| Cron | `migrations/20260712170100_snaptrade_cron.sql` | pg_cron daily cleanup |
| Config | `config.toml` | verify_jwt flags per function |

Cost controls implemented exactly as specified: no manual/paid sync anywhere; refresh serves
cache all day (≤1 read/user/day); history cached daily; "Actualizar" only re-reads cache.

## Manual steps you must do

### 0. Install tooling (currently missing on this machine)
```bash
brew install supabase/tap/supabase   # supabase CLI — NOT installed
brew install deno                    # optional, only for local `supabase functions serve`
supabase login                       # if not already
# from Desktop/supabase (already linked to zblhifszlhdgkhnymwjh):
supabase link --project-ref zblhifszlhdgkhnymwjh   # if link is lost
```

### 1. Secrets
```bash
supabase secrets set SNAPTRADE_CLIENT_ID=RAFAEL-MUNOZ-TEST-MFSJO
supabase secrets set SNAPTRADE_CONSUMER_KEY=<your consumer key>   # <-- I still need this value
# optional but recommended:
supabase secrets set SNAPTRADE_WEBHOOK_SECRET=<random>            # verify webhook posts
supabase secrets set SNAPTRADE_CRON_SECRET=<random>              # verify cron posts
# (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
```

### 2. Migrations
```bash
supabase db push    # applies both 20260712170000_snaptrade.sql and _cron.sql
```

### 3. Deploy functions
```bash
supabase functions deploy snaptrade-connect
supabase functions deploy snaptrade-refresh
supabase functions deploy snaptrade-history
supabase functions deploy snaptrade-webhook  --no-verify-jwt
supabase functions deploy snaptrade-cleanup  --no-verify-jwt
supabase functions deploy revenuecat-webhook --no-verify-jwt
```

### 4. Cron secret (Vault) — for the daily cleanup
In the Supabase SQL editor:
```sql
select vault.create_secret('<same value as SNAPTRADE_CRON_SECRET>', 'snaptrade_cron_secret');
```

### 5. SnapTrade dashboard
- **Webhook URL to paste** (Webhooks / Notifications):
  `https://zblhifszlhdgkhnymwjh.supabase.co/functions/v1/snaptrade-webhook`
  If you set `SNAPTRADE_WEBHOOK_SECRET`, configure the same value as the webhook shared secret.

### 6. Experimental history endpoint (optional, off by default)
`getAccountBalanceHistory` (1-year lookback) is disabled per-account until you email SnapTrade to
enable it. Until then `snaptrade-history` returns `{available:false}` and the frontend shows the
"performance history coming soon" state — this is expected, not an error.

## Frontend contract (how index.html calls these)
`verify_jwt = true` on connect/refresh/history → the browser MUST send the user's session token:
```js
const { data:{ session } } = await sb.auth.getSession();
await fetch('https://zblhifszlhdgkhnymwjh.supabase.co/functions/v1/snaptrade-refresh', {
  method:'POST',
  headers:{ 'content-type':'application/json',
            'apikey': SUPABASE_ANON,
            'Authorization':'Bearer ' + session.access_token },  // <-- user token, NOT anon
  body: JSON.stringify({})
});
```

## Frontend changes (done + verified)
Edited both copies (backups written as `index.html.pre-snaptrade.bak` next to each):
- `Desktop/index.html` (web / GitHub Pages source)
- `portiv-cap/www/index.html` (Capacitor iOS/Android build — kept its native `_IS_NATIVE` routing)

What changed in each: injected a self-contained SnapTrade `<script>`+`<style>` module (connect / refresh / history / holdings→portfolio mapping / Value-Performance toggle / reconnect banner); replaced the Settings "screenshot" card with `#snapConnectCard`; repointed onboarding hand-off + paywall confirm/restore to `snapConnect()`; removed the entire photo/OCR analyzer (vision calls, prompts, upload handlers) while keeping the shared portfolio editor + `_applyValueChart`/`PERF_MASTER` chart it now reuses.
Verified live in a browser: both files boot with **0 console errors**; `snapMapHoldings()` → `aiPortImportData()` proven with a sample holdings payload (cash, total, positions all populate correctly).

## Native / Capacitor follow-ups (not code — verify when wiring the native build)
1. **Return from the portal:** on web, `snapConnect` does `window.location.href = redirectURI` and detects the return via a `pv_snap_pending` flag on next load. In the Capacitor WebView you likely want to open the portal in an in-app browser / handle the redirect back via a deep link, then call `window.snapRefresh()`. The web flow works as-is.
2. **RevenueCat app_user_id:** the native paywall (IAP) must call `Purchases.logIn(session.user.id)` so RevenueCat webhook events carry `app_user_id == Supabase user.id` — the `revenuecat-webhook` matches on that.

## Housekeeping
- The old `portiv-cap/supabase/functions/revenuecat-webhook/` is now **superseded** by the linked-project
  copy here. Safe to delete once you confirm the linked one is deployed.
