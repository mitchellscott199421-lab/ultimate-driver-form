const $ = s => document.querySelector(s);
let MAXMB = 10;
fetch('/api/groups').then(r => r.json()).then(gs => gs.forEach(g => $('#groupId').add(new Option(g.name, g.id))));
fetch('/api/config').then(r => r.json()).then(c => { MAXMB = c.maxUploadMB; $('#maxmb').textContent = MAXMB; });
fetch('terms.txt').then(r => r.text()).then(t => $('#terms').textContent = t);
const d = new Date(); $('#signedDate').value = new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
$('#dobNA').onchange = e => { $('#dob').disabled = e.target.checked; if (e.target.checked) $('#dob').value = ''; };

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
  if (!f.dobNA.checked && !f.dob.value) errs.push('Date of birth is required (or tick Not Applicable).');
  if (!f.address.value.trim()) errs.push('Address is required.');
  if (!/^\d{4}$/.test(f.postcode.value.trim())) errs.push('Postcode must be 4 digits.');
  if (!f.phone.value.trim()) errs.push('Phone is required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.value.trim())) errs.push('A valid email is required.');
  const file = f.idDocument.files[0];
  if (!file) errs.push("Please upload your driver's licence or passport.");
  else { if (!/\.(jpe?g|png|heic|heif|pdf)$/i.test(file.name)) errs.push('Licence/passport must be JPG, PNG, HEIC or PDF.'); if (file.size > MAXMB * 1048576) errs.push(`File is too large (max ${MAXMB} MB).`); }
  if (!signed) errs.push('Please sign in the signature box.');
  if (!f.signedDate.value) errs.push('Signature date is required.');
  if (!f.consent.checked) errs.push('You must agree to the Terms and Conditions and acknowledgements.');
  showErr(errs); if (errs.length) return;
  const fd = new FormData(f); fd.append('signature', cv.toDataURL('image/png'));
  $('#submit').disabled = true; $('#submit').textContent = 'Submitting…';
  try {
    const r = await (await fetch('/submit', { method: 'POST', body: fd })).json();
    if (!r.ok) return showErr(r.errors);
    f.hidden = true; $('#done').hidden = false; $('#ref').textContent = r.id; if (r.warning) $('#warn').textContent = r.warning; scrollTo(0, 0);
  } catch { showErr(['Network error – please try again.']); }
  finally { $('#submit').disabled = false; $('#submit').textContent = 'Submit registration'; }
};
