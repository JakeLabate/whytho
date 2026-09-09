function paint(connected, account) {
  document.getElementById('dot').className = 'dot' + (connected ? ' on' : '');
  document.getElementById('state').textContent = connected
    ? (account ? 'Signed in as ' + account : 'Connected to your account')
    : 'Not connected, notes stay in this browser';
  document.getElementById('connect').textContent = connected ? 'Reconnect my account' : 'Connect my account';
}

chrome.storage.sync.get(['token', 'account']).then(function (s) {
  paint(!!s.token, s.account);
});

document.getElementById('start').addEventListener('click', function () {
  chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
    if (!tabs[0]) return;
    chrome.runtime.sendMessage({ type: 'whytho:run', tabId: tabs[0].id }, function () { window.close(); });
  });
});

document.getElementById('connect').addEventListener('click', function () {
  chrome.tabs.create({ url: 'https://whytho.jakelabate.com/#/setup' });
  window.close();
});
