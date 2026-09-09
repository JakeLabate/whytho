// Runs only on whytho.jakelabate.com. Two jobs: tell the app the extension exists,
// and accept the annotator token from it so nobody has to copy and paste one.
document.documentElement.setAttribute('data-whytho-extension', chrome.runtime.getManifest().version);

window.addEventListener('message', function (e) {
  if (e.source !== window || !e.data || e.data.type !== 'whytho:connect') return;
  chrome.runtime.sendMessage(
    { type: 'whytho:token', token: e.data.token, account: e.data.account },
    function () {
      window.postMessage({ type: 'whytho:connected', version: chrome.runtime.getManifest().version }, '*');
    }
  );
});

chrome.storage.sync.get('token').then(function (s) {
  window.postMessage({ type: 'whytho:state', connected: !!s.token }, '*');
});
