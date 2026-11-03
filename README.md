# The Ultimate Driver 2027 – Section 2 Party Registration

Online sign-up for every party in a slot-holder group (Racing Queensland, The Creek Albion Park, 19–20 Feb 2027).
Each registrant picks their group, enters their details, uploads a licence/passport, signs, and agrees to the T&Cs.

## Who gets what
| Recipient | Contents |
|---|---|
| Racing Queensland (`RQ_EMAIL`) | Full details + secure link to licence & signature (link expires after 30 days; `/admin` always makes fresh links) |
| Slot manager (`managerEmail` of the group) | Name, group, phone, email, whether they are the group manager/contact, date/time. **No** DOB, address, licence or signature |
| Registrant | Confirmation with their own details and reference |

If a group has no `managerEmail` yet, the registration is still saved and RQ is emailed (subject starts `[NO MANAGER SET]`).

## Run locally
```
npm install
ADMIN_PASSWORD=changeme node server.js     # http://localhost:3000 , admin at /admin
```
Without `SMTP_HOST`, no email is sent: messages are written to `$DATA_DIR/outbox/`.

## Admin (RQ only) – `/admin`
HTTP Basic auth (any username, password = `ADMIN_PASSWORD`). Filter by group, search name/email,
**Download CSV** (all fields, Brisbane time, licence file name; no file contents) and
**Download all files as ZIP** (`Group/Name - ref/` with details.json, licence, signature + registrations.csv).
Also shows the email queue (pending / failed with last error). `/admin` and `/files/` send `X-Robots-Tag: noindex` and are disallowed in robots.txt.

## Data layout (everything private is under `DATA_DIR`, default `./private-data`)
```
registrations/<ref>/submission.json, id-document.<ext>, signature.png
mail/pending|sent|failed/   email queue (retried in background: 5 attempts over ~30 min)
outbox/                     emails logged when SMTP is not configured
state/ratelimit.json        rate-limit state (survives restarts)
tmp/                        in-progress uploads (cleared at start)
```
Duplicate check (same email + group: saved, but flagged to registrant/RQ/admin) is rebuilt from disk at start.

## Deploy on Render
1. New **Web Service** from this repo, runtime Node. Build `npm install`, start `node server.js`. Health check path `/healthz`.
2. Add a **Persistent Disk** mounted at `/var/data` (1 GB is ample for a few hundred registrations; paid instance type required for disks).
3. Run **one instance** only (data is on the single disk).
4. Environment variables:

| Var | Example / notes |
|---|---|
| `ADMIN_PASSWORD` | long random string (required for /admin) |
| `LINK_SECRET` | separate long random string for secure file links (falls back to ADMIN_PASSWORD) |
| `DATA_DIR` | `/var/data` |
| `PUBLIC_BASE_URL` | `https://register.theultimatedriver.com.au` (used in email links) |
| `RQ_EMAIL` | `aclarke@racingqueensland.com.au` |
| `GROUPS_JSON` | `[{"id":"herb-factor","name":"THE HERB FACTOR","managerEmail":"…"}, … 10 groups]` – keep ids stable once live |
| `MAIL_FROM` | e.g. `The Ultimate Driver <no-reply@theultimatedriver.com.au>` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` | your mail provider (e.g. port 587 + `SMTP_SECURE=false`, or 465 + `true`) |
| optional | `RATE_LIMIT_MAX` (default 60 per 15 min per IP), `LINK_EXPIRY_DAYS` (30), `PORT` |

`GROUPS_JSON` overrides `config.json`. Manager emails and secrets must **never** be committed (`config.local.json` is gitignored for local use only).
Changing env vars on Render restarts the service; data on the disk is kept.

### SMTP / DNS
Use a transactional provider (Postmark, SendGrid, Mailgun, Amazon SES, or Microsoft 365/Google Workspace SMTP) on a domain you control.
Add the provider's **SPF** include and **DKIM** records, and a **DMARC** record (e.g. `v=DMARC1; p=none; rua=mailto:…`), for the `MAIL_FROM` domain,
otherwise emails to RQ/managers may go to spam. Point a subdomain (CNAME) at Render for `PUBLIC_BASE_URL`; Render provides HTTPS.

## Limits
Single instance + local disk (no horizontal scaling); one shared admin password; no virus scanning of uploads;
`trust proxy` is set to 1 hop (correct behind Render's proxy).
