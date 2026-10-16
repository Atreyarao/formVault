const openOptions = () => { chrome.runtime.openOptionsPage(); window.close(); };

document.getElementById("fill").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { action: "fill-all" }).catch(() => {});
  window.close();
};
document.getElementById("manage").onclick = openOptions;

const lockBtn = document.getElementById("lock");
chrome.runtime.sendMessage({ vault: "status" }).then((s) => {
  if (!s.hasVault) { lockBtn.textContent = "Set master password"; lockBtn.onclick = openOptions; }
  else if (s.unlocked) {
    lockBtn.textContent = "Lock now";
    lockBtn.onclick = async () => { await chrome.runtime.sendMessage({ vault: "lock" }); window.close(); };
  } else { lockBtn.textContent = "Locked. Click to unlock"; lockBtn.onclick = openOptions; }
});

const mod = /Mac/i.test(navigator.platform) ? "Ctrl+Shift" : "Alt+Shift";
document.getElementById("keys").textContent =
  `${mod}+F fills the page. ${mod}+S opens the list under the focused field. Or right-click any field.`;
