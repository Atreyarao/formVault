let items = [];
let pendingSave = false; // save was refused because the vault locked; retry after unlock
let gateMode = null;
let pendingBackup = null; // parsed backup file waiting for its password
const $ = (id) => document.getElementById(id);
const list = $("list");
const status = $("status");
const send = (msg) => chrome.runtime.sendMessage(msg);
const flash = (text, ms = 1800) => { status.textContent = text; setTimeout(() => (status.textContent = ""), ms); };

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
    showGate("unlock", "Locked after inactivity. Unlock to save your changes.");
    return false;
  }
  flash(r?.error ? "Couldn't save: " + r.error : "Saved (encrypted)");
  return !r?.error;
}

// ---------- export / import ----------
// Export saves first, so the backup includes what's on screen. The file stays encrypted.
$("export").onclick = async () => {
  if (!(await save())) return;
  const r = await send({ vault: "exportVault" });
  if (!r?.backup) return flash("Couldn't export" + (r?.error ? ": " + r.error : ""));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(r.backup)], { type: "application/json" }));
  a.download = `formvault-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  flash("Exported. The file is encrypted with your current master password.", 5000);
};

const pickBackup = (mode) => {
  const input = $("importFile");
  input.dataset.mode = mode;
  input.value = "";
  input.click();
};
$("import").onclick = () => pickBackup("import");
$("restore").onclick = () => pickBackup("restore");
$("importFile").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  let backup = null;
  try { backup = JSON.parse(await f.text()); } catch {}
  if (backup?.format !== "formvault-backup" || !backup.vault) {
    const text = "That file isn't a FormVault backup.";
    return $("editor").hidden ? ($("gateMsg").textContent = text) : flash(text, 4000);
  }
  pendingBackup = backup;
  showGate(e.target.dataset.mode, null, backup.exportedAt);
};

// ---------- lock screen ----------
function showGate(mode, note, backupDate) {
  gateMode = mode;
  list.innerHTML = ""; // don't leave decrypted values on screen
  $("editor").hidden = true;
  $("gate").hidden = false;
  const setup = mode === "setup", change = mode === "change", isNew = setup || change;
  const fromBackup = mode === "import" || mode === "restore";
  const made = backupDate ? ` (exported ${new Date(backupDate).toLocaleString()})` : "";
  $("gateTitle").textContent = setup ? "Set a master password" : change ? "Change master password"
    : mode === "import" ? "Import a backup" : mode === "restore" ? "Restore from a backup" : "Unlock saved details";
  $("gateSub").textContent = note || (setup
    ? "Your details and files will be encrypted with this password. There's no way to recover it if you forget it."
    : change ? "Your saved details will be re-encrypted with the new password."
    : mode === "import" ? `Enter the master password this backup${made} was made with. Merge adds what's missing and ` +
      "keeps your current values. Replace swaps everything for the backup. Unsaved changes on this page are discarded."
    : mode === "restore" ? `Enter the master password this backup${made} was made with. It becomes your master password here too.`
    : "Enter your master password. It locks again after 15 minutes of inactivity and when Chrome closes.");
  $("pw0Wrap").hidden = !change;
  $("pw2Wrap").hidden = !isNew;
  $("pwLabel").textContent = change ? "New password" : fromBackup ? "Backup's master password" : "Master password";
  $("pw").autocomplete = isNew ? "new-password" : "current-password";
  $("gateBtn").textContent = setup ? "Encrypt and save" : change ? "Change password"
    : mode === "import" ? "Merge into my details" : mode === "restore" ? "Restore" : "Unlock";
  $("gateAlt").textContent = "Replace everything";
  $("gateAlt").hidden = mode !== "import";
  $("cancel").hidden = !(change || fromBackup);
  $("forgot").hidden = mode !== "unlock";
  $("restore").hidden = !setup;
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
  if (mode === "import" || mode === "restore") return importBackup(e.submitter === $("gateAlt"), password);
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

async function importBackup(replace, password) {
  const msg = $("gateMsg");
  if (replace && !confirm("Replace ALL your saved details and files with the ones in this backup? This can't be undone.")) return;
  $("gateBtn").disabled = $("gateAlt").disabled = true;
  msg.textContent = "Decrypting backup…";
  const r = await send({ vault: "importVault", backup: pendingBackup, password, mode: replace ? "replace" : "merge" });
  $("gateBtn").disabled = $("gateAlt").disabled = false;
  if (r?.locked) return showGate("unlock", "Locked after inactivity. Unlock, then import again.");
  if (r?.error) return (msg.textContent = r.error);
  pendingBackup = null;
  items = r.items;
  showEditor();
  flash(r.summary, 6000);
}

$("changePw").onclick = () => showGate("change");
$("cancel").onclick = () => {
  pendingBackup = null;
  if (gateMode === "restore") showGate("setup");
  else showEditor();
};
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
