// The Ultimate Driver 2027 – Section 2 party sign-up prototype
const express = require('express'), multer = require('multer'), nodemailer = require('nodemailer');
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const ROOT = __dirname;
const cfg = () => {
  const f = fs.existsSync(path.join(ROOT, 'config.local.json')) ? 'config.local.json' : 'config.json';
  const c = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  if (process.env.GROUPS_JSON) c.groups = JSON.parse(process.env.GROUPS_JSON); // private manager emails live in an env var on the host
  if (process.env.RQ_EMAIL) c.racingQueenslandEmail = process.env.RQ_EMAIL;
  if (process.env.MAIL_FROM) c.fromEmail = process.env.MAIL_FROM;
  return c;
};
const DATA = process.env.DATA_DIR || path.join(ROOT, 'private-data');
const OUTBOX = path.join(ROOT, 'outbox');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const BASE = process.env.PUBLIC_BASE_URL || cfg().publicBaseUrl;
[DATA, OUTBOX].forEach(d => fs.mkdirSync(d, { recursive: true }));

const ALLOWED = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/heic': '.heic', 'image/heif': '.heif', 'application/pdf': '.pdf' };
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: cfg().maxUploadMB * 1024 * 1024, files: 1 },
  fileFilter: (req, f, cb) => ALLOWED[f.mimetype] ? cb(null, true) : cb(new Error('Licence/passport must be a JPG, PNG, HEIC or PDF file.'))
});

