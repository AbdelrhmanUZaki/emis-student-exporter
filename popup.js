/* StudentDataExporter v3.0 popup — thin UI only.
 * The export runs in the background service worker and keeps going even if this
 * popup is closed. Progress lives in chrome.storage.session ('exportState') and
 * this popup renders it live via chrome.storage.onChanged.
 */
'use strict';

const STATE_KEY = 'exportState';
function $(id) { return document.getElementById(id); }
function setStatus(t) { $('status').textContent = t || ''; }
function setCounts(t) { $('counts').textContent = t || ''; }
function setProgress(done, total) {
  const bar = $('progress'), fill = $('progressBar');
  if (!total || !done) { bar.style.display = 'none'; return; }
  bar.style.display = 'block';
  fill.style.width = Math.round((done / total) * 100) + '%';
}
function selectedGrades() {
  const out = [];
  for (let g = 1; g <= 6; g++) if ($('grade-' + g).checked) out.push(g);
  return out;
}
function setFormEnabled(v) {
  for (let g = 1; g <= 6; g++) $('grade-' + g).disabled = !v;
  $('sort').disabled = !v;
  $('allBtn').disabled = !v;
  $('noneBtn').disabled = !v;
  $('exportBtn').disabled = !v;
  $('cancelBtn').style.display = v ? 'none' : 'block';
}
function render(st) {
  if (!st) return;
  setStatus(st.status);
  setCounts(st.counts);
  setProgress(st.running ? st.done : 0, st.running ? st.total : 0);
  setFormEnabled(!st.running);
  $('retryBtn').style.display = (!st.running && st.lastFailed && st.lastFailed.length) ? 'block' : 'none';
}
function send(msg) {
  try { chrome.runtime.sendMessage(msg, function () {}); } catch (e) {}
}

function on(id, ev, fn) { const el = $(id); if (el) el.addEventListener(ev, fn); }
on('allBtn', 'click', function () { for (let g = 1; g <= 6; g++) $('grade-' + g).checked = true; });
on('noneBtn', 'click', function () { for (let g = 1; g <= 6; g++) $('grade-' + g).checked = false; });
on('exportBtn', 'click', function () {
  if (!selectedGrades().length) { setStatus('اختر صفاً واحداً على الأقل'); return; }
  setStatus('جاري التحضير...');
  setCounts('');
  setFormEnabled(false);
  send({ type: 'start', grades: selectedGrades(), sort: $('sort').value });
});
on('retryBtn', 'click', function () {
  setStatus('جاري إعادة المحاولة...');
  send({ type: 'retry', sort: $('sort').value });
});
on('cancelBtn', 'click', function () { setStatus('جاري الإلغاء...'); send({ type: 'cancel' }); });

// show current/last state (also after reopening the popup mid- or post-export)
chrome.storage.session.get(STATE_KEY).then(function (d) { render(d[STATE_KEY]); }).catch(function () {});
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === 'session' && changes[STATE_KEY]) render(changes[STATE_KEY].newValue);
});
