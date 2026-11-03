// The Ultimate Driver 2027 – Section 2 party sign-up
const express = require('express'), multer = require('multer'), nodemailer = require('nodemailer'), archiver = require('archiver');
const fs = require('fs'), fsp = fs.promises, path = require('path'), crypto = require('crypto');

const ROOT = __dirname;
// ---- config: config.json (repo, placeholders) < config.local.json (gitignored) < env vars ----
function cfg() {
  const f = fs.existsSync(path.join(ROOT, 'config.local.json')) ? 'config.local.json' : 'config.json';
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  if (process.env.GROUPS_JSON) c.groups = JSON.parse(process.env.GROUPS_JSON); // manager emails live in an env var on the host
  if (process.env.RQ_EMAIL) c.racingQueenslandEmail = process.env.RQ_EMAIL;
  if (process.env.MAIL_FROM) c.fromEmail = process.env.MAIL_FROM;
  c.maxUploadMB = 10;
  return c;
}
let CFG = cfg(); setInterval(() => { try { CFG = cfg(); } catch (e) { console.error('config reload failed', e.message); } }, 60000).unref();

// ---- storage: EVERYTHING private lives under DATA_DIR ----
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'private-data'));
const DIRS = { regs: path.join(DATA, 'registrations'), tmp: path.join(DATA, 'tmp'), outbox: path.join(DATA, 'outbox'),
  mailPending: path.join(DATA, 'mail', 'pending'), mailSent: path.join(DATA, 'mail', 'sent'), mailFailed: path.join(DATA, 'mail', 'failed'), state: path.join(DATA, 'state') };
Object.values(DIRS).forEach(d => fs.mkdirSync(d, { recursive: true }));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const BASE = (process.env.PUBLIC_BASE_URL || CFG.publicBaseUrl || 'http://localhost:3000').replace(/\/$/, '');
const LINK_DAYS = +(process.env.LINK_EXPIRY_DAYS || 30);
const SECRET = process.env.LINK_SECRET || ADMIN_PASSWORD || 'dev-secret';

