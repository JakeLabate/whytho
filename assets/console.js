/* WhyTho console
   Account, library, and exports. Notes live in Postgres behind row level security,
   so an account only ever sees its own rows. */
(function () {
  'use strict';

  var CFG = window.WHY_CONFIG;
  var LOCAL_KEY = 'why:console:v1';
  var CATEGORY_LABELS = { seo: 'SEO', content: 'Content', tech: 'Technical', a11y: 'Accessibility', perf: 'Performance', ux: 'UX' };
  var CATEGORY_COLORS = { seo: '#5b21b6', content: '#0f766e', tech: '#b45309', a11y: '#be123c', perf: '#1d4ed8', ux: '#7c2d12' };

  var sb = window.supabase.createClient(CFG.supabaseUrl, CFG.publishableKey);
  var user = null;
  var token = null;
  var profile = null;      // display name and active workspace
  var orgs = [];           // organizations this account belongs to
  var myRole = null;
  var current = null;      // { page, notes }

  var $ = function (s) { return document.querySelector(s); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function highlight(text) {
    return esc(text).replace(/@([A-Za-z0-9][A-Za-z0-9 ._-]{0,40})/g, function (whole) {
      return '<span class="tagged">' + whole + '</span>';
    });
  }

  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, 3400);
  }

  function fromRow(r) {
    return {
      id: r.client_id, selector: r.selector, fallbackSelector: r.fallback_selector,
      tag: r.tag, textSnippet: r.text_snippet, category: r.category, status: r.status,
      body: r.body, author: r.author, viewport: r.viewport || {}, createdAt: r.created_at
    };
  }

  /* ---------- local store, kept for imports and for signed out use ---------- */

  function localDb() {
    try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) || { pages: [] }; }
    catch (e) { return { pages: [] }; }
  }
  function saveLocal(db) {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(db)); }
    catch (e) { toast('This browser refused to store the notes.'); }
  }
  function pageId(p) { return (p.origin || '') + (p.path || ''); }

  function mergeLocal(incoming) {
    var db = localDb(), added = 0;
    (incoming.pages || []).forEach(function (page) {
      if (!page || !page.notes) return;
      var existing = null;
      db.pages.forEach(function (p) { if (pageId(p) === pageId(page)) existing = p; });
      if (!existing) { db.pages.push(page); added += page.notes.length; return; }
      existing.updatedAt = page.updatedAt || existing.updatedAt;
      page.notes.forEach(function (n) {
        var hit = -1;
        existing.notes.forEach(function (e, i) { if (e.id === n.id) hit = i; });
        if (hit > -1) existing.notes[hit] = n; else { existing.notes.push(n); added++; }
      });
    });
    saveLocal(db);
    if (user) {
      uploadLocal();
    } else {
      renderLibrary();
      toast(added + ' note' + (added === 1 ? '' : 's') + ' imported into this browser. Sign in to keep them on your account.');
    }
  }

  /* ---------- shell and routing ---------- */

  var TABS = ['notes', 'inbox', 'workspace', 'setup', 'account'];

  function currentRoute() {
    var m = (location.hash || '').match(/^#\/([a-z]+)/);
    return m && TABS.concat(['page']).indexOf(m[1]) > -1 ? m[1] : 'notes';
  }

  function showView(name) {
    document.querySelectorAll('.view').forEach(function (v) {
      v.hidden = v.getAttribute('data-view') !== name;
    });
    document.querySelectorAll('#tabs a').forEach(function (a) {
      var tab = a.getAttribute('data-tab');
      a.classList.toggle('on', tab === name || (name === 'page' && tab === 'notes'));
    });
    if (window.scrollTo) window.scrollTo(0, 0);
  }

  function go(route) {
    if (location.hash === '#/' + route) showView(route);
    else location.hash = '#/' + route;
  }

  function route() {
    if (!user) return;
    var name = currentRoute();
    if (name === 'page' && !current) name = 'notes';
    showView(name);
  }

  function applyAuthState() {
    $('#gate').hidden = !!user;
    $('#app').hidden = !user;
    if (user) route();
  }

  function renderWho() {
    var box = $('#app-who');
    if (!user) { box.innerHTML = ''; return; }
    var org = activeOrg();
    var name = (profile && profile.display_name) || user.email;
    var initial = (name || '?').trim().charAt(0).toUpperCase();
    var avatar = profile && profile.avatar_url
      ? '<img class="who-avatar" src="' + esc(profile.avatar_url) + '" alt="">'
      : '<span class="who-avatar who-initial">' + esc(initial) + '</span>';
    box.innerHTML = '<a class="who" href="#/account">' + avatar +
      '<span class="who-text"><b>' + esc(name) + '</b><span class="sub">' +
      esc(org ? org.name : 'Personal') + '</span></span></a>';
  }

  /* ---------- account ---------- */

  function randomToken() {
    var a = new Uint8Array(24);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  function ensureToken() {
    return sb.from('why_tokens').select('token').eq('revoked', false).limit(1)
      .then(function (res) {
        if (res.data && res.data.length) { token = res.data[0].token; return token; }
        var t = randomToken();
        return sb.from('why_tokens').insert({ token: t, user_id: user.id, label: 'bookmarklet' })
          .then(function () { token = t; return t; });
      });
  }

  function bookmarkletCode() {
    var src = CFG.consoleUrl.replace(/\/$/, '') + '/assets/annotator.js';
    var t = token || '';
    return "javascript:(function(){if(window.__why__){window.__why__.toggle();return}" +
      "var s=document.createElement('script');s.src='" + src + "?t='+Date.now();" +
      (t ? "s.setAttribute('data-why-token','" + t + "');" : "") +
      "document.body.appendChild(s)})()";
  }

  function renderAccount() {
    var box = user ? $('#account-box') : $('#signin-box');
    if (user) {
      box.innerHTML =
        '<div class="acct-row"><div><b>' + esc((profile && profile.display_name) || user.email) + '</b><br>' +
        '<span class="sub">' + esc(user.email) + '. Notes on this account save from any browser you use, ' +
        'and are signed with this name.</span></div>' +
        '<button class="btn quiet small" id="signout">Sign out</button></div>';
      $('#signout').addEventListener('click', function () {
        sb.auth.signOut().then(function () { location.reload(); });
      });
    } else {
      box.innerHTML =
        '<button class="btn oauth" type="button" id="github">Continue with GitHub</button>' +
        '<div class="or"><span>or use an email address</span></div>' +
        '<form class="auth" id="auth-form">' +
        '<input type="email" id="email" placeholder="you@company.com" autocomplete="email" required>' +
        '<input type="password" id="password" placeholder="Password, 8 characters or more" autocomplete="current-password" minlength="8">' +
        '<div class="auth-actions">' +
        '<button class="btn small" type="submit" id="signin">Sign in</button>' +
        '<button class="btn quiet small" type="button" id="signup">Create account</button>' +
        '<button class="btn quiet small" type="button" id="magic">Email me a link</button>' +
        '</div><p class="sub" id="auth-msg">Without an account, notes stay in this browser. If you have signed in to another of these apps with GitHub, use that button and skip the password.</p>' +
        '<p class="sub note-small">If GitHub sends you to a different app, this domain is not in the Supabase redirect allowlist yet.</p></form>';

      $('#github').addEventListener('click', function () {
        sb.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: CFG.consoleUrl } })
          .then(function (res) { if (res.error) toast(res.error.message); });
      });
      $('#auth-form').addEventListener('submit', function (e) { e.preventDefault(); doAuth('in'); });
      $('#signup').addEventListener('click', function () { doAuth('up'); });
      $('#magic').addEventListener('click', function () { doAuth('magic'); });
    }
    renderSetup();
  }

  function doAuth(kind) {
    var email = $('#email').value.trim(), password = $('#password').value;
    var msg = $('#auth-msg');
    if (!email) { toast('Enter your email address.'); return; }

    if (kind === 'magic') {
      sb.auth.signInWithOtp({ email: email, options: { emailRedirectTo: CFG.consoleUrl } })
        .then(function (res) {
          if (res.error) { msg.textContent = res.error.message; return; }
          msg.textContent = 'Sign in link sent to ' + email + '. It works once and expires in an hour.';
        });
      return;
    }

    if (password.length < 8) { toast('Passwords need at least 8 characters.'); return; }

    var call = kind === 'up'
      ? sb.auth.signUp({ email: email, password: password, options: { emailRedirectTo: CFG.consoleUrl } })
      : sb.auth.signInWithPassword({ email: email, password: password });

    call.then(function (res) {
      if (res.error) {
        // A wrong password and an account with no password look the same from here,
        // so say what to try rather than repeating the server wording.
        msg.textContent = res.error.message.indexOf('Invalid login credentials') > -1
          ? 'That email and password did not match. If you created this account with GitHub, there is no password on it. Use Continue with GitHub, or email yourself a link.'
          : res.error.message;
        return;
      }
      // Supabase answers a repeat signup with a 200 and an empty identity list, and
      // sends no email. Without this check the page would tell you to wait for one.
      var u = res.data && res.data.user;
      if (kind === 'up' && u && Array.isArray(u.identities) && u.identities.length === 0) {
        msg.textContent = 'That email already has an account. Sign in instead, or email yourself a link if you do not have a password.';
        return;
      }
      if (kind === 'up' && u && !res.data.session) {
        msg.textContent = 'Check your email to confirm the account, then sign in.';
        return;
      }
      boot();
    });
  }

  function renderSetup() {
    var bm = $('#bookmarklet');
    if (!bm) return;
    bm.setAttribute('href', bookmarkletCode());
    $('#bookmarklet-state').textContent = user && token
      ? 'This bookmarklet is tied to your account. Notes you take with it save to ' + user.email + '.'
      : 'Sign in first and this bookmarklet will carry your account with it. Right now it saves notes in the browser only.';
    $('#snippet').textContent = '<script src="' + CFG.consoleUrl.replace(/\/$/, '') + '/assets/annotator.js"' +
      (token ? ' data-why-token="' + token + '"' : '') + ' defer><\/script>';
  }

  /* ---------- workspace ---------- */

  function loadWorkspace() {
    if (!user) { renderWorkspace(); return Promise.resolve(); }
    return sb.from('why_profiles').select('*').eq('user_id', user.id).maybeSingle()
      .then(function (res) {
        profile = res.data || { user_id: user.id, display_name: null, active_org_id: null, active_team_id: null };
        return sb.from('why_org_members').select('org_id, role').eq('user_id', user.id);
      })
      .then(function (res) {
        var roles = {};
        (res.data || []).forEach(function (m) { roles[m.org_id] = m.role; });
        return sb.from('why_orgs').select('id, name').then(function (o) {
          orgs = (o.data || []).map(function (x) { x.role = roles[x.id] || 'member'; return x; });
          myRole = profile.active_org_id ? (roles[profile.active_org_id] || 'member') : null;
        });
      });
  }

  function setActive(orgId, teamId) {
    return sb.from('why_profiles').upsert({
      user_id: user.id, active_org_id: orgId, active_team_id: teamId || null, updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' }).then(function (res) {
      if (res.error) { toast(res.error.message); return; }
      return boot();
    });
  }

  function activeOrg() {
    var found = null;
    orgs.forEach(function (o) { if (profile && o.id === profile.active_org_id) found = o; });
    return found;
  }

  function renderWorkspace() {
    var box = $('#workspace-box');
    if (!user) {
      box.innerHTML = '<p class="sub">Sign in to create an organization or join one.</p>';
      return;
    }

    var org = activeOrg();
    var html = '<div class="ws-head"><div><b>' +
      (org ? esc(org.name) : 'Working on your own') + '</b><br><span class="sub">' +
      (org ? 'Everyone in this organization sees notes written here. You are ' + esc(myRole) + '.'
           : 'Notes are private to ' + esc(profile.display_name || user.email) + '.') +
      '</span></div></div>';

    if (orgs.length) {
      html += '<div class="ws-row"><label class="ws-label">Active workspace</label><select id="org-switch">';
      html += '<option value="">Personal, private to me</option>';
      orgs.forEach(function (o) {
        html += '<option value="' + o.id + '"' + (org && o.id === org.id ? ' selected' : '') + '>' + esc(o.name) + '</option>';
      });
      html += '</select></div>';
    }

    html += '<div id="ws-detail"></div>';
    html += '<details class="ws-more"><summary>Create or join an organization</summary>' +
      '<div class="ws-row"><input id="org-name" placeholder="Organization name"><button class="btn small" id="org-create">Create</button></div>' +
      '<div class="ws-row"><input id="join-code" placeholder="Invite code"><button class="btn quiet small" id="join-go">Join</button></div>' +
      '</details>';

    box.innerHTML = html;

    if ($('#org-switch')) {
      $('#org-switch').addEventListener('change', function (e) { setActive(e.target.value || null, null); });
    }
    $('#org-create').addEventListener('click', function () {
      var name = $('#org-name').value.trim();
      if (!name) { toast('Name the organization first.'); return; }
      sb.rpc('why_create_org', { p_name: name }).then(function (res) {
        var out = res.data || {};
        if (res.error || out.error) { toast((res.error && res.error.message) || out.error); return; }
        toast(name + ' created. You are the owner.');
        boot();
      });
    });
    $('#join-go').addEventListener('click', function () {
      var code = $('#join-code').value.trim();
      if (!code) { toast('Paste the invite code.'); return; }
      sb.rpc('why_redeem_invite', { p_code: code }).then(function (res) {
        var out = res.data || {};
        if (res.error || out.error) { toast((res.error && res.error.message) || out.error); return; }
        toast('Joined.');
        boot();
      });
    });

    if (org) renderOrgDetail(org);
  }

  function renderOrgDetail(org) {
    var wrap = $('#ws-detail');
    wrap.innerHTML = '<p class="sub">Loading teams and people.</p>';
    var teams = [], members = [], myTeams = [];

    sb.from('why_teams').select('id, name').eq('org_id', org.id)
      .then(function (r) { teams = r.data || []; return sb.from('why_org_members').select('user_id, role').eq('org_id', org.id); })
      .then(function (r) {
        members = r.data || [];
        return sb.from('why_profiles').select('user_id, display_name').in('user_id', members.map(function (m) { return m.user_id; }));
      })
      .then(function (r) {
        var names = {};
        (r.data || []).forEach(function (p) { names[p.user_id] = p.display_name; });
        return sb.from('why_team_members').select('team_id').eq('user_id', user.id).then(function (t) {
          myTeams = (t.data || []).map(function (x) { return x.team_id; });
          paint(names);
        });
      });

    function paint(names) {
      var isAdmin = myRole === 'owner' || myRole === 'admin';
      var html = '';

      html += '<div class="ws-block"><label class="ws-label">Teams</label>';
      if (!teams.length) html += '<p class="sub">No teams yet. Notes will be attributed to you and to the organization.</p>';
      html += '<div class="ws-chips">';
      teams.forEach(function (t) {
        var on = profile.active_team_id === t.id;
        html += '<button class="chip-btn' + (on ? ' on' : '') + '" data-team="' + t.id + '">' + esc(t.name) +
          (myTeams.indexOf(t.id) > -1 ? '' : ' <span class="sub">join</span>') + '</button>';
      });
      html += '</div>';
      if (isAdmin) {
        html += '<div class="ws-row"><input id="team-name" placeholder="New team name"><button class="btn quiet small" id="team-create">Add team</button></div>';
      }
      html += '</div>';

      html += '<div class="ws-block"><label class="ws-label">People</label><ul class="ws-people">';
      members.forEach(function (m) {
        html += '<li><b>' + esc(names[m.user_id] || 'Unnamed account') + '</b> <span class="sub">' + esc(m.role) +
          (m.user_id === user.id ? ', you' : '') + '</span></li>';
      });
      html += '</ul>';

      if (isAdmin) {
        html += '<div class="ws-row"><select id="invite-team"><option value="">No specific team</option>';
        teams.forEach(function (t) { html += '<option value="' + t.id + '">' + esc(t.name) + '</option>'; });
        html += '</select><select id="invite-role"><option value="member">Member</option><option value="admin">Admin</option></select>' +
          '<button class="btn small" id="invite-make">Create invite code</button></div>' +
          '<p class="sub" id="invite-out"></p>';
      }
      html += '</div>';

      wrap.innerHTML = html;

      wrap.querySelectorAll('[data-team]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-team');
          sb.from('why_team_members').upsert({ team_id: id, user_id: user.id }, { onConflict: 'team_id,user_id' })
            .then(function () { return setActive(org.id, id); });
        });
      });

      if ($('#team-create')) {
        $('#team-create').addEventListener('click', function () {
          var name = $('#team-name').value.trim();
          if (!name) { toast('Name the team first.'); return; }
          sb.from('why_teams').insert({ org_id: org.id, name: name }).then(function (r) {
            if (r.error) { toast(r.error.message); return; }
            toast(name + ' added.');
            renderOrgDetail(org);
          });
        });
      }

      if ($('#invite-make')) {
        $('#invite-make').addEventListener('click', function () {
          var code = randomToken().slice(0, 12);
          sb.from('why_invites').insert({
            code: code, org_id: org.id,
            team_id: $('#invite-team').value || null,
            role: $('#invite-role').value,
            created_by: user.id
          }).then(function (r) {
            if (r.error) { toast(r.error.message); return; }
            $('#invite-out').innerHTML = 'Send this code, it works for 30 days: <code>' + code + '</code>';
            copy(code, 'Invite code');
          });
        });
      }
    }
  }

  /* ---------- inbox ---------- */

  var inbox = [];

  function loadInbox() {
    if (!user) { inbox = []; return Promise.resolve(); }
    return sb.rpc('why_notifications_feed', { p_limit: 100 }).then(function (res) {
      if (res.error) { inbox = []; return; }
      inbox = res.data || [];
    });
  }

  function unreadCount() {
    return inbox.filter(function (n) { return !n.read_at; }).length;
  }

  function renderBadge() {
    var b = $('#inbox-badge');
    if (!b) return;
    var n = unreadCount();
    b.hidden = n === 0;
    b.textContent = n > 99 ? '99+' : String(n);
  }

  function markRead(ids) {
    if (!ids.length) return Promise.resolve();
    var now = new Date().toISOString();
    inbox.forEach(function (n) { if (ids.indexOf(n.id) > -1) n.read_at = now; });
    renderBadge();
    return sb.from('why_notifications').update({ read_at: now }).in('id', ids);
  }

  function renderInbox() {
    var wrap = $('#inbox-list');
    if (!wrap) return;
    renderBadge();

    if (!inbox.length) {
      wrap.innerHTML = '<div class="blank">Nothing yet. When somebody types <b>@' +
        esc((profile && profile.display_name) || 'your name') +
        '</b> or the name of a team you are in, it arrives here.</div>';
      return;
    }

    wrap.innerHTML = '';
    inbox.forEach(function (n) {
      var card = document.createElement('button');
      card.className = 'notif' + (n.read_at ? '' : ' unread');
      var why = n.via_team ? 'tagged <b>' + esc(n.via_team) + '</b>' : 'tagged <b>you</b>';
      card.innerHTML =
        '<div class="notif-top">' + (n.read_at ? '' : '<span class="dot-unread"></span>') +
        '<b>' + esc(n.actor || 'Someone') + '</b> ' + why +
        '<span class="notif-when">' + esc(new Date(n.created_at).toLocaleString()) + '</span></div>' +
        '<div class="notif-body">' + esc(n.body) + '</div>' +
        '<div class="notif-foot"><code>' + esc(n.selector || '') + '</code>' +
        '<span class="sub">' + esc((n.origin || '').replace(/^https?:\/\//, '') + (n.path || '')) + '</span></div>';
      card.addEventListener('click', function () {
        markRead([n.id]);
        if (!n.page_id) return;
        sb.from('why_pages').select('*').eq('id', n.page_id).maybeSingle().then(function (r) {
          if (r.data) openCloud(r.data);
        });
      });
      wrap.appendChild(card);
    });
  }

  /* ---------- library ---------- */

  function renderLibrary() {
    var wrap = $('#library-list');
    var scope = $('#notes-scope');
    if (scope) {
      var org = activeOrg();
      scope.textContent = !user ? ''
        : org ? 'Pages annotated in ' + org.name + ', by anyone in the organization.'
              : 'Pages you have annotated. These are private to you.';
    }
    if (!user) {
      var db = localDb();
      wrap.innerHTML = '';
      if (!db.pages.length) {
        wrap.innerHTML = '<div class="blank">Nothing here yet. Sign in above to save notes to your account, or annotate a page and choose <b>Send to console</b> to keep them in this browser.</div>';
        return;
      }
      db.pages.forEach(function (p) { wrap.appendChild(row(p.path, p.origin, p.notes.length, p.updatedAt, function () { openLocal(pageId(p)); })); });
      var cta = document.createElement('div');
      cta.className = 'blank';
      cta.innerHTML = 'These notes are in this browser only. Sign in and they move to your account.';
      wrap.appendChild(cta);
      return;
    }

    wrap.innerHTML = '<div class="blank">Loading your pages.</div>';
    sb.from('why_pages').select('*').order('updated_at', { ascending: false }).then(function (res) {
      if (res.error) { wrap.innerHTML = '<div class="blank">' + esc(res.error.message) + '</div>'; return; }
      var pages = res.data || [];
      if (!pages.length) {
        wrap.innerHTML = '<div class="blank">No pages yet. Run the bookmarklet on a page, leave a note, and it lands here.</div>';
        return;
      }
      sb.from('why_notes').select('page_id').is('deleted_at', null).then(function (nres) {
        var counts = {};
        (nres.data || []).forEach(function (n) { counts[n.page_id] = (counts[n.page_id] || 0) + 1; });
        wrap.innerHTML = '';
        pages.forEach(function (p) {
          var label = p.org_id ? (activeOrg() && p.org_id === activeOrg().id ? activeOrg().name : 'Shared') : 'Personal';
          wrap.appendChild(row(p.path, p.origin, counts[p.id] || 0, p.updated_at, function () { openCloud(p); }, label));
        });
      });
    });
  }

  function row(path, origin, count, updated, onClick, scope) {
    var b = document.createElement('button');
    b.className = 'page-row';
    b.innerHTML =
      '<span class="dot"></span>' +
      '<span><span class="path">' + esc(path || '/') + '</span>' +
      (scope ? '<span class="scope-tag">' + esc(scope) + '</span>' : '') +
      '<br><span class="host">' + esc(String(origin || '').replace(/^https?:\/\//, '')) + '</span></span>' +
      '<span class="count">' + count + ' note' + (count === 1 ? '' : 's') +
      (updated ? ' &middot; ' + esc(new Date(updated).toLocaleDateString()) : '') + '</span>';
    b.addEventListener('click', onClick);
    return b;
  }

  // Anything still sitting in this browser belongs on the account. Move it quietly.
  function absorbLocal() {
    if (!user) return Promise.resolve();
    var db = localDb();
    if (!db.pages.length) return Promise.resolve();
    return uploadLocal(true);
  }

  function uploadLocal(quiet) {
    var db = localDb();
    if (!db.pages.length) return Promise.resolve();
    var moved = db.pages.reduce(function (a, p) { return a + p.notes.length; }, 0);
    var jobs = db.pages.map(function (p) {
      var orgId = profile ? profile.active_org_id : null;
      return sb.from('why_pages').upsert(
        { user_id: user.id, org_id: orgId, origin: p.origin, path: p.path, url: p.url, title: p.title },
        { onConflict: orgId ? 'org_id,origin,path' : 'user_id,origin,path' }
      ).select('id').single().then(function (res) {
        if (res.error || !res.data) return;
        var rows = p.notes.map(function (n) {
          return {
            page_id: res.data.id, user_id: user.id, org_id: orgId,
            team_id: profile ? profile.active_team_id : null,
            client_id: n.id, selector: n.selector,
            fallback_selector: n.fallbackSelector || null, tag: n.tag || null,
            text_snippet: n.textSnippet || null, category: n.category || 'seo',
            status: n.status || 'decided', body: n.body,
            author: (profile && profile.display_name) || null,
            viewport: n.viewport || {}, created_at: n.createdAt || new Date().toISOString(), deleted_at: null
          };
        });
        if (!rows.length) return;
        return sb.from('why_notes').upsert(rows, { onConflict: 'user_id,client_id' });
      });
    });
    return Promise.all(jobs).then(function (results) {
      var failed = results.filter(function (r) { return r && r.error; });
      if (failed.length) { toast('Could not move local notes: ' + failed[0].error.message); renderLibrary(); return; }
      localStorage.removeItem(LOCAL_KEY);
      toast(moved + ' note' + (moved === 1 ? '' : 's') + ' from this browser moved to your account.');
      renderLibrary();
    });
  }

  /* ---------- viewer ---------- */

  function showViewer(title, url, notes, onDelete) {
    $('#viewer-title').textContent = title || 'Page';
    $('#viewer-url').innerHTML = url ? '<a href="' + esc(url) + '" rel="noopener">' + esc(url) + '</a>' : '';
    var wrap = $('#viewer-notes');
    wrap.innerHTML = '';
    notes.forEach(function (n, i) {
      var d = document.createElement('div');
      d.className = 'note';
      d.style.borderLeftColor = CATEGORY_COLORS[n.category] || '#5b21b6';
      var vp = n.viewport && n.viewport.width ? n.viewport.breakpoint + ' ' + n.viewport.width + 'px' : 'viewport not recorded';
      d.innerHTML =
        '<div class="top"><b>' + (i + 1) + '</b><span>' + esc(CATEGORY_LABELS[n.category] || n.category) + '</span>' +
        '<span>' + esc(n.status || '') + '</span><span>' + esc(vp) + '</span></div>' +
        '<div class="body">' + highlight(n.body) + '</div><code>' + esc(n.selector) + '</code>' +
        '<div class="top" style="margin-top:10px"><span><b>' + esc(n.author || 'Unknown') + '</b>' +
        (n.team ? ' &middot; ' + esc(n.team) : '') + '</span>' +
        '<span>' + esc(n.createdAt ? new Date(n.createdAt).toLocaleString() : '') + '</span></div>';
      wrap.appendChild(d);
    });
    current = { title: title, url: url, notes: notes, remove: onDelete };
    go('page');
  }

  function openLocal(id) {
    var db = localDb(), p = null;
    db.pages.forEach(function (x) { if (pageId(x) === id) p = x; });
    if (!p) return;
    showViewer(p.title || p.path, p.url, p.notes, function () {
      var d = localDb();
      d.pages = d.pages.filter(function (x) { return pageId(x) !== id; });
      saveLocal(d); current = null; go('notes'); renderLibrary(); toast('Page removed.');
    });
  }

  function openCloud(page) {
    var rows = [];
    sb.from('why_notes').select('*').eq('page_id', page.id).is('deleted_at', null)
      .order('created_at', { ascending: true })
      .then(function (res) {
        if (res.error) { toast(res.error.message); return Promise.reject(res.error); }
        rows = res.data || [];
        var ids = rows.map(function (r) { return r.user_id; });
        var teamIds = rows.map(function (r) { return r.team_id; }).filter(Boolean);
        return Promise.all([
          ids.length ? sb.from('why_profiles').select('user_id, display_name').in('user_id', ids) : { data: [] },
          teamIds.length ? sb.from('why_teams').select('id, name').in('id', teamIds) : { data: [] }
        ]);
      })
      .then(function (pair) {
        var names = {}, teams = {};
        ((pair[0] || {}).data || []).forEach(function (p) { names[p.user_id] = p.display_name; });
        ((pair[1] || {}).data || []).forEach(function (t) { teams[t.id] = t.name; });
        var notes = rows.map(function (r) {
          var n = fromRow(r);
          n.author = names[r.user_id] || n.author || 'Unknown';
          n.team = r.team_id ? teams[r.team_id] : null;
          return n;
        });
        showViewer(page.title || page.path, page.url, notes, function () {
          sb.from('why_pages').delete().eq('id', page.id).then(function (r) {
            if (r.error) { toast(r.error.message); return; }
            current = null; go('notes'); renderLibrary(); toast('Page deleted.');
          });
        });
      });
  }

  /* ---------- exports ---------- */

  function toMarkdown(c) {
    var out = ['# Why this page is built this way', '', c.title ? '**' + c.title + '**' : '', c.url || '', ''];
    c.notes.forEach(function (n, i) {
      var vp = n.viewport && n.viewport.width ? n.viewport.breakpoint + ' at ' + n.viewport.width + 'px' : 'viewport not recorded';
      out.push('## ' + (i + 1) + '. ' + (CATEGORY_LABELS[n.category] || n.category) + ', ' + (n.status || ''), '',
        '`' + n.selector + '`', '', n.body, '',
        'Recorded by ' + (n.author || 'Unknown') + (n.team ? ' (' + n.team + ')' : '') + ', ' + vp +
        (n.createdAt ? ', ' + new Date(n.createdAt).toLocaleDateString() : '') + '.', '');
    });
    return out.join('\n');
  }

  function toCSV(c) {
    var rows = [['index', 'selector', 'category', 'status', 'note', 'author', 'team', 'breakpoint', 'viewport_width', 'created_at', 'url']];
    c.notes.forEach(function (n, i) {
      rows.push([i + 1, n.selector, n.category, n.status, n.body, n.author || '', n.team || '',
      n.viewport ? n.viewport.breakpoint : '', n.viewport ? n.viewport.width : '',
      n.createdAt || '', c.url || '']);
    });
    return rows.map(function (r) {
      return r.map(function (x) { return '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\n');
  }

  function copy(text, label) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(label + ' copied.'); }, function () { fallback(text, label); });
    } else fallback(text, label);
  }
  function fallback(text, label) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast(label + ' copied.'); } catch (e) { toast('Copy failed in this browser.'); }
    ta.remove();
  }
  function download(name, text, type) {
    var blob = new Blob([text], { type: type });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  /* ---------- hash import from the annotator ---------- */

  function decodeHash() {
    var m = location.hash.match(/#import=(.+)$/);
    if (!m) { route(); return; }
    var parsed = null;
    try {
      var b = m[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b.length % 4) b += '=';
      parsed = JSON.parse(decodeURIComponent(escape(atob(b))));
    } catch (e) { toast('That import link could not be read.'); return; }
    mergeLocal(parsed);
    history.replaceState(null, '', location.pathname + '#/notes');
    route();
  }

  /* ---------- boot ---------- */

  function boot() {
    sb.auth.getUser().then(function (res) {
      user = (res.data && res.data.user) || null;
      if (user) {
        ensureToken()
          .then(loadWorkspace)
          .then(absorbLocal)
          .then(loadInbox)
          .then(function () {
            applyAuthState();
            renderWho(); renderAccount(); renderWorkspace(); renderSetup();
            renderLibrary(); renderInbox();
          });
      } else {
        token = null; profile = null; orgs = []; myRole = null;
        applyAuthState();
        renderWho(); renderAccount(); renderLibrary();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('#bookmarklet').addEventListener('click', function (e) {
      e.preventDefault();
      toast('Drag this to your bookmarks bar, or copy the code.');
    });
    $('#copy-bookmarklet').addEventListener('click', function () { copy(bookmarkletCode(), 'Bookmarklet'); });
    $('#copy-snippet').addEventListener('click', function () { copy($('#snippet').textContent, 'Script tag'); });

    $('#import-btn').addEventListener('click', function () {
      var raw = $('#import-text').value.trim();
      if (!raw) { toast('Paste an export first.'); return; }
      try { mergeLocal(JSON.parse(raw)); $('#import-text').value = ''; }
      catch (e) { toast('That is not valid WhyTho JSON.'); }
    });

    $('#viewer-close').addEventListener('click', function () { current = null; go('notes'); });

    $('#mark-all-read').addEventListener('click', function () {
      var ids = inbox.filter(function (n) { return !n.read_at; }).map(function (n) { return n.id; });
      if (!ids.length) { toast('Nothing unread.'); return; }
      markRead(ids).then(function () { renderInbox(); toast('Inbox cleared.'); });
    });
    $('#viewer-delete').addEventListener('click', function () { if (current && current.remove) current.remove(); });

    document.querySelectorAll('[data-export]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!current) return;
        var kind = btn.getAttribute('data-export');
        var stem = 'why-' + String(current.url || 'page').replace(/^https?:\/\//, '').replace(/[^\w.-]/g, '-');
        if (kind === 'json') copy(JSON.stringify({ schema: 'why/1', pages: [{ url: current.url, title: current.title, notes: current.notes }] }, null, 2), 'JSON');
        if (kind === 'md') copy(toMarkdown(current), 'Markdown');
        if (kind === 'csv') { download(stem + '.csv', toCSV(current), 'text/csv'); toast('CSV downloaded.'); }
      });
    });

    ['dragenter', 'dragover'].forEach(function (ev) {
      document.addEventListener(ev, function (e) { e.preventDefault(); document.body.classList.add('dragging'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      document.addEventListener(ev, function (e) { e.preventDefault(); document.body.classList.remove('dragging'); });
    });
    document.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        try { mergeLocal(JSON.parse(r.result)); } catch (err) { toast('That file is not a WhyTho export.'); }
      };
      r.readAsText(f);
    });

    sb.auth.onAuthStateChange(function (evt) {
      if (evt === 'SIGNED_IN' || evt === 'SIGNED_OUT') boot();
    });

    boot();
    decodeHash();
    window.addEventListener('hashchange', decodeHash);
  });
})();
