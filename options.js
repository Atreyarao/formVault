let items = [];
let pendingSave = false; // save was refused because the vault locked; retry after unlock
let gateMode = null;
const $ = (id) => document.getElementById(id);
const list = $("list");
const status = $("status");
const send = (msg) => chrome.runtime.sendMessage(msg);

const toDataUrl = (file) => new Promise((res, rej) => {
  const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file);
});

function render() {
  list.innerHTML = "";
  items.forEach((it, i) => {
    const d = document.createElement("div");
    d.className = "item";
    d.innerHTML = `
      <div><label>Label</label><input data-k="label">${it.type === "file" ? "" : `
        <label class="mt">Type</label><select class="type">
          <option value="text">Text / choice</option><option value="number">Number</option><option value="date">Date</option>
        </select>`}</div>
      <div></div>
      <button class="del">Delete</button>
      <div class="full"><label>Keywords (comma separated)</label><input data-k="keywords"></div>`;
    const valueBox = d.children[1];
    if (it.type === "file") {
      valueBox.innerHTML = `<label>File</label><input type="file">
        <div class="filemeta">${it.fileName ? "Saved: " + it.fileName : "No file saved yet"}</div>`;
      valueBox.querySelector("input").onchange = async (e) => {
        const f = e.target.files[0]; if (!f) return;
        it.dataUrl = await toDataUrl(f); it.fileName = f.name; it.fileType = f.type;
        valueBox.querySelector(".filemeta").textContent = "Ready to save: " + f.name;
      };
    } else {
      valueBox.innerHTML = it.type === "date" ? `<label>Date</label><input type="date" data-k="value">`
        : it.type === "number" ? `<label>Number</label><input type="number" step="any" data-k="value">`
        : `<label>Value</label><textarea data-k="value"></textarea>
           <div class="filemeta">For dropdowns and radio buttons, just save the answer (e.g. Male). It's matched to the closest option.</div>`;
      const type = d.querySelector(".type");
      type.value = it.type;
      type.onchange = () => {
        it.type = type.value;
        // drop values the new input can't show
        if (it.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(it.value)) it.value = "";
        if (it.type === "number" && isNaN(Number(it.value))) it.value = "";
        render();
      };
    }
    d.querySelectorAll("[data-k]").forEach((inp) => {
      inp.value = it[inp.dataset.k] || "";
      inp.oninput = () => (it[inp.dataset.k] = inp.value);
    });
    d.querySelector(".del").onclick = () => { items.splice(i, 1); render(); };
    list.appendChild(d);
  });
}

const add = (type) => { items.push({ id: "i" + Date.now(), label: "", keywords: "", value: "", type }); render(); };
$("addText").onclick = () => add("text");
$("addNumber").onclick = () => add("number");
$("addDate").onclick = () => add("date");
$("addFile").onclick = () => add("file");
$("save").onclick = save;
$("lock").onclick = async () => { await send({ vault: "lock" }); };

async function save() {
  const r = await send({ vault: "saveItems", items });
  if (r?.locked) {
    pendingSave = true;
    return showGate("unlock", "Locked after inactivity. Unlock to save your changes.");
  }
  status.textContent = r?.error ? "Couldn't save: " + r.error : "Saved (encrypted)";
  setTimeout(() => (status.textContent = ""), 1800);
}

// ---------- lock screen ----------
function showGate(mode, note) {
  gateMode = mode;
  list.innerHTML = ""; // don't leave decrypted values on screen
  $("editor").hidden = true;
  $("gate").hidden = false;
  const setup = mode === "setup", change = mode === "change", isNew = setup || change;
  $("gateTitle").textContent = setup ? "Set a master password" : change ? "Change master password" : "Unlock saved details";
  $("gateSub").textContent = note || (setup
    ? "Your details and files will be encrypted with this password. There's no way to recover it if you forget it."
    : change ? "Your saved details will be re-encrypted with the new password."
    : "Enter your master password. It locks again after 15 minutes of inactivity and when Chrome closes.");
  $("pw0Wrap").hidden = !change;
  $("pw2Wrap").hidden = !isNew;
  $("pwLabel").textContent = change ? "New password" : "Master password";
  $("pw").autocomplete = isNew ? "new-password" : "current-password";
  $("gateBtn").textContent = setup ? "Encrypt and save" : change ? "Change password" : "Unlock";
  $("cancel").hidden = !change;
  $("forgot").hidden = mode !== "unlock";
  $("gateMsg").textContent = "";
  $("pw0").value = $("pw").value = $("pw2").value = "";
  (change ? $("pw0") : $("pw")).focus();
}

function showEditor() {
  $("gate").hidden = true;
  $("editor").hidden = false;
  render();
}

$("gateForm").onsubmit = async (e) => {
  e.preventDefault();
  const mode = gateMode, password = $("pw").value, msg = $("gateMsg");
  if (mode === "setup" || mode === "change") {
    if (password.length < 8) return (msg.textContent = "Use at least 8 characters");
    if (password !== $("pw2").value) return (msg.textContent = "Passwords don't match");
  }
  $("gateBtn").disabled = true;
  msg.textContent = mode === "unlock" ? "Unlocking…" : "Encrypting…";
  const r = mode === "change"
    ? await send({ vault: "changePassword", password: $("pw0").value, newPassword: password })
    : await send({ vault: mode, password });
  $("gateBtn").disabled = false;
  if (r?.error) return (msg.textContent = r.error);
  $("pw0").value = $("pw").value = $("pw2").value = "";
  if (mode === "change") {
    showEditor(); // unsaved edits are still in memory
    status.textContent = "Password changed";
    return setTimeout(() => (status.textContent = ""), 1800);
  }
  if (pendingSave) { pendingSave = false; showEditor(); return save(); }
  boot();
};

$("changePw").onclick = () => showGate("change");
$("cancel").onclick = showEditor;
$("forgot").onclick = async () => {
  if (!confirm("Without the password your saved details can't be decrypted.\n\n" +
    "This permanently deletes ALL saved details and files and lets you set a new password. Continue?")) return;
  await send({ vault: "reset" });
  items = []; pendingSave = false;
  boot();
};

// Locked from the popup, by closing Chrome windows, or by inactivity: hide the data here too.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.key && !changes.key.newValue && !$("editor").hidden) showGate("unlock");
});

async function boot() {
  const s = await send({ vault: "status" });
  if (!s.hasVault) return showGate("setup", s.hasPlain
    ? "Set a master password to encrypt the details you already saved. There's no way to recover it if you forget it."
    : undefined);
  const r = await send({ vault: "getItems" });
  if (!r?.items) return showGate("unlock");
  items = r.items;
  showEditor();
}
boot();
