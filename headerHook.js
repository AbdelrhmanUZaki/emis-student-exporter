/* headerHook.js — captures the EMIS app's OWN studaapi request headers.
 * Runs at document_start in MAIN world, BEFORE page scripts.
 * Saves only auth header names/values to sessionStorage['emisCapturedHeaders'].
 */
(function () {
  'use strict';
  var KEY = 'emisCapturedHeaders';
  var API_HOST = 'studaapi.emis.gov.eg';
  var KEEP = ['authorization', 'schoolcode', 'schoolstage', 'usertype'];

  function save(headers) {
    try {
      var out = {};
      for (var k in headers) {
        if (!Object.prototype.hasOwnProperty.call(headers, k)) continue;
        var lk = String(k).toLowerCase();
        if (KEEP.indexOf(lk) !== -1) out[lk] = String(headers[k]);
      }
      if (Object.keys(out).length) sessionStorage.setItem(KEY, JSON.stringify(out));
    } catch (e) {}
  }
  function toObj(src) {
    var out = {};
    try {
      if (!src) return out;
      if (typeof src.forEach === 'function') src.forEach(function (v, k) { out[k] = v; });
      else Object.keys(src).forEach(function (k) { out[k] = src[k]; });
    } catch (e) {}
    return out;
  }

  // fetch hook
  try {
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (String(url).indexOf(API_HOST) !== -1) {
          var h = toObj(init && init.headers);
          if (typeof Request !== 'undefined' && input instanceof Request) {
            var rh = toObj(input.headers);
            Object.keys(rh).forEach(function (k) { if (!h[k]) h[k] = rh[k]; });
          }
          save(h);
        }
      } catch (e) {}
      return origFetch.apply(this, arguments);
    };
  } catch (e) {}

  // XHR hook (axios and most SPAs use XHR setRequestHeader)
  try {
    var cur = null;
    var origOpen = XMLHttpRequest.prototype.open;
    var origSet = XMLHttpRequest.prototype.setRequestHeader;
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) {
      cur = { url: String(u), headers: {} };
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      if (cur) cur.headers[k] = v;
      return origSet.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      try { if (cur && cur.url.indexOf(API_HOST) !== -1) save(cur.headers); } catch (e) {}
      cur = null;
      return origSend.apply(this, arguments);
    };
  } catch (e) {}
})();
