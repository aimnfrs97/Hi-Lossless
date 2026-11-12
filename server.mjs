// BitChord FLAC addon — Internet Archive (lossless, verified)
// Zero dependencies. Node 20+.
//
// Routes (BitChord addon protocol):
//   GET /manifest.json
//   GET /search?q=...&quality=...
//   GET /stream/{id}?quality=...
//   GET /health

import http from "node:http";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------- config (env) ----------
const PORT = Number(process.env.PORT || 8787);
const ADDON_ID = process.env.ADDON_ID || "my.bitchord.archive-flac";
const ADDON_NAME = process.env.ADDON_NAME || "Archive FLAC (Lossless)";
const ALLOW_DOWNLOADS = process.env.ALLOW_DOWNLOADS === "0" ? 0 : 1;
// 1 = only used when phone has a lossless-capable output (Android only)
const CHECK_VALID_LOSSLESS = process.env.CHECK_VALID_LOSSLESS === "1" ? 1 : 0;
// Optional official app-lock. OFF by default so the PC/desktop builds and forks can still use the addon.
// To enable: BITCHORD_AUTH=1, PUBLIC_HOST=your.host.name and put bitchord-addon-auth.mjs next to this file.
const BITCHORD_AUTH = process.env.BITCHORD_AUTH === "1";
const PUBLIC_HOST = (process.env.PUBLIC_HOST || "").trim().toLowerCase();
// Serve FLAC even when BitChord asks for the LOW (metered) tier? Default: no, let another source answer.
const SERVE_FLAC_ON_LOW = process.env.SERVE_FLAC_ON_LOW === "1";
// Skip Internet Archive items whose title / subject / collection contains any of these words.
// Comma separated, case-insensitive. Set to "none" to turn the filter off.
const EXCLUDE_WORDS = (
  process.env.EXCLUDE_WORDS ??
  "jazz,classical,concert,etree,gratefuldead,symphony,orchestra,opera,live at,live in,live from"
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter((s) => s && s !== "none");

const MAX_ITEMS = 8; // Internet Archive items looked at per search
const MAX_TRACKS = 40; // tracks returned per search
const SEARCH_TTL = 5 * 60_000;
const META_TTL = 30 * 60_000;
const VERIFY_TTL = 30 * 60_000;
const UA = "bitchord-flac-addon/1.0 (+self-hosted)";

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------- optional official auth ----------
let bitchord = null;
if (BITCHORD_AUTH) {
  const file = path.join(here, "bitchord-addon-auth.mjs");
  if (!PUBLIC_HOST) {
    console.warn("[auth] BITCHORD_AUTH=1 but PUBLIC_HOST is empty -> auth disabled");
  } else if (!existsSync(file)) {
    console.warn("[auth] bitchord-addon-auth.mjs not found next to server.mjs -> auth disabled");
  } else {
    const { createBitChordAuth } = await import(pathToFileURL(file).href);
    bitchord = createBitChordAuth({
      hosts: PUBLIC_HOST.split(",").map((s) => s.trim()).filter(Boolean),
    });
    console.log("[auth] BitChord app-lock enabled for", PUBLIC_HOST);
  }
}

// ---------- tiny TTL cache ----------
const cache = new Map();
function cached(key, ttl, producer) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  const value = producer().catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, { exp: Date.now() + ttl, value });
  if (cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of cache) if (v.exp < now) cache.delete(k);
  }
  return value;
}

// ---------- helpers ----------
async function getJson(url, ms = 9000) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(ms),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

const first = (v) => (Array.isArray(v) ? v[0] : v);
const str = (v) => {
  const x = first(v);
  return x == null ? "" : String(x).trim();
};

