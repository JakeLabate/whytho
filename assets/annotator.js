/* WhyTho annotator engine
   Loads into any page via bookmarklet or script tag. Self contained, no dependencies.
   All UI lives in a shadow root so host page CSS cannot reach it and it cannot leak out.
   Storage is localStorage on the annotated origin. Export moves notes to the console. */
(function () {
  'use strict';

  if (window.__why__) { window.__why__.toggle(); return; }

  var CONSOLE_URL = 'https://whytho.jakelabate.com/';
  var SYNC_URL = 'https://vvekkbboqqkxnlpmxazh.supabase.co/functions/v1/why-sync';
  var VERSION = '2.2';
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

  var TOKEN = (function () {
    var fromScript = null;
    try {
      var cur = document.currentScript || document.querySelector('script[data-why-token]');
      if (cur) fromScript = cur.getAttribute('data-why-token');
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
    if (extra) for (var k in extra) body[k] = extra[k];

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

  .bar { position: fixed; left: 50%; transform: translateX(-50%); bottom: 18px; pointer-events: auto; display: flex; gap: 6px; align-items: center; background: #1e1b31; color: #ede9fe; padding: 7px; border-radius: 10px; box-shadow: 0 10px 30px rgba(15,23,42,.4); }
  .bar button { font: inherit; font-size: 13px; border: 0; background: #2e2a48; color: #ede9fe; padding: 8px 11px; border-radius: 7px; cursor: pointer; }
  .bar button:hover { background: #3d3760; }
  .bar button.on { background: #7c3aed; color: #fff; }
  .bar .mark { font-size: 12px; letter-spacing: .04em; color: #a78bfa; padding: 0 8px 0 4px; }
  .bar .vp { font-size: 11px; color: #8b83b8; padding-right: 4px; }
  .bar .acct { font-size: 11px; padding: 4px 8px; border-radius: 999px; background: #2e2a48; color: #a5a0c4; white-space: nowrap; }
  .bar .acct.cloud { background: #1f3a2e; color: #6ee7b7; }
  .bar .acct.syncing { background: #2e2a48; color: #c4b5fd; }
  .bar .acct.offline, .bar .acct.error { background: #3b2230; color: #fda4af; }

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

  .composer { position: fixed; bottom: 0; right: 0; width: 380px; max-width: 100vw; background: #fff; border-top: 1px solid #e6e1da; padding: 14px 16px 16px; pointer-events: auto; box-shadow: 0 -8px 30px rgba(15,23,42,.12); }
  .composer .target { font-size: 11px; color: #6b6480; margin-bottom: 8px; word-break: break-all; }
  .composer textarea { width: 100%; min-height: 84px; font: inherit; font-size: 14px; padding: 9px 10px; border: 1px solid #ddd7ce; border-radius: 7px; resize: vertical; color: #1c1a2e; }
  .composer .posting-as { font-size: 12px; color: #6b6480; margin-top: 9px; }
  .composer .row { display: flex; gap: 8px; margin-top: 8px; }
  .composer select, .composer input { font: inherit; font-size: 13px; padding: 7px 8px; border: 1px solid #ddd7ce; border-radius: 7px; background: #fff; flex: 1; min-width: 0; color: #1c1a2e; }
  .composer .actions { display: flex; gap: 8px; margin-top: 10px; }
  .primary { font: inherit; font-size: 13px; font-weight: 600; background: #5b21b6; color: #fff; border: 0; border-radius: 7px; padding: 9px 14px; cursor: pointer; flex: 1; }
  .primary:hover { background: #4c1d95; }
  .ghost { font: inherit; font-size: 13px; background: #fff; color: #4a4560; border: 1px solid #ddd7ce; border-radius: 7px; padding: 9px 12px; cursor: pointer; }
  .ghost:hover { background: #f6f3ee; }
  .danger { color: #be123c; }

  .toast { position: fixed; left: 50%; transform: translateX(-50%); bottom: 74px; background: #1c1a2e; color: #fff; font-size: 13px; padding: 9px 14px; border-radius: 8px; pointer-events: none; }

  @media (max-width: 640px) {
    .panel, .composer { width: 100%; }
    .panel { height: 78%; top: auto; bottom: 0; border-top-left-radius: 14px; border-top-right-radius: 14px; }
    .bar { bottom: 10px; flex-wrap: wrap; justify-content: center; max-width: 96vw; }
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
  var editing = null;      // note being composed or edited
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
      if (!target) { p.node.classList.add('orphan'); p.node.style.left = '8px'; p.node.style.top = (8 + i * 28) + 'px'; continue; }
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
    requestAnimationFrame(function () { ticking = false; layoutPins(); if (picking && hovered) paintHighlight(hovered); });
  }

  function renderPins() {
    for (var i = 0; i < pinNodes.length; i++) pinNodes[i].node.remove();
    pinNodes = [];
    var vp = viewportSnapshot();
    doc.notes.forEach(function (n, idx) {
      var node = el('div', 'pin');
      node.textContent = String(idx + 1);
      node.style.background = catOf(n.category).color;
      node.title = n.body.slice(0, 80);
      if (filter !== 'all' && n.category !== filter) node.classList.add('dim');
      if (n.viewport && n.viewport.breakpoint !== vp.breakpoint) node.classList.add('dim');
      node.addEventListener('click', function (e) { e.stopPropagation(); focusNote(n.id); });
      layer.appendChild(node);
      pinNodes.push({ note: n, node: node });
    });
    layoutPins();
  }

  /* ---------- panel ---------- */

  var panel = null, composer = null, bar = null;

  function buildBar() {
    if (bar) bar.remove();
    bar = el('div', 'bar');
    var vp = viewportSnapshot();
    var mark = el('span', 'mark', 'WhyTho ' + VERSION);
    mark.title = 'Click to test the connection to your account.';
    mark.style.cursor = 'pointer';
    mark.addEventListener('click', diagnose);
    var pick = el('button', picking ? 'on' : '', picking ? 'Cancel selection' : 'Select an element');
    pick.addEventListener('click', function () { setPicking(!picking); });
    var list = el('button', '', (panelOpen ? 'Hide notes' : 'Show notes') + ' (' + doc.notes.length + ')');
    list.addEventListener('click', function () { panelOpen = !panelOpen; render(); });
    var send = el('button', '', TOKEN ? 'Open console' : 'Sign in to save these');
    send.title = TOKEN
      ? 'Open WhyTho in a new tab.'
      : 'These notes are only in this browser. Signing in moves them to your account.';
    send.addEventListener('click', function () {
      if (TOKEN) window.open(CONSOLE_URL, '_blank', 'noopener');
      else sendToConsole();   // nothing is signed in yet, so carry them across by hand
    });
    var off = el('button', '', 'Close');
    off.addEventListener('click', function () { publicApi.off(); });
    var vpn = el('span', 'vp', (identity.org_name ? identity.org_name + '  ' : '') + vp.breakpoint + ' ' + vp.width + 'px');

    var labels = {
      cloud: 'Saved to your account',
      syncing: 'Saving',
      offline: 'Not saved to your account',
      error: 'Sync problem',
      local: 'This browser only'
    };
    var pending = TOKEN ? unsynced().length : 0;
    var acct = el('span', 'acct ' + syncState,
      (syncState === 'offline' || syncState === 'error')
        ? labels[syncState] + (pending ? ', ' + pending + ' to retry' : '') + '. Retry'
        : labels[syncState]);

    if (TOKEN && (syncState === 'offline' || syncState === 'error')) {
      acct.style.cursor = 'pointer';
      acct.title = 'Send the notes this page has not saved yet.';
      acct.addEventListener('click', function () {
        var todo = unsynced();
        if (todo.length) push(todo); else pullNotes();
      });
    }
    if (!TOKEN) {
      acct.title = 'Sign in at whytho.jakelabate.com and use your personal bookmarklet to save notes to your account.';
      acct.style.cursor = 'pointer';
      acct.addEventListener('click', function () { window.open(CONSOLE_URL, '_blank', 'noopener'); });
    }

    bar.appendChild(mark); bar.appendChild(pick); bar.appendChild(list);
    bar.appendChild(send); bar.appendChild(off);
    bar.appendChild(acct); bar.appendChild(vpn);
    layer.appendChild(bar);
  }

  function buildPanel() {
    if (panel) { panel.remove(); panel = null; }
    if (!panelOpen) return;
    panel = el('div', 'panel');

    var h = document.createElement('header');
    h.appendChild(el('h2', '', 'Notes on this page'));
    var exp = el('button', 'icon'); exp.textContent = 'JSON'; exp.title = 'Copy JSON';
    exp.style.fontSize = '11px';
    exp.addEventListener('click', copyJSON);
    var close = el('button', 'icon'); close.textContent = '\u2715'; close.title = 'Hide panel';
    close.addEventListener('click', function () { panelOpen = false; render(); });
    h.appendChild(exp); h.appendChild(close);
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
        '<div class="top"><span class="num">' + idx + '</span><span>' + esc(catOf(n.category).label) + '</span>' +
        '<span>' + esc(n.status) + '</span><span style="margin-left:auto">' + esc(vpTxt) + '</span></div>' +
        '<div class="body">' + withMentions(n.body) + '</div>' +
        '<code>' + esc(n.selector) + '</code>' +
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
    if (target) {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(function () { paintHighlight(target); }, 320);
      setTimeout(function () { if (!picking) paintHighlight(null); }, 2200);
    } else {
      toast('That element is no longer on the page.');
    }
    openComposer(target, n);
  }

  function openComposer(target, existing) {
    editing = existing || {
      id: uid(),
      selector: buildSelector(target),
      fallbackSelector: '',
      tag: target.tagName.toLowerCase(),
      textSnippet: snippet(target),
      category: 'seo',
      status: 'decided',
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

  function renderComposer() {
    if (composer && editing && composer.dataset.noteId === editing.id) return;
    if (composer) { composer.remove(); composer = null; }
    if (!editing) return;
    var n = editing;
    composer = el('div', 'composer');
    composer.dataset.noteId = n.id;

    var target = el('div', 'target');
    target.innerHTML = '<b>' + esc(n.tag) + '</b> &nbsp; ' + esc(n.selector);
    composer.appendChild(target);

    var ta = document.createElement('textarea');
    ta.placeholder = directory.length
      ? 'Why is this element the way it is? Type @ to tag a person or a team.'
      : 'Why is this element the way it is? Note the decision, the constraint, and who to ask before changing it.';
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
        return d.label.toLowerCase().indexOf(q) === 0 || d.label.toLowerCase().indexOf(' ' + q) > -1 || q === '';
      }).slice(0, 6);
      if (!matches.length) return closePicker();
      pickIndex = 0;
      paintPicker();
      picker.style.display = 'block';
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
      var before = ta.value.slice(0, tok.at);
      var after = ta.value.slice(ta.selectionStart);
      ta.value = before + '@' + m.label + ' ' + after;
      var pos = (before + '@' + m.label + ' ').length;
      ta.setSelectionRange(pos, pos);
      ta.focus();
      closePicker();
    }

    ta.addEventListener('input', refreshPicker);
    ta.addEventListener('keydown', function (e) {
      if (picker.style.display === 'none' || !matches.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); pickIndex = (pickIndex + 1) % matches.length; paintPicker(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); pickIndex = (pickIndex - 1 + matches.length) % matches.length; paintPicker(); }
      else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(matches[pickIndex]); }
      else if (e.key === 'Escape') { e.preventDefault(); closePicker(); }
    });
    ta.addEventListener('blur', closePicker);

    var row = el('div', 'row');
    var cat = document.createElement('select');
    CATEGORIES.forEach(function (c) {
      var o = document.createElement('option'); o.value = c.id; o.textContent = c.label;
      if (c.id === n.category) o.selected = true; cat.appendChild(o);
    });
    var st = document.createElement('select');
    STATUSES.forEach(function (s) {
      var o = document.createElement('option'); o.value = s; o.textContent = s;
      if (s === n.status) o.selected = true; st.appendChild(o);
    });
    row.appendChild(cat); row.appendChild(st);
    composer.appendChild(row);

    var who = el('div', 'posting-as');
    who.textContent = identity.author
      ? 'Posting as ' + identity.author + (identity.org_name ? ' in ' + identity.org_name : '')
      : (TOKEN ? 'Posting to your account' : 'Saved in this browser only, not attributed to anyone');
    composer.appendChild(who);

    var actions = el('div', 'actions');
    var save = el('button', 'primary', doc.notes.indexOf(n) > -1 ? 'Save note' : 'Add note');
    save.addEventListener('click', function () {
      if (!ta.value.trim()) { ta.focus(); toast('Write the reasoning first.'); return; }
      n.body = ta.value.trim();
      n.category = cat.value;
      n.status = st.value;
      n.author = identity.author || '';
      if (doc.notes.indexOf(n) === -1) doc.notes.push(n);
      Store.write(doc);
      editing = null;
      render();
      toast(TOKEN ? 'Note saved. Sending it to your account.' : 'Note saved in this browser.');
      push([n]);
    });
    var cancel = el('button', 'ghost', 'Cancel');
    cancel.addEventListener('click', function () { editing = null; render(); });
    actions.appendChild(save); actions.appendChild(cancel);
    if (doc.notes.indexOf(n) > -1 && n.mine !== false) {
      var del = el('button', 'ghost danger', 'Delete');
      del.addEventListener('click', function () {
        doc.notes = doc.notes.filter(function (x) { return x.id !== n.id; });
        Store.write(doc); removeRemote(n); editing = null; render(); toast('Note deleted.');
      });
      actions.appendChild(del);
    }
    composer.appendChild(actions);
    layer.appendChild(composer);
    setTimeout(function () { ta.focus(); }, 30);
  }

  function render() {
    buildBar();
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

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onPick, true);
  document.addEventListener('touchstart', onTouchStart, { capture: true, passive: false });
  document.addEventListener('touchend', clearPress, true);
  document.addEventListener('touchmove', clearPress, true);
  window.addEventListener('scroll', scheduleLayout, true);
  window.addEventListener('resize', function () { scheduleLayout(); buildBar(); }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { if (picking) setPicking(false); else if (editing) { editing = null; render(); } }
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
