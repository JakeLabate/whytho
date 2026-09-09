// WhyTho background worker.
// The annotator itself is packaged with the extension rather than fetched, because
// manifest v3 forbids running remote code. It is injected into the page world so it
// can read the DOM and talk to the sync endpoint as the page's own origin would.

async function tokenFor() {
  var stored = await chrome.storage.sync.get('token');
  return stored.token || '';
}

function inject(token) {
  if (window.__why__) { window.__why__.toggle(); return 'toggled'; }
  var s = document.createElement('script');
  s.src = chrome.runtime.getURL('annotator.js');
  if (token) s.setAttribute('data-why-token', token);
  s.setAttribute('data-why-source', 'extension');
  (document.body || document.documentElement).appendChild(s);
  return 'started';
}

async function run(tabId) {
  var token = await tokenFor();
  try {
    var out = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'ISOLATED',
      func: inject,
      args: [token]
    });
    return out && out[0] ? out[0].result : null;
  } catch (e) {
    return { error: e.message };
  }
}

chrome.commands.onCommand.addListener(function (command, tab) {
  if (command === 'toggle-whytho' && tab && tab.id) run(tab.id);
});

chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
  if (msg && msg.type === 'whytho:run' && msg.tabId) {
    run(msg.tabId).then(function (r) { reply({ ok: true, result: r }); });
    return true;
  }
  if (msg && msg.type === 'whytho:token') {
    chrome.storage.sync.set({ token: msg.token, account: msg.account || '' })
      .then(function () { reply({ ok: true }); });
    return true;
  }
});
