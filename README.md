# The Ultimate Driver 2027 – Section 2 Party Registration

Online sign-up for every party in a slot-holder group (Racing Queensland, The Creek Albion Park, 19–20 Feb 2027).
Each registrant picks their group, enters their details, uploads a licence/passport, signs, and agrees to the T&Cs.

## Who gets what
| Recipient | Contents |
|---|---|
| Racing Queensland (`RQ_EMAIL`, default `UDC@racingqueensland.com.au`) | One email per registration, subject `UDC27 Registration – <Group> – <Full name>`, all details in the body, with the licence/passport (`<Full name>-licence.<ext>`) and signature (`<Full name>-signature.png`) **attached** |
| Slot manager (`managerEmail` of the group) | Name, group, phone, email, date/time. **No** DOB, address, licence or signature |
| Registrant | Confirmation with their own details and reference |

If a group has no `managerEmail` yet, RQ is still emailed (subject ends `[NO MANAGER SET]`). Repeat registrations (same email + group) end `[POSSIBLE DUPLICATE]`.

## EMAIL_ONLY mode (default)
RQ's inbox is the record – there is no database and no persistent disk is needed.
- Each upload is held temporarily under `DATA_DIR` and the RQ email (with attachments) is queued before the registrant sees "received".
- The temporary files are deleted **only after the RQ email has actually been sent** (via the Brevo HTTPS API or SMTP).
- If neither `BREVO_API_KEY` nor SMTP is configured, the RQ email is **held** (never marked sent; a copy is logged to `outbox/`) and the files kept; it sends as soon as mail is configured / the service restarts with it.
- If sending fails (including a non-2xx response from Brevo), the RQ email is retried forever (2, 4, 8 … then hourly) and the files are kept; failures are logged as `*** RQ EMAIL FAILED ***` (Brevo error bodies are logged; the API key is never logged). Manager/registrant emails give up after 5 attempts.
- Registrants never see an error just because email is queued or failing.
- Caveat: on a host without a persistent disk (e.g. Render free), anything still unsent is lost if the service restarts, so make sure mail works before launch and watch `/admin` (shows anything waiting / failing, and has a **Retry all emails now** button).

Set `EMAIL_ONLY=false` to keep every registration's files on disk as well (needs a persistent disk; enables the CSV/ZIP exports with data).

## Run locally
```
npm install
ADMIN_PASSWORD=changeme node server.js     # http://localhost:3000 , admin at /admin
```
Without `BREVO_API_KEY` or `SMTP_HOST`, no email is sent: messages are written to `$DATA_DIR/outbox/` and RQ emails are held (see above).

## Admin (RQ only) – `/admin`
HTTP Basic auth (any username, password = `ADMIN_PASSWORD`). Filter by group, search name/email,
**Download CSV** (all fields, Brisbane time, licence file name; no file contents) and
**Download all files as ZIP** (`Group/Name - ref/` with details.json, licence, signature + registrations.csv).
Also shows the email queue (pending / failed with last error). `/admin` and `/files/` send `X-Robots-Tag: noindex` and are disallowed in robots.txt.

## Data layout (everything private is under `DATA_DIR`, default `./private-data`)
```
registrations/<ref>/submission.json, id-document.<ext>, signature.png
mail/pending|sent|failed/   email queue (retried in background: 5 attempts over ~30 min)
outbox/                     emails logged when mail is not configured
state/ratelimit.json        rate-limit state (survives restarts)
tmp/                        in-progress uploads (cleared at start)
```
Duplicate check (same email + group: saved, but flagged to registrant/RQ/admin) is rebuilt from disk at start.

## Deploy on Render
1. New **Web Service** from this repo, runtime Node. Build `npm install`, start `node server.js`. Health check path `/healthz`.
2. Only if `EMAIL_ONLY=false`: add a **Persistent Disk** mounted at `/var/data` (1 GB is ample for a few hundred registrations; paid instance type required for disks).
3. Run **one instance** only (data is on the single disk).
4. Environment variables:

| Var | Example / notes |
|---|---|
| `ADMIN_PASSWORD` | long random string (required for /admin) |
| `LINK_SECRET` | separate long random string for secure file links (falls back to ADMIN_PASSWORD) |
| `DATA_DIR` | `/var/data` if you have a disk; otherwise leave unset (temporary files live in the app folder) |
| `PUBLIC_BASE_URL` | `https://register.theultimatedriver.com.au` |
| `RQ_EMAIL` | default `UDC@racingqueensland.com.au` (from config.json) |
| `EMAIL_ONLY` | default `true`; `false` = also keep files on disk (needs a persistent disk) |
| `GROUPS_JSON` | `[{"id":"herb-factor","name":"THE HERB FACTOR","managerEmail":"…"}, … 10 groups]` – keep ids stable once live |
| `MAIL_FROM` | e.g. `The Ultimate Driver <UDC71896@gmail.com>` – parsed into sender name and email |
| `BREVO_API_KEY` | **Preferred on Render free** (outbound SMTP ports are blocked). Sends all mail via `POST https://api.brevo.com/v3/smtp/email`. If set, SMTP is not used. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` | used only when `BREVO_API_KEY` is not set (e.g. port 587 + `SMTP_SECURE=false`, or 465 + `true`) |
| optional | `RATE_LIMIT_MAX` (default 60 per 15 min per IP), `LINK_EXPIRY_DAYS` (30), `PORT`, `BREVO_API_URL` (override the Brevo API endpoint; for tests only) |

`GROUPS_JSON` overrides `config.json`. Manager emails and secrets must **never** be committed (`config.local.json` is gitignored for local use only).
Changing env vars on Render restarts the service; data on the disk is kept.

### Mail / DNS
On Render's free plan, outbound SMTP ports are blocked, so set `BREVO_API_KEY` and send through Brevo's HTTPS API. The sender address in `MAIL_FROM` must be a verified sender in Brevo.
If you are not on a host that blocks SMTP, you can instead use SMTP (`SMTP_HOST` etc.) with Brevo or another transactional provider (Postmark, SendGrid, Mailgun, Amazon SES, or Microsoft 365/Google Workspace).
Add the provider's **SPF** include and **DKIM** records, and a **DMARC** record (e.g. `v=DMARC1; p=none; rua=mailto:…`), for the `MAIL_FROM` domain,
otherwise emails to RQ/managers may go to spam. Point a subdomain (CNAME) at Render for `PUBLIC_BASE_URL`; Render provides HTTPS.

## Limits
Single instance + local disk (no horizontal scaling); one shared admin password; no virus scanning of uploads;
`trust proxy` is set to 1 hop (correct behind Render's proxy).