// ---- helpers ----
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dmy = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || ''); };
const todayBrisbane = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Australia/Brisbane' });
const brisbane = iso => new Date(iso).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane', dateStyle: 'medium', timeStyle: 'short' }) + ' AEST';
const hmac = s => crypto.createHmac('sha256', SECRET).update(s).digest('hex').slice(0, 32);
const tokenFor = id => { const exp = Math.floor(Date.now() / 1000) + LINK_DAYS * 86400; return `${exp}.${hmac(id + '.' + exp)}`; };
const tokenOk = (id, t) => { const [exp, sig] = String(t || '').split('.'); if (!/^\d+$/.test(exp) || !sig || sig.length !== 32 || +exp * 1000 < Date.now()) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(hmac(id + '.' + exp))); };
async function writeAtomic(file, data) { const t = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`; await fsp.writeFile(t, data); await fsp.rename(t, file); }
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// file type by content (magic bytes)
function sniff(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { ext: '.jpg', type: 'image/jpeg' };
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return { ext: '.png', type: 'image/png' };
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return { ext: '.pdf', type: 'application/pdf' };
  if (buf.slice(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(buf.slice(8, 12).toString('latin1'))) return { ext: '.heic', type: 'image/heic' };
  return null;
}

// ---- in-memory index of registrations (rebuilt from disk at start, so duplicate checks survive restarts) ----
const REGS = new Map();
const dupKey = (g, e) => g + '|' + String(e).trim().toLowerCase();
const DUPES = new Map(); // key -> [ids]
function indexRec(r) { REGS.set(r.id, r); const k = dupKey(r.groupId, r.email); DUPES.set(k, [...(DUPES.get(k) || []), r.id]); }
for (const id of fs.readdirSync(DIRS.regs)) { try { indexRec(JSON.parse(fs.readFileSync(path.join(DIRS.regs, id, 'submission.json')))); } catch {} }

// ---- persistent rate limit (per client IP, sliding window) ----
const RL_MAX = +(process.env.RATE_LIMIT_MAX || 60), RL_WIN = 15 * 60 * 1000, RL_FILE = path.join(DIRS.state, 'ratelimit.json');
let hits = new Map(); try { hits = new Map(Object.entries(JSON.parse(fs.readFileSync(RL_FILE, 'utf8')))); } catch {}
let rlDirty = false;
setInterval(async () => { if (!rlDirty) return; rlDirty = false; const now = Date.now(), o = {};
  for (const [ip, a] of hits) { const f = a.filter(t => now - t < RL_WIN); if (f.length) o[ip] = f; else hits.delete(ip); }
  try { await writeAtomic(RL_FILE, JSON.stringify(o)); } catch (e) { console.error('rate-limit save', e.message); } }, 5000).unref();
function rateLimit(req, res, next) {
  const now = Date.now(), a = (hits.get(req.ip) || []).filter(t => now - t < RL_WIN);
  if (a.length >= RL_MAX) return res.status(429).json({ ok: false, errors: ['Too many registrations from this connection in a short time. Please wait 15 minutes and try again.'] });
  a.push(now); hits.set(req.ip, a); rlDirty = true; next();
}

// ---- email queue: jobs on disk, background worker with retries; never blocks a registration ----
const smtp = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: +(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === 'true',
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined, pool: true, maxConnections: 3
}) : null;
const MAIL_MAX_ATTEMPTS = 5;
async function queueMail(msg) {
  const id = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
  await writeAtomic(path.join(DIRS.mailPending, id + '.json'), JSON.stringify({ id, msg, attempts: 0, nextAt: 0, errors: [] }));
  setImmediate(mailWorker);
}
let working = false, again = false;
async function mailWorker() {
  if (working) { again = true; return; } working = true; again = false;
  try {
    for (const f of (await fsp.readdir(DIRS.mailPending)).filter(f => f.endsWith('.json'))) {
      const p = path.join(DIRS.mailPending, f); let job; try { job = JSON.parse(await fsp.readFile(p)); } catch { continue; }
      if (job.nextAt > Date.now()) continue;
      job.msg.from = CFG.fromEmail;
      try {
        if (smtp) await smtp.sendMail(job.msg);
        else await fsp.writeFile(path.join(DIRS.outbox, job.id + '.txt'), `From: ${job.msg.from}\nTo: ${job.msg.to}\nSubject: ${job.msg.subject}\n\n${job.msg.text}\n`);
        job.sentAt = new Date().toISOString(); job.via = smtp ? 'smtp' : 'outbox';
        await writeAtomic(path.join(DIRS.mailSent, f), JSON.stringify({ ...job, msg: { to: job.msg.to, subject: job.msg.subject } }));
        await fsp.unlink(p);
      } catch (e) {
        job.attempts++; job.errors.push(`${new Date().toISOString()} ${e.message}`);
        job.nextAt = Date.now() + Math.min(60, 2 ** job.attempts) * 60000; // 2,4,8,16 min
        console.error('[mail] failed', job.id, e.message);
        if (job.attempts >= MAIL_MAX_ATTEMPTS) { await writeAtomic(path.join(DIRS.mailFailed, f), JSON.stringify(job)); await fsp.unlink(p); }
        else await writeAtomic(p, JSON.stringify(job));
      }
    }
  } catch (e) { console.error('[mail] worker', e); } finally { working = false; if (again) setImmediate(mailWorker); }
}
setInterval(mailWorker, 30000).unref(); setImmediate(mailWorker);

// ---- app ----
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); res.set('Referrer-Policy', 'no-referrer'); next(); });
app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /admin\nDisallow: /files/\n'));
app.get('/healthz', (req, res) => { try { fs.accessSync(DIRS.regs, fs.constants.W_OK); res.json({ ok: true, registrations: REGS.size }); } catch { res.status(503).json({ ok: false }); } });
app.use(express.static(path.join(ROOT, 'public')));
app.get('/api/groups', (req, res) => res.json(CFG.groups.map(g => ({ id: g.id, name: g.name }))));
app.get('/api/config', (req, res) => res.json({ maxUploadMB: CFG.maxUploadMB }));

const upload = multer({ dest: DIRS.tmp, limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 30, fieldSize: 2 * 1024 * 1024 } });

app.post('/submit', rateLimit, upload.single('idDocument'), async (req, res, next) => {
  const tmp = req.file?.path;
  try {
    const b = req.body || {}, c = CFG, errs = [];
    const group = c.groups.find(g => g.id === b.groupId);
    if (!group) errs.push('Please select your slot group.');
    for (const [k, l] of [['fullName', 'Full legal name'], ['address', 'Residential/registered address'], ['postcode', 'Postcode'], ['phone', 'Phone'], ['email', 'Email']])
      if (!String(b[k] || '').trim()) errs.push(`${l} is required.`);
    for (const k of ['fullName', 'address', 'phone', 'email']) if (String(b[k] || '').length > 300) errs.push(`${k} is too long.`);
    if (b.dobNA !== 'on' && !/^\d{4}-\d{2}-\d{2}$/.test(b.dob || '')) errs.push('Date of birth is required (or tick Not Applicable).');
    if (b.postcode && !/^\d{4}$/.test(b.postcode.trim())) errs.push('Postcode must be 4 digits.');
    if (b.email && !emailOk(b.email.trim())) errs.push('Email address looks invalid.');
    let kind = null;
    if (!req.file) errs.push("Please upload your driver's licence or passport.");
    else { const fh = await fsp.open(tmp); const buf = Buffer.alloc(16); await fh.read(buf, 0, 16, 0); await fh.close();
      kind = sniff(buf); if (!kind) errs.push('Licence/passport must be a real JPG, PNG, HEIC or PDF file.'); }
    const sig = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(b.signature || '');
    const sigBuf = sig ? Buffer.from(sig[1], 'base64') : null;
    if (!sigBuf || sniff(sigBuf)?.type !== 'image/png') errs.push('Please sign in the signature box.');
    if (b.consent !== 'on') errs.push('You must agree to the Terms and Conditions and acknowledgements.');
    if (errs.length) { if (tmp) fsp.unlink(tmp).catch(() => {}); return res.status(400).json({ ok: false, errors: errs }); }

    // unique folder: mkdir without recursive fails on collision, so retry with a new id (never overwrites)
    let id, dir;
    for (let i = 0; ; i++) { id = new Date().toLocaleDateString('sv-SE', { timeZone: 'Australia/Brisbane' }) + '-' + crypto.randomBytes(8).toString('hex'); dir = path.join(DIRS.regs, id);
      try { await fsp.mkdir(dir); break; } catch (e) { if (e.code !== 'EEXIST' || i > 5) throw e; } }
    const idFile = 'id-document' + kind.ext;
    await fsp.rename(tmp, path.join(dir, idFile));
    await fsp.writeFile(path.join(dir, 'signature.png'), sigBuf);
    const dupes = DUPES.get(dupKey(group.id, b.email)) || [];
    const rec = {
      id, submittedAt: new Date().toISOString(), groupId: group.id, groupName: group.name,
      fullName: b.fullName.trim(), dob: b.dobNA === 'on' ? null : b.dob, dobNotApplicable: b.dobNA === 'on',
      address: b.address.trim(), postcode: b.postcode.trim(), phone: b.phone.trim(), email: b.email.trim(),
      signedDate: todayBrisbane(), consent: true,
      idDocument: { file: idFile, originalName: req.file.originalname, mimetype: kind.type, bytes: req.file.size },
      signatureFile: 'signature.png', possibleDuplicateOf: [...dupes], ip: req.ip, userAgent: req.get('user-agent')
    };
    await writeAtomic(path.join(dir, 'submission.json'), JSON.stringify(rec, null, 2));
    indexRec(rec);
    res.json({ ok: true, id, warning: dupes.length ? 'You have already registered for this group with this email. Your new registration has been saved as well; contact your slot manager if this was a mistake.' : null });

    // emails are queued after the response, so SMTP problems never affect the registration
    const when = brisbane(rec.submittedAt);
    const dupNote = dupes.length ? `\nWARNING: possible duplicate – this email has already registered for ${rec.groupName} (${dupes.join(', ')}).\n` : '';
    const flags = (group.managerEmail ? '' : '[NO MANAGER SET] ') + (dupes.length ? '[POSSIBLE DUPLICATE] ' : '');
    const full = `Slot group: ${rec.groupName}\nFull legal name: ${rec.fullName}\nDate of birth: ${rec.dob ? dmy(rec.dob) : 'Not applicable (company/trust)'}\nAddress: ${rec.address} ${rec.postcode}\nPhone: ${rec.phone}\nEmail: ${rec.email}\nSigned: ${dmy(rec.signedDate)}\nRegistered: ${when}\nConsent to T&Cs and Section 3 acknowledgements: Yes\nReference: ${id}`;
    const jobs = [];
    if (c.racingQueenslandEmail) jobs.push({ to: c.racingQueenslandEmail, subject: `${flags}Ultimate Driver 2027 – new party registration: ${rec.fullName} (${rec.groupName})`,
      text: `A new Section 2 party registration has been received.\n\n${full}\n\nLicence/passport and signature (secure link, expires in ${LINK_DAYS} days, do not forward). Fresh links are always available in the admin page (${BASE}/admin):\n${BASE}/files/${id}?t=${tokenFor(id)}\n${dupNote}${group.managerEmail ? '' : `\nNOTE: no slot manager email is set for ${rec.groupName} yet, so the manager has not been notified. Once known, add it to GROUPS_JSON on the host; earlier registrations are not re-sent.\n`}` });
    if (group.managerEmail) jobs.push({ to: group.managerEmail, subject: `Ultimate Driver 2027 – ${rec.fullName} has registered for ${rec.groupName}`,
      text: `A member of your slot group has registered.\n\nName: ${rec.fullName}\nGroup: ${rec.groupName}\nPhone: ${rec.phone}\nEmail: ${rec.email}\nRegistered: ${when}\n${dupes.length ? '\nNote: this email address has registered for your group before.\n' : ''}\nID documents are held securely by Racing Queensland and are not shared with slot managers.\n` });
    jobs.push({ to: rec.email, subject: 'Your Ultimate Driver 2027 registration has been received',
      text: `Hi ${rec.fullName},\n\nThanks for registering as a party to ${rec.groupName} for The Ultimate Driver 2027 (The Creek, Albion Park, Fri 19 & Sat 20 Feb 2027).\n\nYour reference is ${id}. Racing Queensland has received your registration${group.managerEmail ? ' and your slot manager has been notified' : ''}.\n\nSummary:\n${full}\n\nIf anything is incorrect, please contact your slot manager or Racing Queensland (${c.racingQueenslandEmail}).\n` });
    for (const j of jobs) queueMail(j).catch(e => console.error('[mail] queue failed', e));
  } catch (e) { if (tmp) fsp.unlink(tmp).catch(() => {}); next(e); }
});

// ---- secure file links (RQ only) ----
const getRec = id => (/^[\w-]+$/.test(id) ? REGS.get(id) : null);
const regDir = id => path.join(DIRS.regs, id);
app.get('/files/:id', (req, res) => {
  const r = getRec(req.params.id); if (!r || !tokenOk(r.id, req.query.t)) return res.status(404).send('Not found or link expired');
  res.set('X-Robots-Tag', 'noindex, nofollow'); res.set('Cache-Control', 'no-store');
  const q = `?t=${encodeURIComponent(req.query.t)}`;
  res.send(`<!doctype html><meta name=viewport content="width=device-width"><meta name=robots content=noindex><title>${esc(r.fullName)}</title><body style="font-family:system-ui;max-width:700px;margin:auto;padding:16px">
  <h2>${esc(r.fullName)} – ${esc(r.groupName)}</h2><pre style="white-space:pre-wrap">${esc(JSON.stringify({ ...r, ip: undefined, userAgent: undefined }, null, 2))}</pre>
  <p><a href="/files/${r.id}/id${q}">Download licence/passport (${esc(r.idDocument.originalName)})</a></p><h3>Signature</h3><img src="/files/${r.id}/sig${q}" style="border:1px solid #ccc;max-width:100%">`);
});
app.get('/files/:id/:kind', (req, res) => {
  const r = getRec(req.params.id); if (!r || !['id', 'sig'].includes(req.params.kind) || !tokenOk(r.id, req.query.t)) return res.status(404).send('Not found or link expired');
  res.set('Cache-Control', 'no-store'); res.set('X-Robots-Tag', 'noindex, nofollow');
  res.sendFile(path.join(regDir(r.id), req.params.kind === 'id' ? r.idDocument.file : r.signatureFile));
});

// ---- admin (HTTP Basic auth, password from ADMIN_PASSWORD) ----
function adminAuth(req, res, next) {
  res.set('X-Robots-Tag', 'noindex, nofollow'); res.set('Cache-Control', 'no-store');
  const [, b64] = (req.get('authorization') || '').split(' ');
  const pass = b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
  const ok = ADMIN_PASSWORD && pass.length === ADMIN_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(ADMIN_PASSWORD));
  if (!ok) return res.set('WWW-Authenticate', 'Basic realm="Ultimate Driver admin"').status(401).send(ADMIN_PASSWORD ? 'Login required' : 'Admin disabled: set ADMIN_PASSWORD');
  next();
}
function filtered(q) {
  const s = String(q.q || '').trim().toLowerCase();
  return [...REGS.values()].filter(r => (!q.group || r.groupId === q.group) && (!s || r.fullName.toLowerCase().includes(s) || r.email.toLowerCase().includes(s)))
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}
const COLS = [['id', 'Reference'], ['registeredBrisbane', 'Registered (Brisbane time)'], ['groupName', 'Group'], ['fullName', 'Full legal name'],
  ['dob', 'Date of birth'], ['address', 'Address'], ['postcode', 'Postcode'], ['phone', 'Phone'], ['email', 'Email'], ['signedDate', 'Signed date'], ['consent', 'Consent'],
  ['licenceFile', 'Licence file (original name)'], ['licenceType', 'Licence file type'], ['possibleDuplicateOf', 'Possible duplicate of']];
const csvCell = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csvRow = r => COLS.map(([k]) => csvCell({ ...r, registeredBrisbane: brisbane(r.submittedAt), dob: r.dob ? dmy(r.dob) : 'N/A', signedDate: dmy(r.signedDate),
  consent: r.consent ? 'Yes' : 'No', licenceFile: r.idDocument.originalName, licenceType: r.idDocument.mimetype, possibleDuplicateOf: (r.possibleDuplicateOf || []).join(' ') }[k])).join(',');
const stamp = () => new Date().toLocaleString('sv-SE', { timeZone: 'Australia/Brisbane' }).replace(/[: ]/g, '-').slice(0, 16);

app.get('/admin', adminAuth, async (req, res) => {
  const recs = filtered(req.query), all = [...REGS.values()];
  const qs = new URLSearchParams({ group: req.query.group || '', q: req.query.q || '' }).toString();
  const [pend, failed] = await Promise.all([fsp.readdir(DIRS.mailPending), fsp.readdir(DIRS.mailFailed)]);
  const failedJobs = await Promise.all(failed.slice(-20).map(f => fsp.readFile(path.join(DIRS.mailFailed, f)).then(JSON.parse).catch(() => null)));
  const pendJobs = await Promise.all(pend.slice(0, 20).map(f => fsp.readFile(path.join(DIRS.mailPending, f)).then(JSON.parse).catch(() => null)));
  const mailRows = [...failedJobs.filter(Boolean).map(j => ['FAILED', j]), ...pendJobs.filter(j => j && j.attempts).map(j => ['retrying', j])]
    .map(([s, j]) => `<tr><td>${s}</td><td>${esc(j.msg.to)}</td><td>${esc(j.msg.subject)}</td><td>${j.attempts}</td><td>${esc(j.errors.at(-1))}</td></tr>`).join('');
  const rows = recs.slice(0, 500).map(r => `<tr><td>${esc(brisbane(r.submittedAt))}</td><td>${esc(r.groupName)}</td><td>${esc(r.fullName)}${r.possibleDuplicateOf?.length ? ' <b style=color:#b00020>(possible duplicate)</b>' : ''}</td><td>${esc(r.email)}<br>${esc(r.phone)}</td><td>${esc(r.dob ? dmy(r.dob) : 'N/A')}</td><td><a href="/files/${r.id}?t=${tokenFor(r.id)}" target=_blank>View</a></td></tr>`).join('');
  const opts = CFG.groups.map(g => `<option value="${esc(g.id)}" ${g.id === req.query.group ? 'selected' : ''}>${esc(g.name)} (${all.filter(r => r.groupId === g.id).length})${g.managerEmail ? '' : ' – no manager email'}</option>`).join('');
  res.send(`<!doctype html><meta name=viewport content="width=device-width"><meta name=robots content=noindex><title>Registrations</title><link rel=stylesheet href="/style.css"><body class=admin>
  <h1>Registrations (${all.length})</h1>
  <form class=bar><select name=group><option value="">All groups</option>${opts}</select> <input type=text name=q placeholder="Search name or email" value="${esc(req.query.q || '')}"> <button class="btn sec">Filter</button></form>
  <p>Showing ${recs.length}${recs.length > 500 ? ' (first 500 listed)' : ''}. <a class="btn sec" href="/admin/export.csv?${qs}">Download CSV</a> <a class="btn sec" href="/admin/export.zip?${qs}">Download all files as ZIP</a></p>
  <p>Email queue: ${pend.length} pending, ${failed.length} failed${smtp ? '' : ' (SMTP not configured – emails are logged to the outbox folder only)'}.</p>
  ${mailRows ? `<details open><summary>Email problems</summary><table><tr><th>Status</th><th>To</th><th>Subject</th><th>Attempts</th><th>Last error</th></tr>${mailRows}</table></details>` : ''}
  <div style="overflow-x:auto"><table><tr><th>Registered (Brisbane)</th><th>Group</th><th>Name</th><th>Contact</th><th>DOB</th><th>Files</th></tr>${rows || '<tr><td colspan=6>None</td></tr>'}</table></div>`);
});
app.get('/admin/export.csv', adminAuth, (req, res) => {
  res.attachment(`ultimate-driver-registrations-${stamp()}.csv`).type('text/csv; charset=utf-8');
  res.send('\uFEFF' + [COLS.map(c => c[1]).join(','), ...filtered(req.query).map(csvRow)].join('\r\n') + '\r\n');
});
app.get('/admin/export.zip', adminAuth, (req, res, next) => {
  const recs = filtered(req.query);
  res.attachment(`ultimate-driver-registrations-${stamp()}.zip`).type('application/zip');
  const zip = archiver('zip', { zlib: { level: 1 } });
  zip.on('error', e => { console.error('[zip]', e); res.destroy(e); });
  zip.pipe(res);
  zip.append('\uFEFF' + [COLS.map(c => c[1]).join(','), ...recs.map(csvRow)].join('\r\n') + '\r\n', { name: 'registrations.csv' });
  for (const r of recs) {
    const folder = `${r.groupName.replace(/[^\w &-]+/g, '_')}/${r.fullName.replace(/[^\w &.-]+/g, '_')} - ${r.id}/`;
    zip.append(JSON.stringify({ ...r, ip: undefined, userAgent: undefined, registeredBrisbane: brisbane(r.submittedAt) }, null, 2), { name: folder + 'details.json' });
    zip.file(path.join(regDir(r.id), r.idDocument.file), { name: folder + 'licence-or-passport' + path.extname(r.idDocument.file) });
    zip.file(path.join(regDir(r.id), r.signatureFile), { name: folder + 'signature.png' });
  }
  zip.finalize();
});

// ---- errors ----
app.use((err, req, res, next) => {
  if (req.file?.path) fsp.unlink(req.file.path).catch(() => {});
  const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 10 MB).' : err instanceof multer.MulterError ? 'Upload problem: ' + err.message : null;
  if (!msg) console.error('[error]', err);
  const text = msg || 'Sorry, something went wrong on our side and your registration was not saved. Please try again in a few minutes.';
  if (req.path === '/submit' || req.accepts(['html', 'json']) === 'json') return res.status(msg ? 400 : 500).json({ ok: false, errors: [text] });
  res.status(msg ? 400 : 500).send(`<!doctype html><meta name=viewport content="width=device-width"><link rel=stylesheet href="/style.css"><main><div class=card><h2>Something went wrong</h2><p>${esc(text)}</p><p><a href="/">Back to the form</a></p></div></main>`);
});
app.use((req, res) => res.status(404).send('<!doctype html><link rel=stylesheet href="/style.css"><main><div class=card><h2>Page not found</h2><p><a href="/">Go to the registration form</a></p></div></main>'));

// clean stale temp uploads on start
for (const f of fs.readdirSync(DIRS.tmp)) fs.rmSync(path.join(DIRS.tmp, f), { force: true });
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Ultimate Driver form on :${PORT} | data: ${DATA} | email: ${smtp ? 'SMTP ' + process.env.SMTP_HOST : 'OUTBOX only (not sending)'} | ${REGS.size} registrations loaded`));
