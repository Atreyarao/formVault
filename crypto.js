// Vault crypto (loaded by background.js). PBKDF2-SHA256 -> AES-GCM-256, all via Web Crypto.
const PBKDF2_ITERATIONS = 600000;

const toB64 = (buf) => {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// Returns the raw AES key as base64 so it can be cached in chrome.storage.session.
async function deriveKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  return toB64(await crypto.subtle.exportKey("raw", key));
}

const importAes = (rawB64) => crypto.subtle.importKey("raw", fromB64(rawB64), "AES-GCM", false, ["encrypt", "decrypt"]);

async function encryptJSON(rawB64, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await importAes(rawB64),
    new TextEncoder().encode(JSON.stringify(data)));
  return { iv: toB64(iv), ct: toB64(ct) };
}

// Throws if the key is wrong or the data was tampered with (GCM auth check).
async function decryptJSON(rawB64, { iv, ct }) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) }, await importAes(rawB64), fromB64(ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
