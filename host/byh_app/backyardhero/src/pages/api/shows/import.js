// POST /api/shows/import
//
// Restores a native `.byh` backup (see @/util/showBundle). Multipart body:
//   file        the .byh zip (field name "file")
//   resolution  JSON map: bundledInventoryId -> { action:"match", existingId }
//               | { action:"create" }. Missing/omitted ids default to "create".
//   name        optional show-name override
//   authorization_code  optional; a fresh one is minted when absent
//   protocol    optional protocol override
//
// Steps (mirrors cloudSync/push.js, single-show): build an inventory id map by
// matching/creating items → remap display_payload + rack cells/fuses → upload
// embedded audio and rewrite track urls → create the show (fresh auth code) →
// create racks under the new show id → second pass relinks rackId back-refs.
//
// The zip is parsed server-side here (authoritative); the import modal also
// parses it client-side, but only to drive the inventory-resolve UI.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import formidable from 'formidable';
import { getRepo } from '@/data';
import { getBlobStore } from '@/data/blobStore';
import { resolveCtx } from '@/data/context';
import {
  unpackBundle,
  validateManifest,
  deepRemap,
  remapFusesMap,
  audioContentType,
  audioExt,
} from '@/util/showBundle';

export const config = { api: { bodyParser: false } };

function firstVal(v) {
  return Array.isArray(v) ? v[0] : v;
}

function jsonOrNull(v) {
  if (v === null || v === undefined) return null;
  return JSON.stringify(v);
}

// Clean inventory row → repo.inventory.create payload (known columns only).
function inventoryPayload(inv) {
  return {
    name: inv.name,
    type: inv.type,
    duration: inv.duration ?? null,
    fuse_delay: inv.fuse_delay ?? null,
    lift_delay: inv.lift_delay ?? null,
    burn_rate: inv.burn_rate ?? null,
    color: inv.color ?? null,
    available_ct: inv.available_ct ?? 0,
    youtube_link: inv.youtube_link ?? null,
    youtube_link_start_sec: inv.youtube_link_start_sec ?? null,
    image: inv.image ?? null,
    metadata: inv.metadata == null
      ? null
      : (typeof inv.metadata === 'string' ? inv.metadata : JSON.stringify(inv.metadata)),
    unit_cost: inv.unit_cost ?? null,
    source: inv.source || 'imported',
  };
}

