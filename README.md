<p align="center"><img src="icons/icon128.png" width="96" alt="FormVault icon"></p>

# FormVault

A Chrome extension that fills web forms with your saved details and files: names, emails, dates, numbers, dropdown answers and uploads like your résumé. Everything is encrypted with a master password and never leaves your browser.

## Features

- **One-shortcut fill:** fills every matching field on the page at once.
- **Inline picker:** shows a list of your saved details under the field you're in.
- **Right-click menu:** right-click any field and choose **Fill with FormVault…** to pick from everything you've saved.
- **Smart matching for dropdowns and radio buttons:** save `Gender: male` and it picks `Male`, `M` or `Man`, whatever the form offers. US states (`New York` ↔ `NY`), common countries and yes/no answers are understood too.
- **Typed values:**
  - **Dates** are written in the format each field expects (date pickers, `MM/DD/YYYY` text boxes, separate day/month/year dropdowns).
  - **Numbers** are cleaned for number fields (`5 years` → `5`).
  - **Files** are attached to upload fields.
- **Encrypted vault:** AES-256-GCM with a key derived from your master password. FormVault locks when Chrome closes and after 15 minutes of inactivity.

## Install

FormVault isn't on the Chrome Web Store yet, so you load it as an unpacked extension:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. The settings page opens. Set a **master password** of at least 8 characters.

> **There is no password recovery.** Your data is encrypted with the password itself. If you forget it, you can only delete everything and start again.

To update after changing the code, click the reload icon on the FormVault card in `chrome://extensions`.

## Using it

### 1. Save your details
Open the settings page: click the toolbar icon, then **Manage saved details**. Each item has:

| Field | What it's for |
|---|---|
| **Label** | A name for the item, e.g. `Date of birth`. It's also used as a keyword. |
| **Type** | **Text / choice**, **Number**, **Date**, or **File** |
| **Value** | What gets filled in. For dropdowns and radio buttons, just save the answer (e.g. `Male`). |
| **Keywords** | Comma-separated words that identify the field, e.g. `dob, birth, birthday` |

Click **Save changes**. Nothing is stored until you do.

Keywords are matched against a form field's name, id, label, placeholder and ARIA label. When several items match, the longest matching keyword wins. For example, `email address` beats `address`.

### 2. Fill a form

| Action | Mac | Windows / Linux |
|---|---|---|
| Fill every matching field | `Control + Shift + F` | `Alt + Shift + F` |
| Show the picker under the focused field | `Control + Shift + S` | `Alt + Shift + S` |
| Pick from all saved details | Right-click a field → **Fill with FormVault…** | same |

On a Mac, `Control` is the actual Control key, not Cmd. To change the shortcuts, go to `chrome://extensions/shortcuts`.

In the picker, use **↑ / ↓** to move, **Enter** to fill and **Esc** to close. In the right-click list, items that don't fit the field are greyed out.

**Fill all** never overwrites a field that already has a value.

### 3. Lock, unlock and passwords
- **Lock now:** click the toolbar icon, or the **Lock** button on the settings page.
- **Unlock:** if you try to fill while locked, a dialog appears with an **Unlock** button.
- **Change password:** settings page → **Change password**. You'll need your current password.
- **Forgot password:** on the unlock screen, click **Forgot password? Delete everything and start fresh**.

Warnings appear as a dialog in the middle of the page, so you can't miss them. A successful fill shows a small notice in the corner.

## Architecture

### Files

| File | Runs in | Responsibility |
|---|---|---|
| [manifest.json](manifest.json) | | Manifest V3: permissions, shortcuts, content script, icons |
| [background.js](background.js) | Service worker | **The only place that holds the key or decrypts data.** Vault operations, lock timer, right-click menu, shortcut routing |
| [crypto.js](crypto.js) | Service worker (`importScripts`) | Key derivation and AES-GCM encrypt/decrypt helpers |
| [content.js](content.js) | Every page and frame | Field detection, matching, filling, picker, warning dialogs |
| [options.html](options.html) / [options.js](options.js) | Extension page | Setup/unlock/change-password screens and the item editor |
| [popup.html](popup.html) / [popup.js](popup.js) | Toolbar popup | Fill this page, manage details, lock/unlock |
| [icons/](icons/) | | PNG icons, plus the source SVGs `icon.svg` and `icon-small.svg` (a simplified drawing for 16 px) |

### How the pieces talk

```
 ┌──────────────┐  shortcut / right-click   ┌──────────────────────────┐
 │   Chrome     │ ────────────────────────▶ │  background.js           │
 └──────────────┘                           │  (service worker)        │
                                            │                          │
 ┌──────────────┐  setup / unlock / save /  │  key ─▶ storage.session  │
 │ options page │  changePassword / reset   │        (memory only)     │
 │ popup        │ ────────────────────────▶ │                          │
 └──────────────┘                           │  vault ─▶ storage.local  │
                                            │        (encrypted, disk) │
 ┌──────────────┐  getItems (read only)     │                          │
 │ content.js   │ ◀───────────────────────▶ │  decrypts on request     │
 │ (each page)  │  fill-all / show-picker   │                          │
 └──────────────┘  warnings from iframes ─▶ relayed to the top frame   │
                                            └──────────────────────────┘
```

