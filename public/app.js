const $ = s => document.querySelector(s);
let MAXMB = 10;
fetch('/api/groups').then(r => r.json()).then(gs => gs.forEach(g => $('#groupId').add(new Option(g.name, g.id))));
fetch('/api/config').then(r => r.json()).then(c => { MAXMB = c.maxUploadMB; $('#maxmb').textContent = MAXMB; });
fetch('terms.txt').then(r => r.text()).then(t => $('#terms').textContent = t);
// Signature date: shown read-only as d/m/yyyy (Brisbane); the server sets the real date.
$('#signedDateShow').value = new Date().toLocaleDateString('en-AU', { timeZone: 'Australia/Brisbane', day: '2-digit', month: '2-digit', year: 'numeric' });
// Date of birth: day / month / year drop-downs
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
for (let i = 1; i <= 31; i++) $('#dobD').add(new Option(i, i));
MONTHS.forEach((m, i) => $('#dobM').add(new Option(m, i + 1)));
for (let y = new Date().getFullYear() - 16; y >= 1900; y--) $('#dobY').add(new Option(y, y));
const dobIso = () => { const d = +$('#dobD').value, m = +$('#dobM').value, y = +$('#dobY').value; if (!d || !m || !y) return ''; const t = new Date(Date.UTC(y, m - 1, d)); if (t.getUTCDate() !== d || t.getUTCMonth() !== m - 1) return 'invalid'; return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; };

// signature pad
const cv = $('#sig'), ctx = cv.getContext('2d'); let drawing = false, signed = false;
function size() { const r = cv.getBoundingClientRect(), dpr = devicePixelRatio || 1; cv.width = r.width * dpr; cv.height = r.height * dpr; ctx.scale(dpr, dpr); ctx.lineWidth = 2.2; ctx.lineCap = ctx.lineJoin = 'round'; ctx.strokeStyle = '#0b1f3a'; signed = false; }
size(); addEventListener('resize', () => { if (!signed) size(); });
const pt = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
cv.onpointerdown = e => { drawing = true; cv.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...pt(e)); };
cv.onpointermove = e => { if (!drawing) return; ctx.lineTo(...pt(e)); ctx.stroke(); signed = true; };
cv.onpointerup = cv.onpointercancel = () => drawing = false;
$('#clear').onclick = () => { ctx.clearRect(0, 0, cv.width, cv.height); signed = false; };

function showErr(list) { const el = $('#errs'); el.innerHTML = list.map(x => '• ' + x).join('<br>'); el.style.display = list.length ? 'block' : 'none'; if (list.length) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
$('#f').onsubmit = async e => {
  e.preventDefault(); const f = e.target, errs = [];
  if (!f.groupId.value) errs.push('Please select your slot group.');
  if (!f.fullName.value.trim()) errs.push('Full legal name is required.');
  const iso = dobIso(); f.dob.value = iso === 'invalid' ? '' : iso;
  if (iso === 'invalid') errs.push('That date of birth is not a real date.');
  else if (!iso) errs.push('Date of birth is required (day, month and year).');
  if (!f.address.value.trim()) errs.push('Address is required.');
  if (!/^\d{4}$/.test(f.postcode.value.trim())) errs.push('Postcode must be 4 digits.');
  if (!f.phone.value.trim()) errs.push('Phone is required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.value.trim())) errs.push('A valid email is required.');
  const file = f.idDocument.files[0];
  if (!file) errs.push("Please upload your driver's licence or passport.");
  else { if (!/\.(jpe?g|png|heic|heif|pdf)$/i.test(file.name)) errs.push('Licence/passport must be JPG, PNG, HEIC or PDF.'); if (file.size > MAXMB * 1048576) errs.push(`File is too large (max ${MAXMB} MB).`); }
  if (!signed) errs.push('Please sign in the signature box.');
  if (!f.consent.checked) errs.push('You must agree to the Terms and Conditions and acknowledgements.');
  showErr(errs); if (errs.length) return;
  const fd = new FormData(f); fd.append('signature', cv.toDataURL('image/png'));
  $('#submit').disabled = true; $('#submit').textContent = 'Submitting…';
  try {
    const resp = await fetch('/submit', { method: 'POST', body: fd });
    let r; try { r = await resp.json(); } catch { r = { ok: false, errors: [resp.status === 413 ? 'File is too large (max 10 MB).' : 'Sorry, the server is busy or something went wrong. Your details are still on this page – please try again in a minute.'] }; }
    if (!r.ok) return showErr(r.errors);
    f.hidden = true; $('#done').hidden = false; $('#ref').textContent = r.id; if (r.warning) $('#warn').textContent = r.warning; scrollTo(0, 0);
  } catch { showErr(['Could not reach the server. Check your connection – your details are still on this page – and try again.']); }
  finally { $('#submit').disabled = false; $('#submit').textContent = 'Submit registration'; }
};