// ---- email ----
const smtp = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: +(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true',
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
}) : null;
async function sendMail(msg) {
  msg.from = process.env.MAIL_FROM || cfg().fromEmail;
  if (smtp) return smtp.sendMail(msg);
  const f = path.join(OUTBOX, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.txt`);
  fs.writeFileSync(f, `From: ${msg.from}\nTo: ${msg.to}\nSubject: ${msg.subject}\n\n${msg.text}\n`);
  console.log('[outbox] logged email to', msg.to, '->', path.basename(f));
}

// ---- helpers ----
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LINK_DAYS = +(process.env.LINK_EXPIRY_DAYS || 30);
const hmac = s => crypto.createHmac('sha256', (process.env.LINK_SECRET || ADMIN_PASSWORD || 'dev-secret')).update(s).digest('hex').slice(0, 32);
// token = <expiry-epoch-seconds>.<hmac(id.expiry)>
const tokenFor = (id, days = LINK_DAYS) => { const exp = Math.floor(Date.now() / 1000) + days * 86400; return `${exp}.${hmac(id + '.' + exp)}`; };
// simple in-memory rate limit for /submit
const hits = new Map(), RL_MAX = +(process.env.RATE_LIMIT_MAX || 10), RL_WIN = 15 * 60 * 1000;
function rateLimit(req, res, next) {
  const now = Date.now(), arr = (hits.get(req.ip) || []).filter(t => now - t < RL_WIN);
  if (arr.length >= RL_MAX) return res.status(429).json({ ok: false, errors: ['Too many submissions from this connection. Please try again in 15 minutes.'] });
  arr.push(now); hits.set(req.ip, arr); next();
}
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

const app = express();
app.use(express.static(path.join(ROOT, 'public')));
app.get('/api/groups', (req, res) => res.json(cfg().groups.map(g => ({ id: g.id, name: g.name }))));
app.get('/api/config', (req, res) => res.json({ maxUploadMB: cfg().maxUploadMB }));

app.post('/submit', rateLimit, upload.single('idDocument'), async (req, res) => {
  try {
    const b = req.body, c = cfg(), errs = [];
    const group = c.groups.find(g => g.id === b.groupId);
    if (!group) errs.push('Please select your slot group.');
    for (const [k, l] of [['fullName', 'Full legal name'], ['address', 'Residential/registered address'], ['postcode', 'Postcode'], ['phone', 'Phone'], ['email', 'Email'], ['signedDate', 'Signature date']])
      if (!String(b[k] || '').trim()) errs.push(`${l} is required.`);
    if (b.dobNA !== 'on' && !b.dob) errs.push('Date of birth is required (or tick Not Applicable).');
    if (b.postcode && !/^\d{4}$/.test(b.postcode.trim())) errs.push('Postcode must be 4 digits.');
    if (b.email && !emailOk(b.email.trim())) errs.push('Email address looks invalid.');
    if (!req.file) errs.push("Please upload your driver's licence or passport.");
    if (!/^data:image\/png;base64,/.test(b.signature || '')) errs.push('Please sign in the signature box.');
    if (b.consent !== 'on') errs.push('You must agree to the Terms and Conditions and acknowledgements.');
    if (errs.length) return res.status(400).json({ ok: false, errors: errs });

    const dupes = fs.readdirSync(DATA).map(loadRec).filter(r => r && r.groupId === group.id && r.email.toLowerCase() === b.email.trim().toLowerCase());
    const id = new Date().toISOString().slice(0, 10) + '-' + crypto.randomBytes(5).toString('hex');
    const dir = path.join(DATA, id); fs.mkdirSync(dir, { recursive: true });
    const idFile = 'id-document' + ALLOWED[req.file.mimetype];
    fs.writeFileSync(path.join(dir, idFile), req.file.buffer);
    fs.writeFileSync(path.join(dir, 'signature.png'), Buffer.from(b.signature.split(',')[1], 'base64'));
    const rec = {
      id, submittedAt: new Date().toISOString(), groupId: group.id, groupName: group.name,
      isManager: b.isManager === 'on', fullName: b.fullName.trim(), dob: b.dobNA === 'on' ? null : b.dob, dobNotApplicable: b.dobNA === 'on',
      address: b.address.trim(), postcode: b.postcode.trim(), phone: b.phone.trim(), email: b.email.trim(),
      signedDate: b.signedDate, consent: true, idDocument: { file: idFile, originalName: req.file.originalname, mimetype: req.file.mimetype, bytes: req.file.size },
      signatureFile: 'signature.png', possibleDuplicateOf: dupes.map(r => r.id), ip: req.ip, userAgent: req.get('user-agent')
    };
    fs.writeFileSync(path.join(dir, 'submission.json'), JSON.stringify(rec, null, 2));

    const link = `${BASE}/files/${id}?t=${tokenFor(id)}`;
    const details = `Slot group: ${rec.groupName}\nRole: ${rec.isManager ? 'Party 1 – Manager/Contact Person' : 'Party (member)'}\nFull legal name: ${rec.fullName}\nDate of birth: ${rec.dob || 'Not applicable (company/trust)'}\nAddress: ${rec.address} ${rec.postcode}\nPhone: ${rec.phone}\nEmail: ${rec.email}\nSigned: ${rec.signedDate}\nConsent to T&Cs and Section 3 acknowledgements: Yes\nReference: ${id}`;
    const to = [group.managerEmail, c.racingQueenslandEmail].filter(Boolean);
    const flags = (group.managerEmail ? '' : `[NO MANAGER SET] `) + (dupes.length ? '[POSSIBLE DUPLICATE] ' : '');
    const dupNote = dupes.length ? `\nWARNING: possible duplicate – this email has already registered for ${rec.groupName} (${dupes.map(r => r.id).join(', ')}).\n` : '';
    await sendMail({ to: to.join(', '), subject: `${flags}Ultimate Driver 2027 – new party registration: ${rec.fullName} (${rec.groupName})`,
      text: `A new Section 2 party registration has been received.\n\n${details}\n\nLicence/passport and signature (secure link, expires in ${LINK_DAYS} days, do not forward):\n${link}\n${dupNote}${group.managerEmail ? '' : `\nNOTE: no slot manager email is configured for ${rec.groupName} yet – this registration has been sent to Racing Queensland only. Please forward to the manager once known (add their email in config.json).\n`}` });
    await sendMail({ to: rec.email, subject: 'Your Ultimate Driver 2027 registration has been received',
      text: `Hi ${rec.fullName},\n\nThanks for registering as a party to ${rec.groupName} for The Ultimate Driver 2027 (The Creek, Albion Park, Fri 19 & Sat 20 Feb 2027).\n\nYour reference is ${id}. Your slot manager and Racing Queensland have been notified.\n\nSummary:\n${details}\n\nIf anything is incorrect, please contact your slot manager or Racing Queensland (${c.racingQueenslandEmail}).\n` });
    res.json({ ok: true, id, warning: dupes.length ? 'You have already registered for this group with this email. Your new registration has been saved as well; contact your slot manager if this was a mistake.' : null });
  } catch (e) { console.error(e); res.status(500).json({ ok: false, errors: ['Server error, please try again.'] }); }
});

// ---- secure file links ----
function loadRec(id) { if (!/^[\w-]+$/.test(id)) return null; try { return JSON.parse(fs.readFileSync(path.join(DATA, id, 'submission.json'))); } catch { return null; } }
const tokenOk = (id, t) => { const [exp, sig] = String(t || '').split('.'); if (!/^\d+$/.test(exp) || !sig || sig.length !== 32) return false;
  if (+exp * 1000 < Date.now()) return false; return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(hmac(id + '.' + exp))); };
app.get('/files/:id', (req, res) => {
  const r = loadRec(req.params.id); if (!r || !tokenOk(r.id, req.query.t)) return res.status(404).send('Not found');
  const q = `?t=${req.query.t}`;
  res.send(`<!doctype html><meta name=viewport content="width=device-width"><title>${esc(r.fullName)}</title><body style="font-family:system-ui;max-width:700px;margin:auto;padding:16px">
  <h2>${esc(r.fullName)} – ${esc(r.groupName)}</h2><pre>${esc(JSON.stringify({ ...r, ip: undefined, userAgent: undefined }, null, 2))}</pre>
  <p><a href="/files/${r.id}/id${q}">Download licence/passport (${esc(r.idDocument.originalName)})</a></p><h3>Signature</h3><img src="/files/${r.id}/sig${q}" style="border:1px solid #ccc;max-width:100%">`);
});
app.get('/files/:id/:kind', (req, res) => {
  if (!['id','sig'].includes(req.params.kind)) return res.status(404).send('Not found');
  const r = loadRec(req.params.id); if (!r || !tokenOk(r.id, req.query.t)) return res.status(404).send('Not found');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(DATA, r.id, req.params.kind === 'id' ? r.idDocument.file : r.signatureFile));
});

// ---- admin (HTTP Basic auth, password from ADMIN_PASSWORD) ----
app.get('/admin', (req, res) => {
  const [, b64] = (req.get('authorization') || '').split(' ');
  const pass = b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
  if (!ADMIN_PASSWORD || pass !== ADMIN_PASSWORD) return res.set('WWW-Authenticate', 'Basic realm="Ultimate Driver admin"').status(401).send(ADMIN_PASSWORD ? 'Login required' : 'Admin disabled: set ADMIN_PASSWORD');
  const recs = fs.readdirSync(DATA).map(loadRec).filter(Boolean).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  const filter = req.query.group;
  const rows = recs.filter(r => !filter || r.groupId === filter).map(r => `<tr><td>${esc(new Date(r.submittedAt).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }))}</td><td>${esc(r.groupName)}</td><td>${esc(r.fullName)}${r.isManager ? ' <b>(Manager)</b>' : ''}${r.possibleDuplicateOf?.length ? ' <b style=color:#b00020>(possible duplicate)</b>' : ''}</td><td>${esc(r.email)}<br>${esc(r.phone)}</td><td>${esc(r.dob || 'N/A')}</td><td><a href="/files/${r.id}?t=${tokenFor(r.id)}">View</a></td></tr>`).join('');
  const opts = cfg().groups.map(g => `<option value="${g.id}" ${g.id === filter ? 'selected' : ''}>${esc(g.name)} (${recs.filter(r => r.groupId === g.id).length})</option>`).join('');
  res.send(`<!doctype html><meta name=viewport content="width=device-width"><title>Registrations</title><link rel=stylesheet href="/style.css"><body class=admin><h1>Registrations (${recs.length})</h1>
  <form><select name=group onchange="this.form.submit()"><option value="">All groups</option>${opts}</select></form>
  <div style="overflow-x:auto"><table><tr><th>Submitted (Brisbane)</th><th>Group</th><th>Name</th><th>Contact</th><th>DOB</th><th>Files</th></tr>${rows || '<tr><td colspan=6>None yet</td></tr>'}</table></div>`);
});

app.use((err, req, res, next) => res.status(400).json({ ok: false, errors: [err.code === 'LIMIT_FILE_SIZE' ? `File is too large (max ${cfg().maxUploadMB} MB).` : err.message] }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Ultimate Driver form on :${PORT} | email: ${smtp ? 'SMTP ' + process.env.SMTP_HOST : 'OUTBOX (not sending)'}`));
