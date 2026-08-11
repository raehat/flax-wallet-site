// Flax service worker.
// Keeps the extension alive for future push-style features (price feeds,
// yield accrual notifications). All wallet logic runs in the popup.
chrome.runtime.onInstalled.addListener(() => {
  console.log("Flax installed");
});
