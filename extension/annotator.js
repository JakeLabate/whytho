/* WhyTho annotator engine
   Loads into any page via bookmarklet or script tag. Self contained, no dependencies.
   All UI lives in a shadow root so host page CSS cannot reach it and it cannot leak out.
   Storage is localStorage on the annotated origin. Export moves notes to the console. */
(function () {
  'use strict';

  if (window.__why__) { window.__why__.toggle(); return; }

  var CONSOLE_URL = 'https://whytho.jakelabate.com/';
  var SYNC_URL = 'https://vvekkbboqqkxnlpmxazh.supabase.co/functions/v1/why-sync';
  var VERSION = '5.1';

  var SVG = {
    cursor: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M3 1.5l9.5 5.6-4.1 1-2.2 4z"/></svg>',
    close: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path stroke="currentColor" stroke-width="1.7" fill="none" d="M4 4l8 8M12 4l-8 8"/></svg>',
    list: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path stroke="currentColor" stroke-width="1.6" fill="none" d="M2.5 4h11M2.5 8h11M2.5 12h7"/></svg>',
    more: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle fill="currentColor" cx="3" cy="8" r="1.4"/><circle fill="currentColor" cx="8" cy="8" r="1.4"/><circle fill="currentColor" cx="13" cy="8" r="1.4"/></svg>',
    trash: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path stroke="currentColor" stroke-width="1.4" fill="none" d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8h5.8l.6-8M6.7 7v3.4M9.3 7v3.4"/></svg>',
    phone: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="4.5" y="2" width="7" height="12" rx="1.6" stroke="currentColor" stroke-width="1.3" fill="none"/><path stroke="currentColor" stroke-width="1.3" d="M7 12.2h2"/></svg>',
    screen: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="1.8" y="3" width="12.4" height="8.4" rx="1.3" stroke="currentColor" stroke-width="1.3" fill="none"/><path stroke="currentColor" stroke-width="1.3" d="M6 13.6h4"/></svg>',
    hidden: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path stroke="currentColor" stroke-width="1.3" fill="none" d="M2 8s2.4-3.8 6-3.8S14 8 14 8s-2.4 3.8-6 3.8S2 8 2 8z"/><path stroke="currentColor" stroke-width="1.3" d="M3 13L13 3"/></svg>'
  };
  var STORE_PREFIX = 'why:v1:';
  var CATEGORIES = [
    { id: 'seo', label: 'SEO', color: '#5b21b6' },
    { id: 'content', label: 'Content', color: '#0f766e' },
    { id: 'tech', label: 'Technical', color: '#b45309' },
    { id: 'a11y', label: 'Accessibility', color: '#be123c' },
    { id: 'perf', label: 'Performance', color: '#1d4ed8' },
    { id: 'ux', label: 'UX', color: '#7c2d12' }
  ];
  var STATUSES = ['decided', 'proposed', 'question', 'do not change'];
  var WIDTHS = [
    { id: 'mobile', label: 'Mobile', px: 390, h: 844 },
    { id: 'tablet', label: 'Tablet', px: 820, h: 1024 },
    { id: 'laptop', label: 'Laptop', px: 1280, h: 800 },
    { id: 'desktop', label: 'Desktop', px: 1512, h: 900 }
  ];

  /* ---------- utilities ---------- */

  function uid() {
    return 'n_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // Mentions are rendered from the note body after escaping, so nothing injects markup.
  function withMentions(text) {
    var out = esc(text);
    directory.slice().sort(function (a, b) { return b.label.length - a.label.length; }).forEach(function (d) {
      var needle = '@' + esc(d.label);
      out = out.split(needle).join('<span class="tagged">' + needle + '</span>');
    });
    return out;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function scopeOf(n) {
    var a = n.appliesTo || n.applies_to;
    return (Array.isArray(a) && a.length) ? a : ['all'];
  }

  function inScope(n, bp) {
    var a = scopeOf(n);
    return a.indexOf('all') > -1 || a.indexOf(bp) > -1;
  }

  function scopeLabel(n) {
    var a = scopeOf(n);
    if (a.indexOf('all') > -1) return 'All widths';
    return a.map(function (id) {
      var hit = 'Other';
      WIDTHS.forEach(function (w) { if (w.id === id) hit = w.label; });
      return hit;
    }).join(', ') + ' only';
  }

  // A real window at a real width, so media queries fire honestly. Same origin,
  // so this window can load the annotator into it.
  function openAtWidth(px, h) {
    var win = window.open(location.href, '_blank', 'width=' + px + ',height=' + (h || 844) + ',scrollbars=yes');
    if (!win) { toast('Your browser blocked the new window. Allow popups for this site and try again.'); return; }
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      var done = false;
      try {
        if (win.closed) { done = true; }
        else if (win.document && win.document.readyState === 'complete' && win.document.body) {
          if (!win.__why__) {
            var sc = win.document.createElement('script');
            sc.src = SRC + '?t=' + Date.now();
            if (TOKEN) sc.setAttribute('data-why-token', TOKEN);
            win.document.body.appendChild(sc);
          }
          done = true;
        }
      } catch (e) {
        done = true;   // different origin after a redirect, nothing more we can do
        toast('Opened in a new window. Start WhyTho there with your bookmarklet.');
      }
      if (done || tries > 40) clearInterval(timer);
    }, 250);
  }

  function breakpoint(w) {
    if (w < 640) return 'mobile';
    if (w < 1024) return 'tablet';
    if (w < 1440) return 'laptop';
    return 'desktop';
  }

  function viewportSnapshot() {
    var w = window.innerWidth, h = window.innerHeight;
    return {
      width: w,
      height: h,
      breakpoint: breakpoint(w),
      dpr: window.devicePixelRatio || 1,
      touch: ('ontouchstart' in window) || navigator.maxTouchPoints > 0
    };
  }

  function pageKey() {
    return STORE_PREFIX + location.origin + location.pathname;
  }

  /* Class names that look machine generated are unstable anchors, so drop them. */
  function stableClasses(el) {
    var out = [];
    var list = (el.getAttribute('class') || '').trim().split(/\s+/);
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c) continue;
      if (c.indexOf('why-') === 0) continue;
      if (/^(is-|has-|js-)/.test(c)) continue;
      if (/[0-9a-f]{6,}/i.test(c)) continue;      // hashed build classes
      if (/^css-[a-z0-9]+$/i.test(c)) continue;   // emotion / styled
      if (/^sc-[a-zA-Z0-9]+$/.test(c)) continue;  // styled-components
      if (c.length > 40) continue;
      out.push(c);
      if (out.length === 3) break;
    }
    return out;
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/([^\w-])/g, '\\$1');
  }

  function isUnique(sel) {
    try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; }
  }

  /* Prefer meaning over position: id, then test hooks, then class path, then nth-of-type. */
  function buildSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id && isUnique('#' + cssEscape(el.id))) return '#' + cssEscape(el.id);

    var hooks = ['data-why-id', 'data-testid', 'data-test', 'data-qa', 'data-cy', 'name'];
    for (var h = 0; h < hooks.length; h++) {
      var v = el.getAttribute(hooks[h]);
      if (v) {
        var s = el.tagName.toLowerCase() + '[' + hooks[h] + '="' + v.replace(/"/g, '\\"') + '"]';
        if (isUnique(s)) return s;
      }
    }

    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var tag = node.tagName.toLowerCase();
      var seg = tag;
      var cls = stableClasses(node);
      if (cls.length) seg += '.' + cls.map(cssEscape).join('.');

      var parent = node.parentElement;
      if (parent) {
        var sameSeg = [];
        for (var i = 0; i < parent.children.length; i++) {
          var sib = parent.children[i];
          if (sib.tagName !== node.tagName) continue;
          var sc = stableClasses(sib);
          if (cls.length && sc.join(' ') !== cls.join(' ')) continue;
          sameSeg.push(sib);
        }
        if (sameSeg.length > 1) {
          seg += ':nth-of-type(' + (Array.prototype.indexOf.call(
            Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; }),
            node) + 1) + ')';
        }
      }

      parts.unshift(seg);
      var candidate = parts.join(' > ');
      if (isUnique(candidate)) return candidate;
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function snippet(el) {
    var t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return t.slice(0, 120);
  }

  // Everything about the element's surroundings that can be read from the DOM.
  // This works everywhere, needs no permissions, and stays useful after the page moves on.
  function captureContext(el) {
    var txt = function (n) {
      if (!n) return '';
      var t = (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim();
      return t.slice(0, 220);
    };

    var heading = null;
    var walk = el;
    outer:
    while (walk && walk !== document.body) {
      var prev = walk.previousElementSibling;
      while (prev) {
        if (/^H[1-6]$/.test(prev.tagName)) { heading = txt(prev); break outer; }
        var inner = prev.querySelector && prev.querySelector('h1,h2,h3,h4,h5,h6');
        if (inner) { heading = txt(inner); break outer; }
        prev = prev.previousElementSibling;
      }
      walk = walk.parentElement;
    }

    var ancestors = [];
    var up = el.parentElement;
    while (up && up !== document.documentElement && ancestors.length < 4) {
      ancestors.push(describe(up));
      up = up.parentElement;
    }

    var cs = null;
    try { cs = window.getComputedStyle(el); } catch (e) { }
    var r = el.getBoundingClientRect();

    var link = el.tagName === 'A' ? el.getAttribute('href')
      : (el.querySelector && el.querySelector('a') ? el.querySelector('a').getAttribute('href') : null);

    return {
      text: txt(el),
      before: txt(el.previousElementSibling),
      after: txt(el.nextElementSibling),
      parent_text: txt(el.parentElement),
      heading: heading,
      ancestors: ancestors,
      href: link || null,
      alt: el.getAttribute ? (el.getAttribute('alt') || null) : null,
      aria_label: el.getAttribute ? (el.getAttribute('aria-label') || null) : null,
      rect: { x: Math.round(r.left), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) },
      styles: cs ? {
        font_size: cs.fontSize, font_weight: cs.fontWeight, color: cs.color,
        display: cs.display, position: cs.position
      } : null,
      page_title: document.title.slice(0, 200),
      captured_at: new Date().toISOString()
    };
  }

  /* A real screenshot is only possible through the extension, which can capture the
     visible tab. The relay it injects answers this message; without it we simply
     carry on with the text context. */
  function requestShot(el) {
    if (!FROM_EXTENSION || !el) return Promise.resolve(null);
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return Promise.resolve(null);
    if (r.bottom < 0 || r.top > window.innerHeight) return Promise.resolve(null);

    return new Promise(function (resolve) {
      var done = false;
      function onMsg(e) {
        if (!e.data || e.data.type !== 'whytho:shot:result') return;
        if (e.source && e.source !== window) return;
        window.removeEventListener('message', onMsg);
        done = true;
        resolve(e.data.error ? null : e.data.dataUrl || null);
      }
      window.addEventListener('message', onMsg);
      window.postMessage({
        type: 'whytho:shot',
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
        dpr: window.devicePixelRatio || 1
      }, '*');
      setTimeout(function () {
        if (done) return;
        window.removeEventListener('message', onMsg);
        resolve(null);
      }, 4000);
    });
  }

  function describe(el) {
    var tag = el.tagName.toLowerCase();
    var cls = stableClasses(el);
    return tag + (el.id ? '#' + el.id : '') + (cls.length ? '.' + cls.join('.') : '');
  }

  function resolve(note) {
    var el = null;
    try { el = document.querySelector(note.selector); } catch (e) { el = null; }
    if (el) return el;
    if (note.fallbackSelector) {
      try { el = document.querySelector(note.fallbackSelector); } catch (e) { el = null; }
      if (el) return el;
    }
    if (note.textSnippet && note.tag) {
      var all = document.getElementsByTagName(note.tag);
      for (var i = 0; i < all.length; i++) {
        if (snippet(all[i]) === note.textSnippet) return all[i];
      }
    }
    return null;
  }

  /* ---------- account sync ----------
     The annotator runs on someone else's origin, so it carries a per account
     annotator token rather than a Supabase session. The token arrives in the
     personal bookmarklet and is kept on this origin so later runs stay signed in. */

  var SRC = CONSOLE_URL.replace(/\/$/, '') + '/assets/annotator.js';
  var FROM_EXTENSION = false;

  var TOKEN = (function () {
    var fromScript = null;
    try {
      var cur = document.currentScript || document.querySelector('script[data-why-token]');
      if (cur) {
        fromScript = cur.getAttribute('data-why-token');
        if (cur.getAttribute('data-why-source') === 'extension') FROM_EXTENSION = true;
        // an extension URL cannot be reloaded into a plain window, so keep the hosted one
        if (cur.src && cur.src.indexOf('chrome-extension:') !== 0) SRC = cur.src.split('?')[0];
      }
    } catch (e) { }
    if (fromScript) {
      try { localStorage.setItem('why:token', fromScript); } catch (e) { }
      return fromScript;
    }
    try { return localStorage.getItem('why:token') || ''; } catch (e) { return ''; }
  })();

  var syncState = TOKEN ? 'syncing' : 'local';
  var lastError = '';
  var identity = { author: '', org_name: null, team_id: null, org_id: null };
  var directory = [];

  function syncRequest(action, extra) {
    var body = {
      token: TOKEN,
      action: action,
      origin: location.origin,
      path: location.pathname,
      url: location.href,
      title: document.title
    };
    if (extra) {
      if (extra.notes) extra.notes = extra.notes.map(function (n) {
        return {
          id: n.id, selector: n.selector, fallbackSelector: n.fallbackSelector, tag: n.tag,
          textSnippet: n.textSnippet, category: n.category, status: n.status, body: n.body,
          appliesTo: scopeOf(n), intent: n.intent || 'note', viewport: n.viewport, createdAt: n.createdAt,
          context: n.context || {}, shot: n._shot || null
        };
      });
      for (var k in extra) body[k] = extra[k];
    }

    // text/plain keeps this a simple request, so there is no CORS preflight to lose.
    // The function parses the body as JSON regardless of the content type it arrives with.
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 12000);

    return fetch(SYNC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      clearTimeout(timer);
      return r.text().then(function (text) {
        var parsed = null;
        try { parsed = JSON.parse(text); } catch (e) { }
        if (!r.ok) return { error: (parsed && parsed.error) || ('Server returned ' + r.status) };
        if (!parsed) return { error: 'Unreadable response from the sync endpoint.' };
        return parsed;
      });
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  function reason(err) {
    if (!err) return 'Sync failed for an unknown reason.';
    if (err.name === 'AbortError') return 'Timed out after 12 seconds with no response.';
    return (err.name || 'Error') + ': ' + (err.message || 'could not reach the sync endpoint');
  }

  // Runs one round trip and reports exactly what came back, so a failure can be
  // read from the page instead of from the network tab.
  function diagnose() {
    if (!TOKEN) { toast('No annotator token on this page. Sign in and use your own bookmarklet.'); return; }
    var started = Date.now();
    toast('Testing the connection.');
    syncRequest('whoami').then(function (res) {
      var ms = Date.now() - started;
      if (res.error) toast('Reached the server in ' + ms + 'ms, and it said: ' + res.error);
      else toast('Connected in ' + ms + 'ms as ' + (res.email || 'your account') + '. Sync works from here.');
    }, function (err) {
      toast('Failed after ' + (Date.now() - started) + 'ms. ' + reason(err));
    });
  }

  // Notes the network has not accepted yet, so a retry knows what to send.
  function unsynced() {
    return doc.notes.filter(function (n) { return !n._synced; });
  }

  function absorb(res) {
    if (!res) return;
    if (res.author) identity.author = res.author;
    identity.org_name = res.org_name || null;
    identity.org_id = res.org_id || null;
    identity.team_id = res.team_id || null;
    if (Array.isArray(res.directory)) directory = res.directory;
  }

  function fromRow(r) {
    return {
      appliesTo: Array.isArray(r.applies_to) ? r.applies_to : ['all'],
      intent: r.intent || 'note',
      context: r.context || {},
      shotUrl: r.shot_url || null,
      author: r.author || '',
      team: r.team_name || null,
      mine: r.mine !== false,
      id: r.client_id,
      selector: r.selector,
      fallbackSelector: r.fallback_selector || '',
      tag: r.tag || '',
      textSnippet: r.text_snippet || '',
      category: r.category,
      status: r.status,
      body: r.body,
      author: r.author || '',
      viewport: r.viewport || {},
      createdAt: r.created_at,
      _synced: true
    };
  }

  var watchTimer = null;
  function watchdog() {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(function () {
      if (syncState !== 'syncing') return;
      lastError = 'The request was never answered and never refused, which usually means something in the browser is holding it. An extension blocking supabase.co is the common cause.';
      setSync('offline', 'Still not saved to your account after 15 seconds.');
    }, 15000);
  }

  function setSync(state, msg) {
    if (state !== 'syncing') clearTimeout(watchTimer);
    syncState = state;
    buildBar();
    buildPanel();   // the failure band lives in the panel, so redraw it too
    if (msg) toast(msg);
  }

  function pullNotes() {
    if (!TOKEN) return;
    setSync('syncing');
    watchdog();
    var call;
    try { call = syncRequest('pull'); }
    catch (e) { lastError = reason(e); setSync('offline', 'Sync could not start. ' + lastError); return; }
    call.then(function (res) {
      if (res.error) { setSync('error', res.error); return; }
      absorb(res);
      var cloud = (res.notes || []).map(fromRow);
      var byId = {};
      cloud.forEach(function (n) { byId[n.id] = n; });
      var localOnly = doc.notes.filter(function (n) { return !byId[n.id]; });
      cloud.forEach(function (n) { n._synced = true; });
      doc.notes = cloud.concat(localOnly);
      Store.write(doc);
      setSync('cloud');
      render();
      if (localOnly.length) push(localOnly);
    }, function (err) { lastError = reason(err); setSync('offline', 'Could not reach your account. ' + lastError); });
  }

  function push(notes) {
    if (!TOKEN || !notes.length) return;
    setSync('syncing');
    watchdog();
    var call;
    try { call = syncRequest('push', { notes: notes }); }
    catch (e) { lastError = reason(e); setSync('offline', 'Sync could not start. ' + lastError); return; }
    call.then(function (res) {
      if (res.error) { setSync('error', res.error); return; }
      absorb(res);
      (res.notes || []).forEach(function (row) {
        doc.notes.forEach(function (n) {
          if (n.id === row.client_id) { n.author = row.author; n.team = row.team_name; n.mine = true; }
        });
      });
      lastError = '';
      notes.forEach(function (n) { n._synced = true; });

      // A change request is queued by the database; this is what sets it going.
      if (notes.some(function (n) { return n.intent === 'change'; })) {
        fetch(SYNC_URL.replace('why-sync', 'why-sync-kick'), {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          body: JSON.stringify({ token: TOKEN })
        }).catch(function () { });
      }
      Store.write(doc);
      setSync('cloud');
    }, function (err) { lastError = reason(err); setSync('offline', 'Note saved here but not to your account. ' + lastError); });
  }

  function removeRemote(note) {
    if (!TOKEN) return;
    syncRequest('delete', { client_id: note.id }).then(function () { setSync('cloud'); },
      function () { setSync('offline'); });
  }

  /* ---------- store ---------- */

  var Store = {
    read: function () {
      var raw = null;
      try { raw = localStorage.getItem(pageKey()); } catch (e) { }
      var doc = null;
      try { doc = raw ? JSON.parse(raw) : null; } catch (e) { doc = null; }
      if (!doc || !doc.notes) {
        doc = {
          schema: 'why/1',
          url: location.href,
          origin: location.origin,
          path: location.pathname,
          title: document.title,
          updatedAt: new Date().toISOString(),
          notes: []
        };
      }
      return doc;
    },
    write: function (doc) {
      doc.notes.forEach(function (n) { delete n._shot; });
      doc.updatedAt = new Date().toISOString();
      doc.title = document.title;
      doc.url = location.href;
      try { localStorage.setItem(pageKey(), JSON.stringify(doc)); } catch (e) {
        toast('Storage is full or blocked. Export your notes now.');
      }
      return doc;
    }
  };

  /* ---------- shadow UI ---------- */

  var host = document.createElement('div');
  host.setAttribute('data-why-host', '');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  (document.body || document.documentElement).appendChild(host);
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  var CSS_TEXT = `
  :host, * { box-sizing: border-box; }
  .layer { position: fixed; inset: 0; pointer-events: none; font-family: ui-sans-serif, "Instrument Sans", -apple-system, "Segoe UI", Roboto, sans-serif; }
  .hl { position: fixed; border: 2px solid #7c3aed; background: rgba(124,58,237,.12); border-radius: 2px; pointer-events: none; transition: none; }
  .hl-tag { position: fixed; background: #4c1d95; color: #fff; font-size: 11px; line-height: 1; padding: 5px 7px; border-radius: 3px; white-space: nowrap; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; pointer-events: none; }
  .pin { position: fixed; pointer-events: auto; width: 24px; height: 24px; border-radius: 50% 50% 50% 3px; color: #fff; font-size: 12px; font-weight: 600; display: grid; place-items: center; cursor: pointer; border: 2px solid #fff; box-shadow: 0 2px 6px rgba(15,23,42,.35); }
  .pin.dim { opacity: .35; }
  .pin.orphan { background: #64748b !important; }

  .bar {
    position: fixed; left: 50%; transform: translateX(-50%); bottom: 18px;
    pointer-events: auto; display: flex; align-items: center; gap: 4px;
    height: 44px; padding: 0 8px; background: #1e1b31; border-radius: 12px;
    box-shadow: 0 10px 30px rgba(15,23,42,.4); white-space: nowrap;
  }
  .bar .mark { font-size: 12px; color: #a78bfa; padding: 0 8px; cursor: pointer; letter-spacing: .01em; }
  .bar .sep { width: 1px; height: 18px; background: #3d3760; margin: 0 2px; }
  .bar button {
    font: inherit; border: 0; cursor: pointer; background: #2e2a48; color: #ede9fe;
    height: 30px; border-radius: 8px; display: inline-flex; align-items: center;
    justify-content: center; gap: 6px; padding: 0 10px; font-size: 12.5px; line-height: 1;
  }
  .bar button:hover { background: #3d3760; }
  .bar .b-primary { min-width: 92px; }
  .bar .b-primary.on { background: #7c3aed; color: #fff; }
  .bar .b-icon { min-width: 34px; padding: 0 9px; }
  .bar .b-icon.on { background: #3d3760; }
  .bar .b-icon .num { font-variant-numeric: tabular-nums; min-width: 8px; text-align: center; }
  .bar .ico { display: inline-flex; }
  .bar .b-dot { min-width: 30px; background: transparent; }
  .bar .b-dot:hover { background: #2e2a48; }
  .bar .b-dot .dot { width: 8px; height: 8px; border-radius: 50%; background: #64748b; }
  .bar .b-dot.ok .dot { background: #34d399; }
  .bar .b-dot.busy .dot { background: #c4b5fd; }
  .bar .b-dot.bad .dot { background: #fb7185; }
  .bar .b-dot.idle .dot { background: #8b83b8; }

  .menu {
    position: absolute; bottom: 52px; right: 4px; min-width: 190px; background: #26223f;
    border: 1px solid #3d3760; border-radius: 10px; padding: 5px; overflow: hidden;
  }
  .menu-item {
    display: block; width: 100%; text-align: left; font-size: 12.5px; color: #ede9fe;
    background: transparent; border: 0; border-radius: 7px; padding: 8px 10px; cursor: pointer;
  }
  .menu-item:hover { background: #3d3760; }
  .menu-note { color: #8b83b8; font-size: 11.5px; cursor: default; }
  .menu-note:hover { background: transparent; }

  .pop {
    position: fixed; width: 320px; background: #fff; color: #1c1a2e; pointer-events: auto;
    border: 1px solid #ddd7ce; border-radius: 12px; box-shadow: 0 12px 34px rgba(15,23,42,.22);
    padding: 12px 13px 11px;
  }
  .pop.sheet { width: auto; border-radius: 14px 14px 0 0; border-bottom: 0; }
  .pop-head { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; }
  .pop-tag { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: #6b6480; }
  .pop-head code {
    font-family: ui-monospace, Menlo, monospace; font-size: 10.5px; color: #4a4560;
    background: #f3f0eb; padding: 2px 6px; border-radius: 4px;
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .pop-x { border: 0; background: transparent; color: #6b6480; cursor: pointer; padding: 2px; display: flex; }
  .pop textarea {
    width: 100%; min-height: 86px; font: inherit; font-size: 14px; line-height: 1.5;
    padding: 9px 10px; border: 1px solid #ddd7ce; border-radius: 8px; resize: vertical; color: #1c1a2e;
  }
  .pop-row { display: flex; gap: 7px; margin-top: 8px; }
  .pop-row select {
    flex: 1; min-width: 0; font: inherit; font-size: 12.5px; height: 30px; padding: 0 8px;
    border: 1px solid #ddd7ce; border-radius: 7px; background: #fff; color: #1c1a2e;
  }
  .pop-actions { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
  .pop-by-inline { font-size: 11.5px; color: #6b6480; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pop-del { border: 1px solid #ddd7ce; background: #fff; color: #be123c; border-radius: 7px; height: 30px; width: 32px; display: grid; place-items: center; cursor: pointer; }
  .pop-save { border: 0; background: #5b21b6; color: #fff; font: inherit; font-size: 13px; font-weight: 600; height: 30px; padding: 0 14px; border-radius: 7px; cursor: pointer; min-width: 86px; }
  .pop-save:hover { background: #4c1d95; }
  .pop-read { font-size: 14px; line-height: 1.55; white-space: pre-wrap; }
  .pop-shot { display: block; margin-bottom: 9px; }
  .pop-shot img { display: block; width: 100%; border: 1px solid #e6e1da; border-radius: 8px; }
  .card-shot { display: block; width: 100%; border: 1px solid #e6e1da; border-radius: 6px; margin: 6px 0; }
  .pop-ctx { font-size: 11.5px; color: #6b6480; margin-top: 7px; }
  .pop-by { font-size: 11.5px; color: #6b6480; margin-top: 9px; }
  .pop .mentions { position: static; margin-top: 6px; box-shadow: none; }
  .pop-mode { display: flex; gap: 5px; margin-bottom: 9px; }
  .mode-b { flex: 1; font: inherit; font-size: 12px; border: 1px solid #ddd7ce; background: #fff; color: #4a4560; border-radius: 8px; padding: 7px 8px; cursor: pointer; }
  .mode-b.on { background: #1c1a2e; border-color: #1c1a2e; color: #fff; }
  .pop-hint { font-size: 11.5px; line-height: 1.45; color: #6b6480; background: #f6f3ee; border-radius: 7px; padding: 8px 9px; margin-top: 8px; }
  .card .ask { font-size: 9.5px; letter-spacing: .03em; text-transform: uppercase; background: #1c1a2e; color: #fff; border-radius: 999px; padding: 2px 7px; }
  .pop-label { font-size: 9.5px; letter-spacing: .06em; text-transform: uppercase; color: #6b6480; margin: 11px 0 6px; }
  .pop-chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .chip-w { font: inherit; font-size: 11px; border: 1px solid #ddd7ce; background: #fff; color: #4a4560; border-radius: 999px; padding: 4px 10px; cursor: pointer; }
  .chip-w:hover { border-color: #b9b0d8; }
  .chip-w.on { background: #5b21b6; border-color: #5b21b6; color: #fff; }

  .seg { display: inline-flex; height: 30px; border-radius: 8px; overflow: hidden; }
  .bar .seg-b { height: 30px; border-radius: 0; background: #2e2a48; font-size: 11.5px; padding: 0 10px; }
  .bar .seg-b.on { background: #7c3aed; color: #fff; }

  .pin.ghost { border: 2px dashed #b9b2d6; box-shadow: none; }

  .scope-badge { display: inline-block; margin-top: 7px; font-size: 9.5px; background: #f3f0eb; color: #4a4560; border-radius: 999px; padding: 2px 8px; }
  .scope-badge.out { background: #ede9fe; color: #4c1d95; }

  .tray {
    position: fixed; left: 50%; transform: translateX(-50%); bottom: 74px; width: 420px; max-width: calc(100vw - 24px);
    background: #fff; border: 1px solid #ddd7ce; border-radius: 12px; box-shadow: 0 12px 34px rgba(15,23,42,.2);
    pointer-events: auto; overflow: hidden;
  }
  .tray-head { padding: 11px 13px 9px; border-bottom: 0.5px solid #e6e1da; }
  .tray-head b { display: block; font-size: 13px; color: #1c1a2e; }
  .tray-head span { display: block; font-size: 11.5px; color: #6b6480; margin-top: 2px; }
  .tray-row { display: flex; align-items: flex-start; gap: 9px; padding: 10px 13px; border-bottom: 0.5px solid #f0ece5; }
  .tray-row:last-child { border-bottom: 0; }
  .tray-pin { width: 18px; height: 18px; border-radius: 50% 50% 50% 3px; color: #fff; font-size: 10px; display: grid; place-items: center; flex: none; margin-top: 1px; }
  .tray-body { flex: 1; min-width: 0; display: block; }
  .tray-text { display: block; font-size: 12.5px; color: #1c1a2e; }
  .tray-meta { display: block; font-size: 10.5px; color: #6b6480; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tray-go { font: inherit; font-size: 11px; border: 1px solid #ddd7ce; background: #fff; color: #4a4560; border-radius: 7px; padding: 5px 10px; cursor: pointer; flex: none; }
  .tray-go:hover { background: #f6f3ee; }

  .panel { position: fixed; top: 0; right: 0; width: 380px; max-width: 100vw; height: 100%; background: #fbfaf8; color: #1c1a2e; pointer-events: auto; display: flex; flex-direction: column; box-shadow: -12px 0 40px rgba(15,23,42,.18); }
  .panel header { padding: 14px 16px; border-bottom: 1px solid #e6e1da; display: flex; align-items: center; gap: 8px; }
  .panel header h2 { margin: 0; font-size: 15px; font-weight: 650; flex: 1; }
  .icon { border: 0; background: transparent; font-size: 16px; cursor: pointer; color: #6b6480; padding: 4px 6px; border-radius: 6px; }
  .icon:hover { background: #efece7; }
  .warn { background: #fff1f2; border-bottom: 1px solid #fecdd3; color: #9f1239; font-size: 12.5px; line-height: 1.5; padding: 10px 16px; }
  .filters { display: flex; gap: 6px; padding: 10px 16px; border-bottom: 1px solid #e6e1da; flex-wrap: wrap; }
  .chip { font-size: 12px; border: 1px solid #ddd7ce; background: #fff; border-radius: 999px; padding: 4px 9px; cursor: pointer; color: #4a4560; }
  .chip.on { background: #1c1a2e; color: #fff; border-color: #1c1a2e; }
  .list { flex: 1; overflow: auto; padding: 8px 12px 90px; }
  .empty { padding: 28px 16px; color: #6b6480; font-size: 14px; line-height: 1.55; }
  .card { border: 1px solid #e6e1da; border-left: 4px solid #7c3aed; background: #fff; border-radius: 8px; padding: 10px 12px; margin: 8px 0; cursor: pointer; }
  .card:hover { border-color: #c9c1b6; }
  .card .top { display: flex; gap: 8px; align-items: baseline; font-size: 11px; color: #6b6480; }
  .card .num { font-weight: 700; color: #1c1a2e; }
  .mentions { position: absolute; left: 16px; right: 16px; bottom: 100%; background: #fff; border: 1px solid #ddd7ce; border-radius: 8px; box-shadow: 0 -6px 20px rgba(15,23,42,.12); overflow: hidden; margin-bottom: 6px; }
  .mention { padding: 8px 11px; font-size: 13px; cursor: pointer; display: flex; gap: 8px; align-items: center; }
  .mention.on, .mention:hover { background: #f3f0fb; }
  .mention-kind { font-size: 10px; letter-spacing: .05em; text-transform: uppercase; color: #8a83a8; }
  .tagged { color: #5b21b6; font-weight: 600; }
  .card .body { font-size: 14px; line-height: 1.5; margin: 6px 0 6px; white-space: pre-wrap; }
  .card code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; background: #f3f0eb; padding: 2px 5px; border-radius: 4px; word-break: break-all; color: #4a4560; display: inline-block; }
  .card .meta { font-size: 11px; color: #6b6480; }
  .card.gone { border-left-color: #94a3b8; }

  .toast { position: fixed; left: 50%; transform: translateX(-50%); bottom: 74px; background: #1c1a2e; color: #fff; font-size: 13px; padding: 9px 14px; border-radius: 8px; pointer-events: none; }

  @media (max-width: 640px) {
    .panel { width: 100%; }
    .pop { left: 0; right: 0; width: auto; }
    .panel { height: 78%; top: auto; bottom: 0; border-top-left-radius: 14px; border-top-right-radius: 14px; }
    .bar { bottom: 10px; max-width: calc(100vw - 20px); }
    .bar .b-primary { min-width: 78px; }
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
  `;

  var style = document.createElement('style');
  style.textContent = CSS_TEXT;
  root.appendChild(style);

  var layer = document.createElement('div');
  layer.className = 'layer';
  root.appendChild(layer);

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  var hl = el('div', 'hl'); hl.style.display = 'none';
  var hlTag = el('div', 'hl-tag'); hlTag.style.display = 'none';
  layer.appendChild(hl); layer.appendChild(hlTag);

  var toastNode = null;
  function toast(msg) {
    if (toastNode) toastNode.remove();
    toastNode = el('div', 'toast', esc(msg));
    layer.appendChild(toastNode);
    var hold = msg.length > 60 ? 9000 : 2600;
    setTimeout(function () { if (toastNode) { toastNode.remove(); toastNode = null; } }, hold);
  }

  /* ---------- state ---------- */

  var doc = Store.read();
  var picking = false;
  var panelOpen = true;
  var filter = 'all';
  var widthMode = 'this';   // 'this' scopes pins to the current breakpoint, 'all' shows every note
  var editing = null;      // note being composed or edited
  var editingEl = null;    // the element it is anchored to
  var pinNodes = [];

  function catOf(id) {
    for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].id === id) return CATEGORIES[i];
    return CATEGORIES[0];
  }

  /* ---------- picking ---------- */

  function pointFromEvent(e) {
    if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    return { x: e.clientX, y: e.clientY };
  }

  function targetAt(x, y) {
    var t = document.elementFromPoint(x, y);
    if (!t || t === document.documentElement || t.hasAttribute('data-why-host')) return null;
    return t;
  }

  function paintHighlight(target) {
    if (!target) { hl.style.display = 'none'; hlTag.style.display = 'none'; return; }
    var r = target.getBoundingClientRect();
    hl.style.display = 'block';
    hl.style.left = r.left + 'px';
    hl.style.top = r.top + 'px';
    hl.style.width = r.width + 'px';
    hl.style.height = r.height + 'px';
    hlTag.style.display = 'block';
    hlTag.textContent = describe(target) + '  ' + Math.round(r.width) + ' x ' + Math.round(r.height);
    var top = r.top > 26 ? r.top - 24 : r.bottom + 4;
    hlTag.style.left = Math.max(4, r.left) + 'px';
    hlTag.style.top = top + 'px';
  }

  var hovered = null;
  function onMove(e) {
    if (!picking) return;
    var p = pointFromEvent(e);
    var t = targetAt(p.x, p.y);
    if (t === hovered) return;
    hovered = t;
    paintHighlight(t);
  }

  function onPick(e) {
    if (!picking) return;
    var p = pointFromEvent(e);
    var t = targetAt(p.x, p.y);
    if (!t) return;
    e.preventDefault(); e.stopPropagation();
    setPicking(false);
    openComposer(t, null);
  }

  var pressTimer = null;
  function onTouchStart(e) {
    if (!picking) return;
    var p = pointFromEvent(e);
    pressTimer = setTimeout(function () { onPick(e); }, 380);
    onMove(e);
  }
  function clearPress() { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } }

  function setPicking(on) {
    picking = on;
    document.documentElement.style.cursor = on ? 'crosshair' : '';
    if (!on) { hovered = null; paintHighlight(null); }
    render();
  }

  /* ---------- pins ---------- */

  function layoutPins() {
    for (var i = 0; i < pinNodes.length; i++) {
      var p = pinNodes[i];
      var target = resolve(p.note);
      if (!target) { p.node.style.display = 'none'; continue; }
      var r = target.getBoundingClientRect();
      var visible = r.bottom > 0 && r.top < window.innerHeight && r.width + r.height > 0;
      p.node.style.display = visible ? 'grid' : 'none';
      p.node.style.left = Math.max(2, r.left - 10) + 'px';
      p.node.style.top = Math.max(2, r.top - 10) + 'px';
    }
  }

  var ticking = false;
  function scheduleLayout() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () { ticking = false; layoutPins(); positionPopover(); if (picking && hovered) paintHighlight(hovered); });
  }

  function renderPins() {
    for (var i = 0; i < pinNodes.length; i++) pinNodes[i].node.remove();
    pinNodes = [];
    var vp = viewportSnapshot();
    doc.notes.forEach(function (n, idx) {
      var here = inScope(n, vp.breakpoint);
      if (!here && widthMode === 'this' && !resolve(n)) return;   // it lives in the tray instead

      var node = el('div', 'pin');
      node.textContent = String(idx + 1);
      node.style.background = catOf(n.category).color;
      node.title = n.body.slice(0, 80) + '  (' + scopeLabel(n) + ')';
      if (filter !== 'all' && n.category !== filter) node.classList.add('dim');
      if (!here) { node.classList.add('ghost'); node.style.background = '#fff'; node.style.color = '#6b6480'; }
      node.addEventListener('click', function (e) { e.stopPropagation(); focusNote(n.id); });
      layer.appendChild(node);
      pinNodes.push({ note: n, node: node });
    });
    layoutPins();
  }

  // Notes whose element is not on the page at this width. They have nothing to
  // point at, so without somewhere to live they would simply disappear.
  function homeless() {
    return doc.notes.filter(function (n) { return !resolve(n); });
  }

  /* ---------- panel ---------- */

  var panel = null, composer = null, bar = null;

  function buildBar() {
    if (bar) bar.remove();
    bar = el('div', 'bar');

    var mark = el('span', 'mark', 'WhyTho');
    mark.title = 'WhyTho ' + VERSION + '. Click to test the connection to your account.';
    mark.addEventListener('click', diagnose);

    // One primary action. The label never changes, only the state, so the row
    // cannot reflow when it is pressed.
    var pick = el('button', 'b-primary' + (picking ? ' on' : ''));
    pick.innerHTML = '<span class="ico">' + (picking ? SVG.close : SVG.cursor) + '</span><span>Select</span>';
    pick.title = picking ? 'Cancel selection, or press Escape' : 'Select an element on the page';
    pick.addEventListener('click', function () { setPicking(!picking); });

    var count = doc.notes.length;
    var list = el('button', 'b-icon' + (panelOpen ? ' on' : ''));
    list.innerHTML = '<span class="ico">' + SVG.list + '</span><span class="num">' + count + '</span>';
    list.title = (panelOpen ? 'Hide' : 'Show') + ' all notes on this page';
    list.addEventListener('click', function () { panelOpen = !panelOpen; render(); });

    var seg = el('span', 'seg');
    var here = el('button', 'seg-b' + (widthMode === 'this' ? ' on' : ''), 'This width');
    here.title = 'Only show notes that apply at ' + viewportSnapshot().breakpoint + ' widths';
    here.addEventListener('click', function () { widthMode = 'this'; render(); });
    var every = el('button', 'seg-b' + (widthMode === 'all' ? ' on' : ''), 'All');
    every.title = 'Show every note on this page, whatever width it is about';
    every.addEventListener('click', function () { widthMode = 'all'; render(); });
    seg.appendChild(here); seg.appendChild(every);

    var narrow = window.innerWidth < 640;
    var device = el('button', 'b-icon');
    device.innerHTML = '<span class="ico">' + (narrow ? SVG.screen : SVG.phone) + '</span>';
    device.title = narrow
      ? 'Open this page in a window at 1280px'
      : 'Open this page in a real window at 390px, with WhyTho running';
    device.addEventListener('click', function () {
      var w = narrow ? WIDTHS[2] : WIDTHS[0];
      openAtWidth(w.px, w.h);
    });

    var lost = homeless().length;
    var tray = null;
    if (lost) {
      tray = el('button', 'b-icon' + (trayOpen ? ' on' : ''));
      tray.innerHTML = '<span class="ico">' + SVG.hidden + '</span><span class="num">' + lost + '</span>';
      tray.title = lost + (lost === 1 ? ' note has' : ' notes have') + ' no element at this width';
      tray.addEventListener('click', function () { trayOpen = !trayOpen; render(); });
    }

    var dotState = { cloud: 'ok', syncing: 'busy', offline: 'bad', error: 'bad', local: 'idle' }[syncState];
    var dotLabel = {
      cloud: 'Saved to your account',
      syncing: 'Saving',
      offline: 'Not saved to your account. Click to retry.',
      error: 'Sync problem. Click to retry.',
      local: 'This browser only. Sign in to save to your account.'
    }[syncState];
    var dot = el('button', 'b-dot ' + dotState);
    dot.innerHTML = '<span class="dot"></span>';
    dot.title = dotLabel;
    dot.addEventListener('click', function () {
      if (!TOKEN) { window.open(CONSOLE_URL, '_blank', 'noopener'); return; }
      var todo = unsynced();
      if (todo.length) push(todo); else diagnose();
    });

    var more = el('button', 'b-icon');
    more.innerHTML = '<span class="ico">' + SVG.more + '</span>';
    more.title = 'More';
    more.addEventListener('click', function (e) { e.stopPropagation(); toggleMenu(); });

    bar.appendChild(mark);
    bar.appendChild(el('span', 'sep'));
    bar.appendChild(pick);
    bar.appendChild(list);
    bar.appendChild(seg);
    bar.appendChild(device);
    if (tray) bar.appendChild(tray);
    bar.appendChild(dot);
    bar.appendChild(more);
    layer.appendChild(bar);
    if (menuOpen) buildMenu();
  }

  var menuOpen = false;
  var menuNode = null;
  var trayOpen = false;
  var trayNode = null;

  function toggleMenu() { menuOpen = !menuOpen; buildBar(); }

  function buildMenu() {
    if (menuNode) { menuNode.remove(); menuNode = null; }
    if (!menuOpen) return;
    var vp = viewportSnapshot();
    menuNode = el('div', 'menu');
    var items = [
      ['Open WhyTho', function () { window.open(CONSOLE_URL, '_blank', 'noopener'); }],
      ['Test connection', diagnose],
      ['WhyTho ' + VERSION + (FROM_EXTENSION ? ' \u00b7 extension' : ' \u00b7 bookmarklet'), null],
      [(identity.org_name || 'Personal') + ' \u00b7 ' + vp.breakpoint + ' ' + vp.width + 'px', null],
      ['Close WhyTho', function () { publicApi.off(); }]
    ];
    items.forEach(function (it) {
      var row = el(it[1] ? 'button' : 'div', 'menu-item' + (it[1] ? '' : ' menu-note'), esc(it[0]));
      if (it[1]) row.addEventListener('click', function () { menuOpen = false; it[1](); buildBar(); });
      menuNode.appendChild(row);
    });
    bar.appendChild(menuNode);
  }

  function buildTray() {
    if (trayNode) { trayNode.remove(); trayNode = null; }
    var lost = homeless();
    if (!trayOpen || !lost.length) return;

    trayNode = el('div', 'tray');
    var head = el('div', 'tray-head');
    head.innerHTML = '<b>' + lost.length + (lost.length === 1 ? ' note has' : ' notes have') +
      ' no element at this width</b><span>They were written somewhere this page does not render right now.</span>';
    trayNode.appendChild(head);

    lost.forEach(function (n) {
      var row = el('div', 'tray-row');
      var w = n.viewport && n.viewport.width ? n.viewport.width : null;
      row.innerHTML =
        '<span class="tray-pin" style="background:' + catOf(n.category).color + '">' +
        (doc.notes.indexOf(n) + 1) + '</span>' +
        '<span class="tray-body"><span class="tray-text">' + esc(n.body.slice(0, 90)) + '</span>' +
        '<span class="tray-meta">' + esc(scopeLabel(n)) +
        (w ? ' \u00b7 seen at ' + w + 'px' : '') + ' \u00b7 ' + esc(n.selector.slice(0, 46)) + '</span></span>';
      if (w && Math.abs(w - window.innerWidth) > 80) {
        var go = el('button', 'tray-go', 'Show me');
        go.title = 'Open this page in a window at ' + w + 'px';
        go.addEventListener('click', function () { openAtWidth(w, (n.viewport && n.viewport.height) || 844); });
        row.appendChild(go);
      }
      trayNode.appendChild(row);
    });
    layer.appendChild(trayNode);
  }

  function buildPanel() {
    if (panel) { panel.remove(); panel = null; }
    if (!panelOpen) return;
    panel = el('div', 'panel');

    var h = document.createElement('header');
    h.appendChild(el('h2', '', 'Notes on this page'));
    var close = el('button', 'icon'); close.textContent = '\u2715'; close.title = 'Hide panel';
    close.addEventListener('click', function () { panelOpen = false; render(); });
    h.appendChild(close);
    panel.appendChild(h);

    if (lastError) {
      var warn = el('div', 'warn');
      warn.innerHTML = '<b>Not saved to your account.</b> ' + esc(lastError) +
        ' Use <b>Send to console</b> to move these notes across instead.';
      panel.appendChild(warn);
    }

    var filters = el('div', 'filters');
    var all = el('button', 'chip' + (filter === 'all' ? ' on' : ''), 'All ' + doc.notes.length);
    all.addEventListener('click', function () { filter = 'all'; render(); });
    filters.appendChild(all);
    CATEGORIES.forEach(function (c) {
      var count = doc.notes.filter(function (n) { return n.category === c.id; }).length;
      if (!count) return;
      var b = el('button', 'chip' + (filter === c.id ? ' on' : ''), c.label + ' ' + count);
      b.addEventListener('click', function () { filter = c.id; render(); });
      filters.appendChild(b);
    });
    panel.appendChild(filters);

    var list = el('div', 'list');
    var shown = doc.notes.filter(function (n) { return filter === 'all' || n.category === filter; });
    if (!shown.length) {
      list.appendChild(el('div', 'empty',
        'No notes here yet. Hit <b>Select an element</b>, click anything on the page, and write down why it is the way it is. On a phone, press and hold the element instead.'));
    }
    shown.forEach(function (n) {
      var idx = doc.notes.indexOf(n) + 1;
      var alive = !!resolve(n);
      var card = el('div', 'card' + (alive ? '' : ' gone'));
      card.style.borderLeftColor = catOf(n.category).color;
      var vpTxt = n.viewport ? n.viewport.breakpoint + ' ' + n.viewport.width + 'px' : '';
      card.innerHTML =
        '<div class="top"><span class="num">' + idx + '</span>' +
        (n.intent === 'change' ? '<span class="ask">change requested</span>' : '') +
        '<span>' + esc(catOf(n.category).label) + '</span>' +
        '<span>' + esc(n.status) + '</span><span style="margin-left:auto">' + esc(vpTxt) + '</span></div>' +
        '<div class="body">' + withMentions(n.body) + '</div>' +
        (n.shotUrl ? '<img class="card-shot" src="' + esc(n.shotUrl) + '" alt="">' : '') +
        '<code>' + esc(n.selector) + '</code>' +
        '<div class="scope-badge' + (inScope(n, viewportSnapshot().breakpoint) ? '' : ' out') + '">' + esc(scopeLabel(n)) + '</div>' +
        '<div class="top" style="margin-top:8px">' +
        '<span><b>' + esc(n.author || 'you') + '</b>' + (n.team ? ' &middot; ' + esc(n.team) : '') + '</span>' +
        '<span>' + esc(new Date(n.createdAt).toLocaleDateString()) + '</span>' +
        (alive ? '' : '<span style="margin-left:auto;color:#64748b">element not found</span>') +
        '</div>';
      card.addEventListener('click', function () { focusNote(n.id); });
      list.appendChild(card);
    });
    panel.appendChild(list);
    layer.appendChild(panel);
  }

  function focusNote(id) {
    var n = null;
    for (var i = 0; i < doc.notes.length; i++) if (doc.notes[i].id === id) n = doc.notes[i];
    if (!n) return;
    var target = resolve(n);
    if (!target) { toast('That element is no longer on the page.'); return; }
    var r = target.getBoundingClientRect();
    if (r.top < 60 || r.bottom > window.innerHeight - 60) {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    setTimeout(function () { paintHighlight(target); }, 300);
    setTimeout(function () { if (!picking) paintHighlight(null); }, 2400);
    openComposer(target, n);
  }

  function openComposer(target, existing) {
    editingEl = target || null;
    editing = existing || {
      id: uid(),
      selector: buildSelector(target),
      fallbackSelector: '',
      tag: target.tagName.toLowerCase(),
      textSnippet: snippet(target),
      context: captureContext(target),
      category: 'seo',
      status: 'decided',
      appliesTo: ['all'],
      intent: 'note',
      body: '',
      author: identity.author || '',
      mine: true,
      viewport: viewportSnapshot(),
      createdAt: new Date().toISOString()
    };
    if (!existing) {
      editing.fallbackSelector = editing.selector;
    }
    renderComposer();
  }

  function positionPopover() {
    if (!composer || !editingEl) return;
    var r = editingEl.getBoundingClientRect();
    var w = composer.offsetWidth || 320;
    var h = composer.offsetHeight || 220;
    var narrow = window.innerWidth < 640;

    if (narrow) {                       // a phone gets a sheet, not a floating card
      composer.classList.add('sheet');
      composer.style.left = '0px';
      composer.style.right = '0px';
      composer.style.top = 'auto';
      composer.style.bottom = '0px';
      return;
    }
    composer.classList.remove('sheet');
    composer.style.right = 'auto';
    composer.style.bottom = 'auto';

    var left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    var below = r.bottom + 10;
    var top = (below + h < window.innerHeight - 8) ? below : Math.max(8, r.top - h - 10);
    composer.style.left = left + 'px';
    composer.style.top = top + 'px';
  }

  function renderComposer() {
    if (composer && editing && composer.dataset.noteId === editing.id) { positionPopover(); return; }
    if (composer) { composer.remove(); composer = null; }
    if (!editing) return;
    var n = editing;
    var readOnly = n.mine === false;

    composer = el('div', 'pop');
    composer.dataset.noteId = n.id;

    var head = el('div', 'pop-head');
    head.innerHTML = '<span class="pop-tag">' + esc(n.tag) + '</span><code>' + esc(n.selector) + '</code>';
    var x = el('button', 'pop-x');
    x.innerHTML = SVG.close;
    x.title = 'Close';
    x.addEventListener('click', function () { editing = null; editingEl = null; render(); });
    head.appendChild(x);
    composer.appendChild(head);

    if (n.shotUrl) {
      var shot = document.createElement('a');
      shot.className = 'pop-shot';
      shot.href = n.shotUrl;
      shot.target = '_blank';
      shot.rel = 'noopener';
      shot.title = 'The element when this note was written. Opens full size.';
      shot.innerHTML = '<img src="' + esc(n.shotUrl) + '" alt="The element when the note was written">';
      composer.appendChild(shot);
    }

    if (readOnly) {
      composer.appendChild(el('div', 'pop-read', esc(n.body)));
      if (n.context && n.context.heading) {
        composer.appendChild(el('div', 'pop-ctx', 'Under: ' + esc(n.context.heading)));
      }
      composer.appendChild(el('div', 'pop-by',
        '<b>' + esc(n.author || 'Unknown') + '</b>' + (n.team ? ' \u00b7 ' + esc(n.team) : '') +
        ' \u00b7 ' + esc(catOf(n.category).label) + ' \u00b7 ' + esc(n.status) +
        ' \u00b7 ' + esc(scopeLabel(n))));
      layer.appendChild(composer);
      positionPopover();
      return;
    }

    var intent = n.intent || 'note';

    // Mode first, because it changes what the box is asking you for.
    var modes = el('div', 'pop-mode');
    [['note', 'Record why', 'Write down the reasoning. Nothing is changed.'],
     ['change', 'Ask for a change', 'Claude makes the change and commits it. You can undo it from the app.']
    ].forEach(function (m) {
      var b = el('button', 'mode-b' + (intent === m[0] ? ' on' : ''), esc(m[1]));
      b.title = m[2];
      b.addEventListener('click', function () {
        intent = m[0];
        modes.querySelectorAll('.mode-b').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        ta.placeholder = placeholderFor();
        hint.textContent = intent === 'change'
          ? 'Treated as approved. Claude edits the file in the repository mapped to this site and commits it, so it goes live. Undo is one click in Changes.'
          : '';
        hint.style.display = intent === 'change' ? 'block' : 'none';
        saveBtn.textContent = intent === 'change' ? 'Request change' : (doc.notes.indexOf(n) > -1 ? 'Save' : 'Add note');
      });
      modes.appendChild(b);
    });
    composer.appendChild(modes);

    function placeholderFor() {
      if (intent === 'change') return 'What should change about this element? Say it the way you would to a developer.';
      return directory.length
        ? 'Why is this element the way it is? Type @ to tag a person or a team.'
        : 'Why is this element the way it is?';
    }

    var ta = document.createElement('textarea');
    ta.placeholder = placeholderFor();
    ta.value = n.body;
    composer.appendChild(ta);

    var picker = el('div', 'mentions');
    picker.style.display = 'none';
    composer.appendChild(picker);

    var pickIndex = 0, matches = [];

    function tokenAtCaret() {
      var upto = ta.value.slice(0, ta.selectionStart);
      var at = upto.lastIndexOf('@');
      if (at === -1) return null;
      var frag = upto.slice(at + 1);
      if (/\n/.test(frag) || frag.length > 40) return null;
      return { at: at, frag: frag };
    }
    function closePicker() { picker.style.display = 'none'; matches = []; }
    function refreshPicker() {
      var tok = tokenAtCaret();
      if (!tok || !directory.length) return closePicker();
      var q = tok.frag.toLowerCase();
      matches = directory.filter(function (d) {
        return q === '' || d.label.toLowerCase().indexOf(q) === 0 || d.label.toLowerCase().indexOf(' ' + q) > -1;
      }).slice(0, 5);
      if (!matches.length) return closePicker();
      pickIndex = 0; paintPicker(); picker.style.display = 'block';
    }
    function paintPicker() {
      picker.innerHTML = '';
      matches.forEach(function (m, i) {
        var row = el('div', 'mention' + (i === pickIndex ? ' on' : ''));
        row.innerHTML = '<span class="mention-kind">' + (m.type === 'team' ? 'team' : 'person') + '</span>' + esc(m.label);
        row.addEventListener('mousedown', function (e) { e.preventDefault(); choose(m); });
        picker.appendChild(row);
      });
    }
    function choose(m) {
      var tok = tokenAtCaret();
      if (!tok) return closePicker();
      var before = ta.value.slice(0, tok.at), after = ta.value.slice(ta.selectionStart);
      ta.value = before + '@' + m.label + ' ' + after;
      var pos = (before + '@' + m.label + ' ').length;
      ta.setSelectionRange(pos, pos); ta.focus(); closePicker();
    }
    ta.addEventListener('input', refreshPicker);
    ta.addEventListener('keydown', function (e) {
      if (picker.style.display !== 'none' && matches.length) {
        if (e.key === 'ArrowDown') { e.preventDefault(); pickIndex = (pickIndex + 1) % matches.length; paintPicker(); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); pickIndex = (pickIndex - 1 + matches.length) % matches.length; paintPicker(); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(matches[pickIndex]); return; }
        if (e.key === 'Escape') { e.preventDefault(); closePicker(); return; }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); }
    });
    ta.addEventListener('blur', closePicker);

    var scope = scopeOf(n).slice();
    composer.appendChild(el('div', 'pop-label', 'Applies to'));
    var chips = el('div', 'pop-chips');

    function paintChips() {
      chips.innerHTML = '';
      var opts = [{ id: 'all', label: 'All widths' }].concat(WIDTHS);
      opts.forEach(function (o) {
        var on = scope.indexOf(o.id) > -1;
        var b = el('button', 'chip-w' + (on ? ' on' : ''), esc(o.label));
        b.addEventListener('click', function () {
          if (o.id === 'all') { scope = ['all']; }
          else {
            scope = scope.filter(function (x) { return x !== 'all'; });
            var at = scope.indexOf(o.id);
            if (at > -1) scope.splice(at, 1); else scope.push(o.id);
            if (!scope.length) scope = ['all'];
          }
          paintChips();
        });
        chips.appendChild(b);
      });
    }
    paintChips();
    composer.appendChild(chips);

    var hint = el('div', 'pop-hint');
    hint.style.display = intent === 'change' ? 'block' : 'none';
    hint.textContent = intent === 'change'
      ? 'Treated as approved. Claude edits the file in the repository mapped to this site and commits it, so it goes live. Undo is one click in Changes.'
      : '';
    composer.appendChild(hint);

    var row = el('div', 'pop-row');
    var cat = document.createElement('select');
    CATEGORIES.forEach(function (c) {
      var o = document.createElement('option'); o.value = c.id; o.textContent = c.label;
      if (c.id === n.category) o.selected = true; cat.appendChild(o);
    });
    var st = document.createElement('select');
    STATUSES.forEach(function (v) {
      var o = document.createElement('option'); o.value = v; o.textContent = v;
      if (v === n.status) o.selected = true; st.appendChild(o);
    });
    row.appendChild(cat); row.appendChild(st);
    composer.appendChild(row);

    var actions = el('div', 'pop-actions');
    var by = el('span', 'pop-by-inline', identity.author
      ? esc(identity.author)
      : (TOKEN ? 'your account' : 'this browser only'));
    actions.appendChild(by);

    if (doc.notes.indexOf(n) > -1) {
      var del = el('button', 'pop-del');
      del.innerHTML = SVG.trash;
      del.title = 'Delete this note';
      del.addEventListener('click', function () {
        doc.notes = doc.notes.filter(function (xx) { return xx.id !== n.id; });
        Store.write(doc); removeRemote(n); editing = null; editingEl = null; render(); toast('Note deleted.');
      });
      actions.appendChild(del);
    }

    var saveBtn = el('button', 'pop-save', intent === 'change' ? 'Request change' : (doc.notes.indexOf(n) > -1 ? 'Save' : 'Add note'));
    saveBtn.addEventListener('click', save);
    actions.appendChild(saveBtn);
    composer.appendChild(actions);

    function save() {
      if (!ta.value.trim()) { ta.focus(); toast('Write the reasoning first.'); return; }
      n.body = ta.value.trim();
      n.category = cat.value;
      n.status = st.value;
      n.author = identity.author || '';
      n.appliesTo = scope;
      n.intent = intent;
      var shotOf = editingEl;
      if (doc.notes.indexOf(n) === -1) doc.notes.push(n);
      Store.write(doc);
      editing = null; editingEl = null;
      render();
      toast(intent === 'change'
        ? 'Change requested. Claude is making it now.'
        : (TOKEN ? 'Note saved. Sending it to your account.' : 'Note saved in this browser.'));

      // The picture is taken with the element still highlighted, then sent with the note.
      if (shotOf) paintHighlight(shotOf);
      requestShot(shotOf).then(function (dataUrl) {
        if (!picking) paintHighlight(null);
        if (dataUrl) n._shot = dataUrl;
        push([n]);
        delete n._shot;
      });
    }

    layer.appendChild(composer);
    positionPopover();
    setTimeout(function () { ta.focus(); }, 30);
  }

  function render() {
    buildBar();
    buildTray();
    buildPanel();
    renderComposer();
    renderPins();
  }

  /* ---------- export ---------- */

  function payload() {
    return {
      schema: 'why/1',
      exportedAt: new Date().toISOString(),
      pages: [doc]
    };
  }

  function b64(str) {
    return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function copyJSON() {
    var text = JSON.stringify(payload(), null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('JSON copied to clipboard.'); },
        function () { fallbackCopy(text); });
    } else fallbackCopy(text);
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('JSON copied to clipboard.'); }
    catch (e) { toast('Copy failed. Open the console and import a file instead.'); }
    ta.remove();
  }

  function sendToConsole() {
    if (!doc.notes.length) { toast('Nothing to send yet.'); return; }
    var enc = b64(JSON.stringify(payload()));
    if (enc.length < 60000) {
      window.open(CONSOLE_URL + '#import=' + enc, '_blank', 'noopener');
      return;
    }
    var blob = new Blob([JSON.stringify(payload(), null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'why-' + location.hostname + '.json';
    a.click();
    toast('Too large for a link, so it downloaded. Import the file in the console.');
  }

  /* ---------- wiring ---------- */

  document.addEventListener('mousedown', function () { if (menuOpen) { menuOpen = false; buildBar(); } }, true);
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onPick, true);
  document.addEventListener('touchstart', onTouchStart, { capture: true, passive: false });
  document.addEventListener('touchend', clearPress, true);
  document.addEventListener('touchmove', clearPress, true);
  window.addEventListener('scroll', scheduleLayout, true);
  window.addEventListener('resize', function () { scheduleLayout(); buildBar(); }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { if (picking) setPicking(false); else if (menuOpen) { menuOpen = false; buildBar(); } else if (editing) { editing = null; editingEl = null; render(); } }
  }, true);

  var publicApi = {
    on: function () { host.style.display = ''; render(); },
    off: function () {
      host.style.display = 'none';
      setPicking(false);
      toast('');
    },
    toggle: function () { host.style.display === 'none' ? publicApi.on() : publicApi.off(); },
    export: payload,
    version: VERSION,
    diagnose: diagnose
  };
  window.__why__ = publicApi;

  render();
  if (TOKEN) pullNotes();
  if (!doc.notes.length) toast('WhyTho is on. Select an element to leave your first note.');
})();