// Strip a bundle audio entry name (`audio/<tid>.<ext>`) back to its track id.
function entryTrackId(name) {
  const base = name.replace(/^audio\//, '');
  return base.replace(/\.[a-z0-9]+$/i, '');
}

// Write bytes to a temp file so the blob store's file-based put() can consume
// them (fs move locally / Storage upload in cloud). Returns the temp path.
function writeTemp(bytes, ext) {
  const p = path.join(os.tmpdir(), `byh_import_${crypto.randomBytes(8).toString('hex')}${ext || ''}`);
  fs.writeFileSync(p, Buffer.from(bytes));
  return p;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  let ctx;
  let repo;
  try {
    ctx = await resolveCtx(req);
    repo = await getRepo(req);
  } catch (err) {
    return res.status(err?.status || 500).json({ error: err?.message || 'Failed to resolve data context.' });
  }

  const form = formidable({
    uploadDir: os.tmpdir(),
    keepExtensions: true,
    maxFileSize: 200 * 1024 * 1024, // room for embedded audio
    multiples: false,
  });

  let fields;
  let files;
  try {
    ({ fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, flds, fls) => (err ? reject(err) : resolve({ fields: flds, files: fls })));
    }));
  } catch (err) {
    return res.status(400).json({ error: `Failed to read upload: ${err?.message || err}` });
  }

  const upload = firstVal(files.file || files.bundle || files.byh);
  if (!upload || !upload.filepath) {
    return res.status(400).json({ error: 'No backup file provided.' });
  }

  const warnings = [];
  try {
    const zipBytes = fs.readFileSync(upload.filepath);
    const bundle = unpackBundle(new Uint8Array(zipBytes));

    const manifestError = validateManifest(bundle.manifest);
    if (manifestError) return res.status(400).json({ error: manifestError });

    const show = bundle.show;
    if (!show || typeof show !== 'object') {
      return res.status(400).json({ error: 'Backup is missing its show data.' });
    }

    // Resolution map (default every bundled item to "create").
    let resolution = {};
    try {
      const raw = firstVal(fields.resolution);
      if (raw) resolution = JSON.parse(raw);
    } catch {
      return res.status(400).json({ error: 'Invalid resolution map.' });
    }

    // ── Inventory: match or create, building the id map ──────────────────────
    const invMap = {};
    const bundledInventory = Array.isArray(bundle.inventory) ? bundle.inventory : [];
    const profilesByInv = new Map(
      (Array.isArray(bundle.firingProfiles) ? bundle.firingProfiles : [])
        .map((p) => [String(p.inventory_id), p]),
    );

    for (const inv of bundledInventory) {
      if (!inv || inv.id === undefined || inv.id === null) continue;
      const key = String(inv.id);
      const r = resolution[key] || { action: 'create' };

      if (r.action === 'match' && r.existingId !== undefined && r.existingId !== null) {
        invMap[inv.id] = r.existingId;
        invMap[key] = r.existingId;
        continue;
      }

      // create
      let created;
      try {
        created = await repo.inventory.create(inventoryPayload(inv));
      } catch (err) {
        warnings.push(`Failed to create inventory "${inv.name || key}": ${err?.message || err}`);
        continue;
      }
      invMap[inv.id] = created.id;
      invMap[key] = created.id;

      // Firing profile for the newly-created item, if the bundle carried one.
      const prof = profilesByInv.get(key);
      if (prof) {
        try {
          await repo.firingProfiles.create({
            inventory_id: created.id,
            youtube_link: prof.youtube_link ?? '',
            youtube_link_start_sec: prof.youtube_link_start_sec ?? 0,
            shot_timestamps: JSON.stringify(prof.shot_timestamps ?? []),
          });
        } catch (err) {
          warnings.push(`Failed to create firing profile for "${inv.name || key}": ${err?.message || err}`);
        }
      }
    }

    // ── Remap display_payload through the inventory id map ────────────────────
    const rawItems = Array.isArray(show.display_payload) ? show.display_payload : [];
    let items = rawItems.map((it) => deepRemap(it, invMap));

    // ── Audio: upload embedded bytes and rewrite track urls ──────────────────
    const audioObj = show.audio_file && typeof show.audio_file === 'object' ? show.audio_file : null;
    let audioForStore = audioObj;
    if (audioObj && Array.isArray(audioObj.tracks) && audioObj.tracks.length > 0) {
      const embedded = bundle.audio && Object.keys(bundle.audio).length > 0;
      if (embedded) {
        const store = getBlobStore('audio');
        const byTrack = new Map();
        for (const name of Object.keys(bundle.audio)) byTrack.set(entryTrackId(name), name);

        const tracks = [];
        for (const t of audioObj.tracks) {
          const entryName = byTrack.get(String(t?.id));
          if (!t || !entryName) {
            tracks.push(t);
            if (t) warnings.push(`No embedded audio for track "${t.name || t.id}" — left unresolved.`);
            continue;
          }
          const bytes = bundle.audio[entryName];
          const ext = audioExt(entryName) || audioExt(t.name) || '.mp3';
          const tmp = writeTemp(bytes, ext);
          // Build a clean "<base><ext>" name — strip any extension the track
          // name already carries so we don't produce "song.mp3.mp3".
          const baseName = String(t.name || t.id || 'audio').replace(/\.[a-z0-9]+$/i, '');
          try {
            const stored = await store.put({
              tmpPath: tmp,
              originalName: `${baseName}${ext}`.replace(/[^\w.\- ]+/g, '_'),
              mimetype: audioContentType(entryName),
              userId: ctx.userId,
            });
            tracks.push({ ...t, url: stored.url, key: stored.key, size: stored.size ?? t.size });
          } catch (err) {
            warnings.push(`Failed to store audio for track "${t.name || t.id}": ${err?.message || err}`);
            tracks.push(t);
            try { fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch { /* best effort */ }
          }
        }
        audioForStore = { ...audioObj, tracks };
      } else {
        warnings.push('Backup has no embedded audio — tracks imported without sound (re-attach in the builder).');
      }
    }

    // ── Create the show (fresh auth code) ────────────────────────────────────
    const authorization_code =
      String(firstVal(fields.authorization_code) || '').trim() ||
      crypto.randomBytes(4).toString('hex');
    const name = String(firstVal(fields.name) || '').trim() || show.name || 'Imported show';
    const protocol = firstVal(fields.protocol) || show.protocol || null;

    const showPayload = {
      name,
      duration: Math.max(0, Math.round(Number(show.duration) || 0)),
      version: String(show.version ?? '1'),
      runtime_version: String(show.runtime_version ?? '0'),
      display_payload: JSON.stringify(items),
      runtime_payload: jsonOrNull(show.runtime_payload ?? {}),
      authorization_code,
      protocol,
      audio_file: jsonOrNull(audioForStore),
      receiver_locations: jsonOrNull(show.receiver_locations),
      receiver_labels: jsonOrNull(show.receiver_labels),
      show_receivers: jsonOrNull(show.show_receivers),
    };

    const createdShow = await repo.shows.create(showPayload);
    const newShowId = createdShow.id;

    // ── Racks (remap show_id + cell/fuse inventory ids) ──────────────────────
    const rackMap = {};
    for (const rack of Array.isArray(bundle.racks) ? bundle.racks : []) {
      if (!rack) continue;
      try {
        const createdRack = await repo.racks.create({
          show_id: newShowId,
          name: rack.name || 'Rack',
          x_rows: Math.max(1, Math.round(Number(rack.x_rows) || 1)),
          x_spacing: Number(rack.x_spacing) || 0,
          y_rows: Math.max(1, Math.round(Number(rack.y_rows) || 1)),
          y_spacing: Number(rack.y_spacing) || 0,
          cells: JSON.stringify(deepRemap(rack.cells ?? {}, invMap)),
          fuses: JSON.stringify(remapFusesMap(rack.fuses ?? {}, invMap)),
        });
        if (rack.id !== undefined && rack.id !== null) rackMap[rack.id] = createdRack.id;
      } catch (err) {
        warnings.push(`Failed to create rack "${rack.name || rack.id}": ${err?.message || err}`);
      }
    }

    // ── Second pass: relink rackId back-references inside show items ──────────
    if (Object.keys(rackMap).length > 0) {
      let changed = false;
      items = items.map((it) => {
        if (it && typeof it === 'object' && it.rackId != null) {
          const mapped = rackMap[it.rackId] ?? rackMap[String(it.rackId)];
          if (mapped && mapped !== it.rackId) {
            changed = true;
            return { ...it, rackId: mapped };
          }
        }
        return it;
      });
      if (changed) {
        try {
          await repo.shows.update(newShowId, { ...showPayload, display_payload: JSON.stringify(items) });
        } catch (err) {
          warnings.push(`Failed to relink racks into the show: ${err?.message || err}`);
        }
      }
    }

    return res.status(201).json({
      id: newShowId,
      name,
      warnings,
      counts: {
        inventoryMatched: bundledInventory.filter((i) => resolution[String(i.id)]?.action === 'match').length,
        inventoryCreated: bundledInventory.length - bundledInventory.filter((i) => resolution[String(i.id)]?.action === 'match').length,
        racks: Object.keys(rackMap).length,
      },
    });
  } catch (error) {
    console.error('Show import failed:', error);
    return res.status(500).json({ error: `Failed to import show: ${error?.message || error}` });
  } finally {
    try { upload?.filepath && fs.existsSync(upload.filepath) && fs.unlinkSync(upload.filepath); } catch { /* best effort */ }
  }
}
