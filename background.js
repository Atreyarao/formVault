importScripts("crypto.js");

// Locks after this much inactivity. It also locks when Chrome closes (session storage is memory-only).
const IDLE_LOCK_MS = 15 * 60 * 1000;

const DEFAULTS = [
  ["Full name", "full name,fullname,your name,name", ""],
  ["First name", "first name,firstname,fname,given", ""],
  ["Last name", "last name,lastname,lname,surname,family", ""],
  ["Email", "email address,email,e-mail,mail", ""],
  ["Phone", "phone,mobile,tel,contact number", ""],
  ["Address", "address,street", ""],
  ["City", "city,town", ""],
  ["State", "state,province,region", ""],
  ["Postal code", "zip,postal,pincode,pin code", ""],
  ["Company", "company,organization,employer", ""],
  ["LinkedIn", "linkedin", ""],
  ["Website", "website,portfolio,url", ""],
  ["Gender", "gender,sex", ""],
  ["Date of birth", "date of birth,birth,dob,birthday", "", "date"],
  ["Country", "country,nationality", ""],
  ["Years of experience", "years of experience,experience,yoe", "", "number"],
  ["Resume (file)", "resume,cv,curriculum", "", "file"]
];
const defaultItems = () => DEFAULTS.map(([label, keywords, value, type], i) => ({
  id: "d" + i, label, keywords, value, type: type || "text"
}));

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  chrome.contextMenus.removeAll(() => chrome.contextMenus.create({
    id: "qff-pick", title: "Fill with FormVault…", contexts: ["editable", "page", "frame"]
  }));
  // New installs, and older versions with unencrypted data, need a master password.
  const { vault } = await chrome.storage.local.get("vault");
  if (reason === "install" || (reason === "update" && !vault)) chrome.runtime.openOptionsPage();
});

// ---------- vault ----------
// The derived key lives only in chrome.storage.session: in memory, cleared when Chrome quits,
// and not readable by content scripts.
const lock = () => chrome.storage.session.clear();

async function getKey(touch = true) {
  const { key, lastUsed } = await chrome.storage.session.get(["key", "lastUsed"]);
  if (!key) return null;
  if (Date.now() - lastUsed > IDLE_LOCK_MS) { await lock(); return null; }
  if (touch) await chrome.storage.session.set({ lastUsed: Date.now() });
  return key;
}
const unlockWith = (key) => chrome.storage.session.set({ key, lastUsed: Date.now() });

// Closing the last window counts as closing Chrome (on macOS the app keeps running without windows).
chrome.windows.onRemoved.addListener(async () => {
  if (!(await chrome.windows.getAll()).length) lock();
});

const handlers = {
  async status() {
    const { vault, items } = await chrome.storage.local.get(["vault", "items"]);
    return { hasVault: !!vault, hasPlain: !!items, unlocked: !!(await getKey(false)) };
  },
  async setup({ password }) {
    const { vault, items } = await chrome.storage.local.get(["vault", "items"]);
    if (vault) return { error: "A master password is already set" };
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
    const enc = await encryptJSON(key, items || defaultItems());
    await chrome.storage.local.set({ vault: { salt: toB64(salt), iter: PBKDF2_ITERATIONS, ...enc } });
    await chrome.storage.local.remove("items"); // drop the old plaintext copy
    await unlockWith(key);
    return {};
  },
  async unlock({ password }) {
    const { vault } = await chrome.storage.local.get("vault");
    if (!vault) return { error: "No master password set yet" };
    const key = await deriveKey(password, fromB64(vault.salt), vault.iter);
    try { await decryptJSON(key, vault); } catch { return { error: "Wrong password" }; }
    await unlockWith(key);
    return {};
  },
  async changePassword({ password, newPassword }) {
    const { vault } = await chrome.storage.local.get("vault");
    if (!vault) return { error: "No master password set yet" };
    const oldKey = await deriveKey(password, fromB64(vault.salt), vault.iter);
    let items;
    try { items = await decryptJSON(oldKey, vault); } catch { return { error: "Current password is wrong" }; }
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(newPassword, salt, PBKDF2_ITERATIONS);
    const enc = await encryptJSON(key, items);
    await chrome.storage.local.set({ vault: { salt: toB64(salt), iter: PBKDF2_ITERATIONS, ...enc } });
    await unlockWith(key);
    return {};
  },
  // Forgot password: the data can't be decrypted without it, so wipe everything and start over.
  async reset() {
    await chrome.storage.local.remove(["vault", "items"]);
    await lock();
    return {};
  },
  async lock() { await lock(); return {}; },
  async getItems() {
    const { vault } = await chrome.storage.local.get("vault");
    if (!vault) return { locked: true, setup: true };
    const key = await getKey();
    if (!key) return { locked: true };
    return { items: await decryptJSON(key, vault) };
  },
  async saveItems({ items }) {
    const key = await getKey();
    if (!key) return { locked: true };
    const { vault } = await chrome.storage.local.get("vault");
    await chrome.storage.local.set({ vault: { ...vault, ...(await encryptJSON(key, items)) } });
    return {};
  }
};

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  const fn = handlers[msg.vault];
  if (!fn) return;
  // Content scripts may only read items; everything else must come from the extension's own pages.
  const fromExtensionPage = sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(""));
  if (msg.vault !== "getItems" && !fromExtensionPage) return;
  fn(msg).then(send, (e) => send({ error: e.message }));
  return true;
});

// Right-click: open the picker (all saved details) for the field that was right-clicked, in that frame.
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "qff-pick" || !tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { action: "show-picker", fromMenu: true }, { frameId: info.frameId ?? 0 }).catch(() => {});
});

// From content scripts: warnings raised in iframes are shown as a modal in the top frame.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.action === "warn" && sender.tab?.id) {
    chrome.tabs.sendMessage(sender.tab.id, { action: "show-modal", msg: msg.msg, unlock: msg.unlock }, { frameId: 0 })
      .catch(() => {});
  } else if (msg.action === "open-options") chrome.runtime.openOptionsPage();
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const action = command === "fill-all" ? "fill-all" : "show-picker";
  chrome.tabs.sendMessage(tab.id, { action }).catch(() => {});
});
