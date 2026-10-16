(() => {
  if (window.__qffLoaded) return;
  window.__qffLoaded = true;

  // Decrypted items come from the background script; returns null while locked.
  async function getItems(announce) {
    const r = await chrome.runtime.sendMessage({ vault: "getItems" }).catch(() => null);
    if (r?.items) return r.items;
    if (announce) warn(r?.setup ? "Set a master password in FormVault before filling forms."
      : "FormVault is locked. Unlock it to fill this form.", { unlock: true });
    return null;
  }
  const isFilled = (it) => it.type === "file" ? !!it.dataUrl : !!String(it.value ?? "").trim();

  // ---------- values, aliases & dates ----------
  const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const pad = (n) => String(n).padStart(2, "0");
  const MONTHS = ["january", "february", "march", "april", "may", "june", "july",
    "august", "september", "october", "november", "december"];
  const US_STATES = "al alabama|ak alaska|az arizona|ar arkansas|ca california|co colorado|ct connecticut|de delaware|" +
    "dc district of columbia|fl florida|ga georgia|hi hawaii|id idaho|il illinois|in indiana|ia iowa|ks kansas|ky kentucky|" +
    "la louisiana|me maine|md maryland|ma massachusetts|mi michigan|mn minnesota|ms mississippi|mo missouri|mt montana|" +
    "ne nebraska|nv nevada|nh new hampshire|nj new jersey|nm new mexico|ny new york|nc north carolina|nd north dakota|" +
    "oh ohio|ok oklahoma|or oregon|pa pennsylvania|ri rhode island|sc south carolina|sd south dakota|tn tennessee|tx texas|" +
    "ut utah|vt vermont|va virginia|wa washington|wv west virginia|wi wisconsin|wy wyoming";
  // Values that mean the same thing in dropdowns / radio buttons (compared after norm()).
  const ALIAS_GROUPS = [
    "male|m|man|boy|he him",
    "female|f|woman|girl|she her",
    "non binary|nonbinary|genderqueer|they them",
    "prefer not to say|prefer not to answer|decline to answer|decline to self identify|i don t wish to answer",
    "yes|y|true|1",
    "no|n|false|0",
    "united states|usa|us|u s|u s a|united states of america|america",
    "united kingdom|uk|u k|gb|great britain|britain",
    "united arab emirates|uae",
    ...US_STATES.split("|").map((p) => p.replace(" ", "|"))
  ].map((g) => g.split("|"));
  const aliasMap = new Map();
  for (const g of ALIAS_GROUPS) for (const a of g) aliasMap.set(a, g);
  const aliases = (v) => aliasMap.get(v) || [v];

  function parseDate(v) {
    const s = String(v ?? "").trim();
    if (!/\d{4}/.test(s)) return null;
    const iso = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
    if (iso) return { y: +iso[1], m: +iso[2], d: +(iso[3] || 1) };
    const t = Date.parse(s);
    if (isNaN(t)) return null;
    const dt = new Date(t);
    return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
  }
  const formatDate = (p, fmt) => fmt.replace(/yyyy|yy|mm|dd/gi, (t) =>
    ({ yyyy: p.y, yy: pad(p.y % 100), mm: pad(p.m), dd: pad(p.d) })[t.toLowerCase()]);
  const DATE_INPUT_FORMATS = { date: "yyyy-mm-dd", month: "yyyy-mm", "datetime-local": "yyyy-mm-ddT00:00" };

  // Text fields: follow a hint like "MM/DD/YYYY" in the placeholder, otherwise the browser locale.
  function textDateFormat(el) {
    const hint = [el.placeholder, el.title, el.getAttribute("aria-label"), el.getAttribute("data-date-format")]
      .join(" ").toLowerCase();
    const m = hint.match(/(dd|mm|yyyy|yy)([\/\-. ])(dd|mm|yyyy|yy)(?:\2(dd|mm|yyyy|yy))?/);
    if (m) return m[0];
    if (el.classList.contains("hasDatepicker")) return "mm/dd/yyyy"; // jQuery UI datepicker default
    return /^en-us/i.test(navigator.language) ? "mm/dd/yyyy" : "dd/mm/yyyy";
  }

  const displayValue = (it) => {
    if (it.type === "file") return it.fileName;
    const d = it.type === "date" && parseDate(it.value);
    return d ? new Date(d.y, d.m - 1, d.d).toLocaleDateString() : it.value;
  };

  // ---------- field detection ----------
  const SKIP_TYPES = new Set(["hidden", "submit", "button", "image", "reset", "password"]);
  // Read-only date fields are usually pop-up calendars (e.g. jQuery UI) that block typing; code can still set them.
  const isDatePicker = (el) => /date|dob|birth/i.test(`${el.className} ${el.name} ${el.id}`);
  const fillable = (el) => el?.matches?.("input, textarea, select") && !SKIP_TYPES.has(el.type) &&
    !el.disabled && (!el.readOnly || isDatePicker(el));

  function fieldKind(el) {
    if (el.tagName === "SELECT") return "select";
    if (el.tagName === "TEXTAREA") return "text";
    if (el.type === "file" || el.type === "radio" || el.type === "checkbox") return el.type;
    if (["date", "month", "week", "datetime-local", "time"].includes(el.type)) return "date";
    if (el.type === "number" || el.type === "range") return "number";
    return "text";
  }

  const textOfIds = (ids) => (ids || "").split(" ").map((id) => document.getElementById(id)?.textContent);

  function fieldSignature(el) {
    const parts = [el.name, el.id, el.placeholder, el.autocomplete, el.title,
      el.getAttribute("aria-label"), el.getAttribute("data-testid")];
    if (el.type === "radio") {
      // A radio's own label is the answer ("Male"); the question lives on the group.
      parts.push(el.closest("fieldset")?.querySelector("legend")?.textContent);
      const grp = el.closest("[role=radiogroup],[role=group]");
      if (grp) parts.push(grp.getAttribute("aria-label"), ...textOfIds(grp.getAttribute("aria-labelledby")));
    } else {
      if (el.labels) el.labels.forEach((l) => parts.push(l.textContent));
      parts.push(...textOfIds(el.getAttribute("aria-labelledby")));
    }
    return parts.filter(Boolean).join(" ").replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase().replace(/[_\-]+/g, " ");
  }
  const normKeyword = (k) => String(k || "").toLowerCase().replace(/[_\-]+/g, " ").trim();

  // ---------- choices (dropdowns & radio groups) ----------
  function radioGroup(el) {
    if (!el.name) return [el];
    const scope = el.form || el.getRootNode();
    return [...scope.querySelectorAll(`input[type=radio][name="${CSS.escape(el.name)}"]`)];
  }
  const labelText = (el) => [...(el.labels || [])].map((l) => l.textContent).join(" ") ||
    el.getAttribute("aria-label") || el.value;
  const choicesOf = (el) => el.tagName === "SELECT"
    ? [...el.options].filter((o) => !o.disabled && o.value !== "").map((o) => ({ el: o, text: o.text, value: o.value }))
    : radioGroup(el).map((r) => ({ el: r, text: labelText(r), value: r.value }));

  // Best option for any of the candidate values: exact/alias > same number > whole word > prefix.
  function pickOption(options, cands) {
    let best = null, bestScore = 0;
    for (const raw of cands) {
      const v = norm(raw);
      if (!v) continue;
      const alts = aliases(v), num = Number(v);
      for (const o of options) {
        for (const [t, bonus] of [[norm(o.text), 1], [norm(o.value), 0]]) {
          if (!t) continue;
          let s = 0;
          if (alts.includes(t)) s = 100;
          else if (!isNaN(num) && Number(t) === num) s = 90;
          else if (alts.some((a) => a.length > 1 && ` ${t} `.includes(` ${a} `))) s = 60 - t.length / 100;
          else if (v.length >= 3 && t.startsWith(v)) s = 40;
          if (s && s + bonus > bestScore) { best = o; bestScore = s + bonus; }
        }
      }
    }
    return best;
  }

  // Values to try against a choice field. Dates can fill separate day / month / year dropdowns.
  function candidates(el, item, date) {
    if (item.type !== "date" || !date) return [item.value];
    const sig = fieldSignature(el);
    if (/year|\byy(yy)?\b/.test(sig)) return [date.y, pad(date.y % 100)];
    if (/month|\bmm\b/.test(sig)) return [date.m, MONTHS[date.m - 1], MONTHS[date.m - 1].slice(0, 3)];
    if (/day|\bdd\b/.test(sig)) return [date.d];
    return [formatDate(date, "yyyy-mm-dd"), formatDate(date, textDateFormat(el))];
  }

  // What a saved item would put into this field, or null if it can't fill it.
  function resolve(el, item) {
    const kind = fieldKind(el);
    if ((kind === "file") !== (item.type === "file")) return null;
    if (kind === "file") return { file: true };
    const raw = String(item.value ?? "").trim();
    const date = item.type === "date" || kind === "date" ? parseDate(raw) : null;
    switch (kind) {
      case "date": {
        const fmt = DATE_INPUT_FORMATS[el.type];
        return date && fmt ? { value: formatDate(date, fmt) } : null;
      }
      case "number": {
        const n = raw.replace(/[^\d.\-]/g, ""); // "5 years" -> "5"
        return n && !isNaN(n) ? { value: n } : null;
      }
      case "select":
      case "radio": {
        const opt = pickOption(choicesOf(el), candidates(el, item, date));
        return opt ? { option: opt } : null;
      }
      case "checkbox": {
        const v = aliases(norm(raw))[0];
        return v === "yes" || v === "no" ? { checked: v === "yes" } : null;
      }
      default:
        return { value: date && item.type === "date" ? formatDate(date, textDateFormat(el)) : raw };
    }
  }

  function bestMatch(el, items) {
    const sig = fieldSignature(el), kind = fieldKind(el);
    let best = null, bestScore = 0;
    for (const it of items) {
      if (!isFilled(it)) continue;
      let score = 0;
      for (const k of [it.label, ...(it.keywords || "").split(",")]) {
        const kw = normKeyword(k);
        if (kw.length > 1 && sig.includes(kw)) score = Math.max(score, kw.length);
      }
      if (!score) continue;
      if (it.type === kind) score += 0.5; // e.g. a date field prefers a date item
      if (score > bestScore && resolve(el, it)) { best = it; bestScore = score; }
    }
    return best;
  }

  // ---------- filling ----------
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  }

  function fire(el) {
    ["input", "change", "blur"].forEach((t) => el.dispatchEvent(new Event(t, { bubbles: true })));
  }

  async function fillField(el, item) {
    const r = resolve(el, item);
    if (!r) return false;
    if (r.file) {
      const blob = await (await fetch(item.dataUrl)).blob();
      const file = new File([blob], item.fileName || "file", { type: item.fileType || blob.type });
      const dt = new DataTransfer();
      dt.items.add(file);
      el.files = dt.files;
      fire(el);
    } else if (r.option) {
      if (el.tagName === "SELECT") { setNativeValue(el, r.option.el.value); fire(el); }
      else if (!r.option.el.checked) r.option.el.click(); // click so page scripts see a real change
    } else if ("checked" in r) {
      if (el.checked !== r.checked) el.click();
    } else {
      el.focus();
      setNativeValue(el, r.value);
      fire(el);
    }
    return true;
  }

  function alreadyFilled(el, seenGroups) {
    switch (fieldKind(el)) {
      case "file": return false;
      case "radio": {
        const g = radioGroup(el);
        if (seenGroups.has(g[0])) return true;
        seenGroups.add(g[0]);
        return g.some((r) => r.checked);
      }
      case "checkbox": return el.checked;
      case "select": return el.selectedIndex > 0 && el.value !== "";
      default: return !!el.value;
    }
  }

  async function fillAll() {
    const items = await getItems(window === top);
    if (!items) return;
    const seenGroups = new Set();
    let count = 0;
    for (const el of document.querySelectorAll("input, textarea, select")) {
      if (!fillable(el) || alreadyFilled(el, seenGroups)) continue; // don't overwrite what's already there
      const item = bestMatch(el, items);
      if (item && await fillField(el, item)) count++;
    }
    if (count) toast(`Filled ${count} field${count > 1 ? "s" : ""}`);
    else if (window === top) warn("No matching fields found on this page.");
  }

  // ---------- inline picker ----------
  let host = null;
  function closePicker() { host?.remove(); host = null; document.removeEventListener("keydown", onKey, true); }

  let pickerState = null;
  function onKey(e) {
    if (!pickerState) return;
    const { rows } = pickerState;
    if (e.key === "Escape") { e.preventDefault(); closePicker(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      pickerState.idx = (pickerState.idx + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
      rows.forEach((r, i) => r.classList.toggle("on", i === pickerState.idx));
      rows[pickerState.idx].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault(); e.stopPropagation(); rows[pickerState.idx].click();
    }
  }

  // all: list every saved item (right-click menu), not just the ones that fit this field.
  async function showPicker(el, { all = false } = {}) {
    closePicker();
    const saved = await getItems(true);
    if (!saved) return;
    const isFile = fieldKind(el) === "file";
    const items = saved.filter((it) => (it.type === "file") === isFile && isFilled(it) && (all || resolve(el, it)));
    if (!items.length) {
      warn(isFile ? "No saved files yet. Add one under Manage saved details."
        : all ? "No saved details yet. Add some under Manage saved details."
        : "None of your saved details fit this field. Right-click it and choose FormVault to see them all.");
      return;
    }

    // put the best guess first
    const guess = bestMatch(el, items);
    if (guess) items.sort((a, b) => (b === guess) - (a === guess));

    host = document.createElement("div");
    host.style.cssText = "all:initial;position:absolute;z-index:2147483647;";
    const r = el.getBoundingClientRect();
    host.style.left = window.scrollX + r.left + "px";
    host.style.top = window.scrollY + r.bottom + 4 + "px";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        .box{font:13px/1.35 system-ui,sans-serif;background:#fff;color:#1d2433;border:1px solid #c9d1e0;
          border-radius:8px;box-shadow:0 8px 24px rgba(20,30,60,.18);min-width:${Math.max(240, r.width)}px;max-width:420px;
          max-height:260px;overflow:auto;padding:4px}
        .row{display:flex;flex-direction:column;gap:1px;padding:7px 9px;border-radius:6px;cursor:pointer}
        .row.on,.row:hover{background:#e8efff}
        .row.nofit{opacity:.55}
        .l{font-weight:600}.v{color:#5b6578;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        @media (prefers-color-scheme:dark){.box{background:#1b2130;color:#e8ecf5;border-color:#33405c}
          .row.on,.row:hover{background:#2a3858}.v{color:#9aa6bf}}
      </style><div class="box"></div>`;
    const box = root.querySelector(".box");
    const rows = items.map((it, i) => {
      const fits = !!resolve(el, it);
      const row = document.createElement("div");
      row.className = "row" + (i === 0 ? " on" : "") + (fits ? "" : " nofit");
      row.innerHTML = `<span class="l"></span><span class="v"></span>`;
      row.children[0].textContent = it.label;
      row.children[1].textContent = displayValue(it) + (fits ? "" : "  (doesn't match this field)");
      row.addEventListener("mousedown", (e) => e.preventDefault()); // keep field focused
      row.addEventListener("click", async () => {
        closePicker();
        if (!(await fillField(el, it))) warn(`"${displayValue(it)}" doesn't match any option in this field.`);
      });
      box.appendChild(row);
      return row;
    });
    pickerState = { rows, idx: 0 };
    document.documentElement.appendChild(host);
    document.addEventListener("keydown", onKey, true);
    setTimeout(() => document.addEventListener("mousedown", function h(e) {
      if (host && !e.composedPath().includes(host)) closePicker();
      document.removeEventListener("mousedown", h, true);
    }, true), 0);
  }

  // ---------- messages: toast for success, modal for warnings ----------
  function toast(msg) {
    const t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#1d2433;color:#fff;" +
      "font:13px system-ui,sans-serif;padding:9px 14px;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.25)";
    document.documentElement.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }

  // Warnings must not be missed: show a modal in the top page (iframes hand theirs to it).
  function warn(msg, { unlock = false } = {}) {
    if (window !== top) { chrome.runtime.sendMessage({ action: "warn", msg, unlock }).catch(() => {}); return; }
    showModal(msg, unlock);
  }

  let modal = null;
  function showModal(msg, unlock) {
    modal?.remove();
    modal = document.createElement("div");
    modal.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;";
    const root = modal.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        .back{position:fixed;inset:0;background:rgba(10,15,30,.45);display:flex;align-items:center;justify-content:center;padding:16px}
        .dlg{font:14px/1.45 system-ui,sans-serif;background:#fff;color:#1d2433;border-radius:12px;max-width:380px;width:100%;
          padding:18px 20px;box-shadow:0 18px 50px rgba(0,0,0,.3)}
        .t{font-weight:600;margin-bottom:6px}
        .btns{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
        button{font:inherit;padding:7px 14px;border-radius:8px;border:1px solid #c9d1e0;background:#fff;color:inherit;cursor:pointer}
        button.main{background:#2b5cff;border-color:#2b5cff;color:#fff}
        @media (prefers-color-scheme:dark){.dlg{background:#1b2130;color:#e8ecf5}button{background:#242c40;border-color:#33405c}}
      </style>
      <div class="back"><div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="t" aria-describedby="m">
        <div class="t" id="t">FormVault</div><div id="m"></div>
        <div class="btns">${unlock ? '<button id="unlock" class="main">Unlock</button><button id="ok">Close</button>'
          : '<button id="ok" class="main">OK</button>'}</div>
      </div></div>`;
    root.getElementById("m").textContent = msg;
    const close = () => { modal?.remove(); modal = null; document.removeEventListener("keydown", onModalKey, true); };
    const onModalKey = (e) => {
      if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); close(); }
    };
    root.getElementById("ok").onclick = close;
    root.querySelector(".back").onclick = (e) => { if (e.target === e.currentTarget) close(); };
    if (unlock) root.getElementById("unlock").onclick = () => {
      close();
      chrome.runtime.sendMessage({ action: "open-options" }).catch(() => {});
    };
    document.addEventListener("keydown", onModalKey, true);
    document.documentElement.appendChild(modal);
    root.querySelector("button.main").focus();
  }

  // ---------- right-click menu ----------
  let lastRightClicked = null;
  document.addEventListener("contextmenu", (e) => {
    const node = e.composedPath()[0];
    lastRightClicked = node instanceof Element
      ? (node.matches("input, textarea, select") ? node : node.closest("label")?.control || null)
      : null;
  }, true);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "fill-all") fillAll();
    else if (msg.action === "show-modal") showModal(msg.msg, msg.unlock);
    else if (msg.action === "show-picker" && msg.fromMenu) {
      if (fillable(lastRightClicked)) showPicker(lastRightClicked, { all: true });
      else warn("Right-click a form field (text box, dropdown, date, radio button…) to fill it.");
    } else if (msg.action === "show-picker" && document.hasFocus()) {
      const el = document.activeElement;
      if (fillable(el)) showPicker(el);
      else if (window === top || el?.tagName !== "IFRAME") warn("Click into a form field first, then press the shortcut.");
    }
  });
})();