function parseLength(v) {
  const s = str(v);
  if (!s) return undefined;
  if (s.includes(":")) {
    const parts = s.split(":").map(Number);
    if (parts.some(Number.isNaN)) return undefined;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

function cleanTitleFromFile(name, identifier = "", album = "") {
  const base = name.split("/").pop().replace(/\.flac$/i, "");
  // Files named after the whole item (e.g. "<identifier>_disc1side1"): use the album name + the leftover bit
  const id = identifier.toLowerCase();
  if (id && base.toLowerCase().startsWith(id.slice(0, 20))) {
    const rest = base.slice(identifier.length).replace(/[_\-.]+/g, " ").trim();
    const label = album || base;
    return rest ? `${label} (${rest})` : label;
  }
  const cleaned = base
    .replace(/^\s*(?:d\d+)?\s*t?\d{1,3}\s*[-_. ]+\s*/i, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || base;
}

function isExcluded(meta, identifier) {
  if (!EXCLUDE_WORDS.length) return false;
  const m = meta?.metadata ?? {};
  const hay = [identifier, m.title, m.subject, m.collection]
    .flat()
    .filter(Boolean)
    .join(" | ")
    .toLowerCase();
  return EXCLUDE_WORDS.some((w) => hay.includes(w));
}

const tokenize = (q) =>
  q.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/).filter((t) => t.length >= 2);

const norm = (s) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

function encodeTrackId(identifier, file) {
  return `${identifier}::${file}`;
}
function decodeTrackId(id) {
  const i = id.indexOf("::");
  if (i < 1) return null;
  return { identifier: id.slice(0, i), file: id.slice(i + 2) };
}

function downloadUrl(identifier, file) {
  return `https://archive.org/download/${encodeURIComponent(identifier)}/${file.split("/").map(encodeURIComponent).join("/")}`;
}

// ---------- Internet Archive ----------
function getMetadata(identifier) {
  return cached(`meta:${identifier}`, META_TTL, () =>
    getJson(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, 12000),
  );
}

async function searchItems(q) {
  const lucene = q.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, " ").replace(/\s+/g, " ").trim();
  if (!lucene) return [];
  const params = new URLSearchParams({
    q: `(${lucene}) AND mediatype:audio AND format:FLAC`,
    rows: String(MAX_ITEMS),
    page: "1",
    output: "json",
    sort: "downloads desc",
  });
  for (const f of ["identifier", "title", "creator"]) params.append("fl[]", f);
  const data = await cached(`search:${lucene.toLowerCase()}`, SEARCH_TTL, () =>
    getJson(`https://archive.org/advancedsearch.php?${params}`),
  );
  return data?.response?.docs ?? [];
}

function flacFilesOf(meta) {
  const files = Array.isArray(meta?.files) ? meta.files : [];
  return files.filter(
    (f) => typeof f?.name === "string" && /\.flac$/i.test(f.name) && f.private !== "true" && Number(f.size || 0) > 50_000,
  );
}

function tracksFromItem(identifier, meta) {
  const m = meta?.metadata ?? {};
  const albumName = str(m.title);
  const itemArtist = str(m.creator);
  const seen = new Set();
  const out = [];
  for (const f of flacFilesOf(meta)) {
    const key = f.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: encodeTrackId(identifier, f.name),
      title: str(f.title) || cleanTitleFromFile(f.name, identifier, str(f.album) || albumName),
      artist: str(f.artist) || str(f.creator) || itemArtist,
      album: str(f.album) || albumName,
      duration: parseLength(f.length),
      artworkURL: `https://archive.org/services/img/${encodeURIComponent(identifier)}`,
      format: "flac",
      audioQuality: "LOSSLESS",
      _trackNo: Number(str(f.track).split("/")[0]) || 0,
    });
  }
  out.sort((a, b) => a._trackNo - b._trackNo || a.title.localeCompare(b.title));
  return out;
}

async function searchTracks(q) {
  const items = await searchItems(q);
  const metas = await Promise.allSettled(items.map((it) => getMetadata(it.identifier)));
  const tokens = tokenize(q);
  const scored = [];
  metas.forEach((r, i) => {
    if (r.status !== "fulfilled") return;
    const identifier = items[i].identifier;
    if (isExcluded(r.value, identifier)) return;
    for (const t of tracksFromItem(identifier, r.value)) {
      const hay = norm(`${t.title} ${t.artist} ${t.album} ${identifier}`);
      const hits = tokens.filter((tok) => hay.includes(tok)).length;
      scored.push({ t, hits, itemRank: i });
    }
  });
  if (!scored.length) return [];
  const need = tokens.length ? tokens.length : 0;
  let kept = scored.filter((s) => s.hits >= need);
  if (!kept.length) kept = scored.filter((s) => s.hits >= Math.ceil(need / 2));
  kept.sort((a, b) => b.hits - a.hits || a.itemRank - b.itemRank);
  return kept.slice(0, MAX_TRACKS).map(({ t }) => {
    const { _trackNo, ...clean } = t;
    return Object.fromEntries(Object.entries(clean).filter(([, v]) => v !== undefined && v !== ""));
  });
}

// ---------- FLAC verification (reads STREAMINFO, only ~64 bytes) ----------
function parseStreamInfo(b) {
  // "fLaC" + metadata block header (4) + STREAMINFO (34)
  if (b.length < 26) return null;
  if (!(b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43)) return { ok: false };
  const sampleRate = (b[18] << 12) | (b[19] << 4) | (b[20] >> 4);
  const channels = ((b[20] >> 1) & 7) + 1;
  const bitDepth = (((b[20] & 1) << 4) | (b[21] >> 4)) + 1;
  const totalSamples = (b[21] & 0x0f) * 2 ** 32 + ((b[22] << 24) >>> 0) + (b[23] << 16) + (b[24] << 8) + b[25];
  const duration = sampleRate ? totalSamples / sampleRate : undefined;
  return { ok: true, sampleRate, channels, bitDepth, duration };
}

