# Deploy

Service: `callandtranslate.service` → `127.0.0.1:3005`  
Env: `/etc/callandtranslate.env`  
Nginx: `/etc/nginx/sites-available/callandtranslate.com`

## DNS

Point the domain at this VPS before HTTPS will work.

### Website (required for the app and Let's Encrypt)

| Type | Host | Value | TTL |
| --- | --- | --- | --- |
| A | `@` | `2.28.40.33` | 5 min while cutting over |
| AAAA | `@` | `2a01:4f8:c016:b9e1::1` | 5 min while cutting over |
| A | `www` | `2.28.40.33` | 5 min while cutting over |
| AAAA | `www` | `2a01:4f8:c016:b9e1::1` | 5 min while cutting over |

Do not CNAME `www` to the apex if the registrar already has A/AAAA on `www`.

### Mail (MXRoute)

Create the domain on MXRoute, then add:

| Type | Host | Priority | Value |
| --- | --- | --- | --- |
| MX | `@` | 10 | `heracles.mxrouting.net` |
| MX | `@` | 20 | `heracles-relay.mxrouting.net` |
| TXT | `@` | | `v=spf1 include:mxroute.com ~all` |
| TXT | `x._domainkey` | | *(MXRoute DKIM — paste from the MXRoute panel)* |
| TXT | `_dmarc` | | `v=DMARC1; p=none; rua=mailto:info@callandtranslate.com` |

Create mailbox `info@callandtranslate.com` in the MXRoute control panel. Put that password in `/etc/callandtranslate.env` as `SMTP_PASS` / `INFO_MAIL_PASSWORD`.

Then:

```
certbot --nginx -d callandtranslate.com -d www.callandtranslate.com
```

Until DNS is updated, the app is reachable on the VPS at `http://127.0.0.1:3005`.

## Stripe (Paid subscriptions)

```
STRIPE_SECRET_KEY=rk_live_or_test_...
STRIPE_PUBLISHABLE_KEY=pk_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID_PRO=price_...
STRIPE_PRICE_ID_CREDITS=price_...
```

Create the Paid subscription (£12 / month) and extra-hour top-up (£12) once:

```
STRIPE_SECRET_KEY=rk_... node scripts/ensure-stripe-catalog.mjs
```

Webhook: `https://callandtranslate.com/api/stripe/webhook`
