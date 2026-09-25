/* StudentDataExporter v3.1 offscreen page.
 * The service worker has no DOM and cannot create blob URLs, and Chrome names
 * data-URL downloads "download" ignoring the requested filename. This offscreen
 * page receives the XLSX bytes and saves them through an anchor download, which
 * always honors the filename.
 */
'use strict';

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'download-xlsx') return false;
  try {
    const bytes = Uint8Array.from(atob(msg.b64), function (c) { return c.charCodeAt(0); });
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = msg.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // give the download manager a moment before revoking the blob, then tell the worker
    setTimeout(function () {
      try { URL.revokeObjectURL(url); } catch (e) {}
      try { chrome.runtime.sendMessage({ type: 'offscreen-download-done', filename: msg.filename }, function () { void chrome.runtime.lastError; }); } catch (e) {}
    }, 800);
    sendResponse({ ok: true });
  } catch (e) {
    sendResponse({ ok: false, error: String((e && e.message) || e) });
  }
  return false;
});