function verifyFlac(url) {
  return cached(`verify:${url}`, VERIFY_TTL, async () => {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Range: "bytes=0-63" },
        signal: AbortSignal.timeout(8000),
        redirect: "follow",
      });
      if (res.status === 404 || res.status === 403) return { ok: false };
      if (!res.ok && res.status !== 206) return null;
      const reader = res.body.getReader();
      let buf = new Uint8Array(0);
      while (buf.length < 64) {
        const { done, value } = await reader.read();
        if (done) break;
        const next = new Uint8Array(buf.length + value.length);
        next.set(buf);
        next.set(value, buf.length);
        buf = next;
      }
      await reader.cancel().catch(() => {});
      // ID3v2-prefixed FLAC: can't parse cheaply, trust the .flac name
      if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return null;
      return parseStreamInfo(buf);
    } catch {
      return null; // network hiccup: don't block playback
    }
  });
}

function qualityLabel(info) {
  if (!info?.sampleRate || !info?.bitDepth) return "Lossless · FLAC";
  const khz = info.sampleRate / 1000;
  const k = Number.isInteger(khz) ? String(khz) : khz.toFixed(1);
  const hires = info.bitDepth > 16 || info.sampleRate > 48000;
  return `${hires ? "Hi-Res Lossless" : "Lossless"} · ${info.bitDepth}-bit / ${k} kHz`;
}

// ---------- HTTP ----------
const MANIFEST = {
  id: ADDON_ID,
  name: ADDON_NAME,
  version: "1.0.0",
  resources: ["search", "stream"],
  allowDownloads: ALLOW_DOWNLOADS,
  checkValidLossless: CHECK_VALID_LOSSLESS,
  ...(bitchord ? { bitchordAuth: true } : {}),
};

function send(res, status, body, extra = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    ...extra,
  });
  res.end(payload);
}

async function guard(req, res) {
  if (!bitchord) return false;
  const origin = `https://${PUBLIC_HOST.split(",")[0].trim()}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const denied = await bitchord.guard(new Request(new URL(req.url, origin), { method: "GET", headers }));
  if (!denied) return false;
  const out = {};
  denied.headers.forEach((v, k) => (out[k] = v));
  res.writeHead(denied.status, out);
  res.end(await denied.text());
  return true;
}

async function handle(req, res) {
  if (req.method === "OPTIONS") return send(res, 204);
  if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" });

  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  if (p === "/manifest.json" || p === "/") return send(res, 200, MANIFEST); // public
  if (p === "/health") return send(res, 200, { ok: true, auth: Boolean(bitchord), uptime: process.uptime() });

  if (await guard(req, res)) return;

  const quality = (url.searchParams.get("quality") || "LOSSLESS").toUpperCase();

  if (p === "/search") {
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) return send(res, 200, { tracks: [] });
    if (quality === "LOW" && !SERVE_FLAC_ON_LOW) return send(res, 200, { tracks: [] });
    try {
      const tracks = await searchTracks(q);
      return send(res, 200, { tracks, total: tracks.length });
    } catch (err) {
      console.error("[search]", err.message);
      return send(res, 200, { tracks: [], total: 0 }); // miss -> BitChord tries the next source
    }
  }

  if (p.startsWith("/stream/")) {
    let id;
    try {
      id = decodeURIComponent(p.slice("/stream/".length));
    } catch {
      return send(res, 404);
    }
    const parsed = decodeTrackId(id);
    if (!parsed) return send(res, 404);
    if (quality === "LOW" && !SERVE_FLAC_ON_LOW) return send(res, 404, { error: "flac_only" });

    let meta;
    try {
      meta = await getMetadata(parsed.identifier);
    } catch (err) {
      console.error("[stream/meta]", err.message);
      return send(res, 502, { error: "upstream_unavailable" });
    }
    const file = flacFilesOf(meta).find((f) => f.name === parsed.file);
    if (!file) return send(res, 404);

    const mediaUrl = downloadUrl(parsed.identifier, file.name);
    const info = await verifyFlac(mediaUrl);
    if (info && info.ok === false) return send(res, 404, { error: "not_a_flac" });

    return send(res, 200, {
      url: mediaUrl,
      format: "flac",
      quality: qualityLabel(info),
      codec: "flac",
      container: "flac",
      manifest: "none",
      encrypted: false,
      ...(info?.sampleRate ? { sampleRate: info.sampleRate } : {}),
      ...(info?.bitDepth ? { bitDepth: info.bitDepth } : {}),
    });
  }

  return send(res, 404);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error("[unhandled]", err);
    if (!res.headersSent) send(res, 500, { error: "internal_error" });
    else res.end();
  });
});

server.listen(PORT, () => console.log(`BitChord FLAC addon listening on :${PORT}`));