Every message is a `chrome.runtime` message with either a `vault` field (vault operations) or an `action` field (UI commands).

- **Permissions are checked in [background.js](background.js).** Content scripts may only call `getItems`. Setup, unlock, save, change-password and reset are accepted only from the extension's own pages: the sender URL must start with `chrome-extension://<id>/`.
- **Shortcuts:** each shortcut sends `fill-all` or `show-picker` to the active tab.
- **Right-click:** sends `show-picker` with `fromMenu: true` to the exact frame that was right-clicked. The content script remembers the last right-clicked field from the `contextmenu` event.

### Storage layout

```js
// chrome.storage.local: on disk, encrypted
{ vault: { salt, iter, iv, ct } }   // all base64; ct = AES-GCM(JSON of items)

// chrome.storage.session: in memory, cleared when Chrome quits, not readable by content scripts
{ key, lastUsed }                   // raw AES key (base64) and last-activity timestamp
```

Once decrypted, each item looks like this:

```js
{ id, label, keywords, type: "text" | "number" | "date" | "file",
  value,                       // text / number / ISO date "YYYY-MM-DD"
  dataUrl, fileName, fileType  // file items only
}
```

### Encryption

- **Key derivation:** PBKDF2-SHA256, 600,000 iterations, random 16-byte salt → 256-bit AES key. It uses Web Crypto only, with no third-party libraries.
- **Encryption:** AES-256-GCM with a fresh random 12-byte IV on every save. GCM's authentication tag rejects a wrong password or tampered data. Unlocking checks the password this way, so no password hash is stored.
- **Files:** files are stored as data URLs inside the same encrypted vault. A stored file takes about 1.8× its original size, and the whole vault is decrypted on every fill. That's fine for a few documents but slow for many large ones.
- **Locking:** the vault locks when:
  - Chrome quits (`storage.session` is memory-only);
  - the last browser window closes (on macOS Chrome can keep running with no windows);
  - 15 minutes pass with no use. Change this with `IDLE_LOCK_MS` in [background.js](background.js).
- **Change password:** decrypts with the old key, then re-encrypts with a new salt and key.
- **Reset:** deletes the vault.
- **Migration:** data saved as plain text by v1.0 is encrypted at first setup, and the plain copy is removed. Chrome's storage may keep fragments of the old data on disk until it compacts its files.

**What it protects against:** someone reading your Chrome profile files, such as a stolen laptop or a copied profile folder.
**What it doesn't protect against:** malware running as you while the vault is unlocked, or a site reading values after they've been filled into its form.

### Field matching ([content.js](content.js))

1. **Field signature:** the field's name, id, placeholder, autocomplete, title, ARIA label and `<label>` text, lowercased, with `camelCase` and `snake_case` split into words. For a radio button, the question comes from its `<fieldset><legend>` or the `role="radiogroup"` label, because each button's own label is just an answer.
2. **Best item:** the item with the longest keyword or label found in the signature. A small bonus goes to an item whose type matches the field's type, for example a date item for a date field. The item must also be able to fill the field (`resolve`).
3. **Resolving a value**, by field type:
   - `date` / `month` / `datetime-local` inputs → ISO-style format
   - `number` → digits only
   - text field + date item → the format hinted by the placeholder (`DD/MM/YYYY` etc.); otherwise `MM/DD/YYYY` for jQuery UI pickers, otherwise the browser locale
   - dropdown or radio → `pickOption` scores each option. Exact or alias match = 100, same number = 90, whole-word match = 60, prefix = 40; option text gets a +1 edge over the option value. A date item can fill separate day / month / year dropdowns, detected from the field signature.
   - checkbox → ticked for yes-like values, unticked for no-like values
4. **Filling:**
   - Text values use the native value setter and then fire `input`, `change` and `blur`, so React, Vue and similar frameworks notice the change.
   - Radio buttons and checkboxes are **clicked**.
   - Files go through `DataTransfer`.
   - Read-only fields are skipped, except date pickers (detected from a class, name or id containing date/dob/birth).

Aliases live in `ALIAS_GROUPS` in [content.js](content.js). Add a line there to teach FormVault new equivalents.

## Limitations

- Custom JavaScript dropdowns (React-Select, MUI Autocomplete and the like) aren't native `<select>` elements and aren't filled.
- A date picker that expects a format other than the one detected may reject the value. Add the format as a placeholder hint, or adjust `textDateFormat`.
- The right-click item shows on every page right-click, because Chrome can't limit a menu item to form fields only.
- Files live inside the main vault, so many large files make saving and filling slower.

## Development

The project is plain JavaScript with no build step. After editing, reload the extension in `chrome://extensions`.

- **Debug the background script:** click **Service worker** on the FormVault card in `chrome://extensions`.
- **Debug the content script:** open DevTools on the page and choose the FormVault context in the console's context dropdown.
- **Debug the settings page or popup:** right-click → **Inspect**.
- **Icons:** edit the SVGs in [icons/](icons/), then re-export:
  ```sh
  cd icons
  for s in 32 48 128; do rsvg-convert -w $s -h $s icon.svg -o icon$s.png; done
  rsvg-convert -w 16 -h 16 icon-small.svg -o icon16.png
  ```
