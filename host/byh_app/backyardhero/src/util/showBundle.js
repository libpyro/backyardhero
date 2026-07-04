// Native show bundle (.byh) — shared serialize / collect-deps / remap / zip
// helpers used by the export + import endpoints and the cloud-sync push engine.
//
// A `.byh` file is a plain zip (via fflate, works in Node and the browser)
// carrying a show and everything it references, so a show round-trips onto any
// machine even with empty inventory:
//
//   manifest.json          { format:"byh-show", schemaVersion:1, exportedAt, audioMode }
//   show.json              the show row (authorization_code omitted on export)
//   inventory.json         referenced inventory items
//   firing-profiles.json   firing profiles for the referenced inventory
//   racks.json             child racks (show_id renumbered on import)
//   audio/<trackId>.<ext>  raw audio bytes (only when audioMode === "embed")
//
// This module is intentionally I/O-free and profile-agnostic. It knows how to
//   (a) find the inventory ids a show references (deep scan),
//   (b) remap those ids through an id map (shared with push.js), and
//   (c) pack / unpack the zip container.
// The API routes wire in the repo (@/data) and blob store for the actual bytes.

import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

export const BYH_FORMAT = 'byh-show';
export const BYH_SCHEMA_VERSION = 1;
export const BYH_EXTENSION = '.byh';

// ── Inventory id references ──────────────────────────────────────────────────
// Inventory references inside a show's display_payload and rack cells live under
// a small, well-known set of keys. We touch ONLY those keys — never the
// ambiguous `id` (a per-show sequence number at the item level) nor an item's
// `type` (a category string like "cake"). Fuse references are an inventory id
// stored as `type` on a `fuse` object / inside a rack `fuses` map.
export const INV_REF_KEYS = new Set(['itemId', 'fireableItemId', 'shellId']);

function isScalar(v) {
  return typeof v === 'number' || typeof v === 'string';
}

export function remapInvId(v, invMap) {
  if (v === null || v === undefined) return v;
  const mapped = invMap[v] ?? invMap[String(v)];
  return mapped ?? v;
}

export function remapFuseObj(fuse, invMap) {
  const out = deepRemap(fuse, invMap);
  if (out && typeof out === 'object' && 'type' in out && isScalar(out.type)) {
    const mapped = invMap[out.type] ?? invMap[String(out.type)];
    if (mapped) out.type = String(mapped);
  }
  return out;
}

export function remapFusesMap(fuses, invMap) {
  if (!fuses || typeof fuses !== 'object') return fuses;
  const out = {};
  for (const [fid, f] of Object.entries(fuses)) out[fid] = remapFuseObj(f, invMap);
  return out;
}

export function deepRemap(node, invMap) {
  if (Array.isArray(node)) return node.map((n) => deepRemap(n, invMap));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (INV_REF_KEYS.has(k) && isScalar(v)) {
        out[k] = remapInvId(v, invMap);
      } else if (k === 'fuse' && v && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = remapFuseObj(v, invMap);
      } else if (k === 'fuses' && v && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = remapFusesMap(v, invMap);
      } else {
        out[k] = deepRemap(v, invMap);
      }
    }
    return out;
  }
  return node;
}

// Deep-scan display_payload items + rack cells/fuses and return the set of
// inventory ids they reference (as strings, for backend-agnostic matching —
// SQLite ints vs cloud uuids). Mirrors deepRemap's key handling exactly so we
// collect precisely the ids deepRemap would rewrite.
export function collectInventoryIds(displayItems, rackRows = []) {
  const ids = new Set();
  const add = (v) => {
    if (isScalar(v)) ids.add(String(v));
  };
  const collectFuse = (fuse) => {
    walk(fuse);
    if (fuse && typeof fuse === 'object' && 'type' in fuse) add(fuse.type);
  };
  function walk(node) {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (INV_REF_KEYS.has(k)) {
          add(v);
        } else if (k === 'fuse' && v && typeof v === 'object' && !Array.isArray(v)) {
          collectFuse(v);
        } else if (k === 'fuses' && v && typeof v === 'object' && !Array.isArray(v)) {
          for (const f of Object.values(v)) collectFuse(f);
        } else {
          walk(v);
        }
      }
    }
  }
  if (Array.isArray(displayItems)) displayItems.forEach(walk);
  for (const rack of rackRows || []) {
    if (!rack) continue;
    walk(rack.cells);
    if (rack.fuses && typeof rack.fuses === 'object') {
      for (const f of Object.values(rack.fuses)) collectFuse(f);
    }
  }
  return ids;
}

