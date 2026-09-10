/* WhyTho OAuth consent screen.
   Claude sends the person here, this page proves who they are with their existing
   WhyTho session, then asks the edge function for an authorization code and hands it
   back. The code is what Claude exchanges for a token, so nothing secret lives here. */
(function () {
  'use strict';

  var CFG = window.WHY_CONFIG;
  var ISSUE = CFG.supabaseUrl.replace(/\/$/, '') + '/functions/v1/why-mcp/issue-code';
  var sb = window.supabase.createClient(CFG.supabaseUrl, CFG.publishableKey);
  var $ = function (s) { return document.querySelector(s); };
  var params = new URLSearchParams(location.search);

  var req = {
    client_id: params.get('client_id') || '',
    redirect_uri: params.get('redirect_uri') || '',
    state: params.get('state') || '',
    code_challenge: params.get('code_challenge') || '',
    code_challenge_method: params.get('code_challenge_method') || 'S256',
    scope: params.get('scope') || 'read',
    response_type: params.get('response_type') || 'code'
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg; t.hidden = false;
    setTimeout(function () { t.hidden = true; }, 4000);
  }

  function bail(message) {
    $('#stage').innerHTML = '<h1>That request is not valid</h1><p class="sub">' + esc(message) +
      '</p><p><a class="btn quiet" href="./">Back to WhyTho</a></p>';
  }

  function deny() {
    if (!req.redirect_uri) { bail('There is nowhere to send you back to.'); return; }
    var u = new URL(req.redirect_uri);
    u.searchParams.set('error', 'access_denied');
    if (req.state) u.searchParams.set('state', req.state);
    location.href = u.toString();
  }

  function signIn() {
    fetch(CFG.supabaseUrl.replace(/\/$/, '') + '/auth/v1/settings', { headers: { apikey: CFG.publishableKey } })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        var ext = (s && s.external) || {};
        var ids = Object.keys(CFG.providers).filter(function (id) { return ext[id] === true; });
        if (!ids.length) ids = ['github'];
        paint(ids);
      }, function () { paint(['github']); });

    function paint(ids) {
      $('#stage').innerHTML =
        '<h1>Sign in to continue</h1>' +
        '<p class="sub">An application is asking to reach your WhyTho notes. Sign in and you will be asked to approve it.</p>' +
        '<div class="grant">' + ids.map(function (id) {
          return '<button class="btn oauth" data-provider="' + id + '">Continue with ' +
            esc(CFG.providers[id] || id) + '</button>';
        }).join('') + '</div>' +
        '<p class="sub">Or open <a href="./">WhyTho</a>, sign in there, and come back to this page.</p>';

      document.querySelectorAll('[data-provider]').forEach(function (b) {
        b.addEventListener('click', function () {
          sb.auth.signInWithOAuth({
            provider: b.getAttribute('data-provider'),
            options: { redirectTo: location.href }
          }).then(function (r) { if (r.error) toast(r.error.message); });
        });
      });
    }
  }

  function consent(user, profile) {
    var name = (profile && profile.display_name) || user.email;
    $('#stage').innerHTML =
      '<h1>Let Claude use your WhyTho notes?</h1>' +
      '<p class="sub">This connects an application to the account below. You can disconnect it at any time from the API tab.</p>' +
      '<div class="who-box"><b>' + esc(name) + '</b><br><span class="sub">' + esc(user.email) + '</span></div>' +
      '<div class="grant">' +
      '<label class="on" id="l-read"><input type="radio" name="scope" value="read" checked>' +
      '<span><b>Read only</b><span>Search and read notes, pages, teams and your inbox. Nothing can be changed.</span></span></label>' +
      '<label id="l-write"><input type="radio" name="scope" value="read write">' +
      '<span><b>Read and write</b><span>Also create, edit and delete your own notes. Nothing else in the organization can be changed.</span></span></label>' +
      '</div>' +
      '<ul class="scopes"><li>It sees the workspace you are active in, which for a shared organization means everyone\'s notes.</li>' +
      '<li>Notes it writes are marked as coming from an API rather than from someone looking at the page.</li></ul>' +
      '<div class="consent-actions"><button class="btn" id="allow">Allow</button>' +
      '<button class="btn quiet" id="deny">Cancel</button></div>';

    document.querySelectorAll('.grant input').forEach(function (i) {
      i.addEventListener('change', function () {
        document.querySelectorAll('.grant label').forEach(function (l) {
          l.classList.toggle('on', l.contains(i) && i.checked);
        });
      });
    });

    $('#deny').addEventListener('click', deny);
    $('#allow').addEventListener('click', function () {
      var picked = document.querySelector('.grant input:checked').value;
      $('#allow').disabled = true;
      $('#allow').textContent = 'Connecting';

      sb.auth.getSession().then(function (s) {
        var jwt = s.data.session && s.data.session.access_token;
        return fetch(ISSUE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt },
          body: JSON.stringify({
            client_id: req.client_id,
            redirect_uri: req.redirect_uri,
            scope: picked,
            code_challenge: req.code_challenge,
            code_challenge_method: req.code_challenge_method
          })
        });
      }).then(function (r) { return r.json(); }).then(function (res) {
        if (res.error || !res.code) {
          $('#allow').disabled = false;
          $('#allow').textContent = 'Allow';
          toast(res.error || 'Could not issue a code.');
          return;
        }
        var u = new URL(req.redirect_uri);
        u.searchParams.set('code', res.code);
        if (req.state) u.searchParams.set('state', req.state);
        location.href = u.toString();
      }, function () {
        $('#allow').disabled = false;
        $('#allow').textContent = 'Allow';
        toast('Could not reach WhyTho. Try again.');
      });
    });
  }

  if (req.response_type !== 'code' || !req.client_id || !req.redirect_uri) {
    bail('The application did not send the parameters an authorization request needs.');
    return;
  }

  sb.auth.getUser().then(function (res) {
    var user = res.data && res.data.user;
    if (!user) { signIn(); return; }
    sb.from('why_profiles').select('display_name').eq('user_id', user.id).maybeSingle()
      .then(function (p) { consent(user, p.data); });
  });
})();