// ── Audio content types ──────────────────────────────────────────────────────
export function audioExt(name) {
  const m = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(String(name || ''));
  return m ? `.${m[1].toLowerCase()}` : '';
}

export function audioContentType(name) {
  switch (audioExt(name)) {
    case '.mp3': return 'audio/mpeg';
    case '.wav': return 'audio/wav';
    case '.ogg': return 'audio/ogg';
    case '.m4a': return 'audio/mp4';
    case '.flac': return 'audio/flac';
    default: return 'application/octet-stream';
  }
}

// ── JSON helpers ─────────────────────────────────────────────────────────────
// JSON columns arrive as strings (local) or objects (already parsed). Normalize.
export function parseJsonOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

// ── Zip container ────────────────────────────────────────────────────────────
function jsonEntry(value) {
  // Deflate the (highly compressible) JSON parts.
  return [strToU8(JSON.stringify(value ?? null, null, 2)), { level: 6 }];
}

/**
 * Pack a bundle into a `.byh` zip (Uint8Array).
 * @param {object} b
 * @param {object} b.manifest         manifest.json contents
 * @param {object} b.show             show.json contents
 * @param {Array}  [b.inventory]      inventory.json contents
 * @param {Array}  [b.firingProfiles] firing-profiles.json contents
 * @param {Array}  [b.racks]          racks.json contents
 * @param {Array}  [b.audioFiles]     [{ name:"audio/<id>.<ext>", bytes:Uint8Array }]
 */
export function packBundle({ manifest, show, inventory, firingProfiles, racks, audioFiles = [] }) {
  const files = {
    'manifest.json': jsonEntry(manifest),
    'show.json': jsonEntry(show),
    'inventory.json': jsonEntry(inventory ?? []),
    'firing-profiles.json': jsonEntry(firingProfiles ?? []),
    'racks.json': jsonEntry(racks ?? []),
  };
  for (const f of audioFiles || []) {
    if (!f || !f.name || !f.bytes) continue;
    const bytes = f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes);
    // Audio is already compressed — store (level 0) to avoid wasted CPU.
    files[f.name] = [bytes, { level: 0 }];
  }
  return zipSync(files, { level: 6 });
}

/**
 * Unpack a `.byh` zip. Returns the parsed JSON parts plus an `audio` map of
 * entry name (`audio/<id>.<ext>`) → raw bytes (Uint8Array).
 */
export function unpackBundle(zipBytes) {
  const entries = unzipSync(zipBytes instanceof Uint8Array ? zipBytes : new Uint8Array(zipBytes));
  const readJson = (name, fallback) => {
    const bytes = entries[name];
    if (!bytes) return fallback;
    try {
      return JSON.parse(strFromU8(bytes));
    } catch {
      return fallback;
    }
  };
  const audio = {};
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.startsWith('audio/') && !name.endsWith('/')) audio[name] = bytes;
  }
  return {
    manifest: readJson('manifest.json', null),
    show: readJson('show.json', null),
    inventory: readJson('inventory.json', []),
    firingProfiles: readJson('firing-profiles.json', []),
    racks: readJson('racks.json', []),
    audio,
  };
}

/**
 * Validate a bundle manifest. Returns an error string, or null when OK.
 */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    return 'Not a BackyardHero backup (missing manifest.json).';
  }
  if (manifest.format !== BYH_FORMAT) {
    return `Unrecognized backup format: ${manifest.format ?? 'unknown'}.`;
  }
  if (Number(manifest.schemaVersion) > BYH_SCHEMA_VERSION) {
    return `This backup was made by a newer version of BackyardHero (schema ${manifest.schemaVersion}). Please update to import it.`;
  }
  return null;
}
