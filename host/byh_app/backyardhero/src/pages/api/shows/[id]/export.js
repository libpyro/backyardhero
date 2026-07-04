// GET /api/shows/[id]/export?audio=embed|link
//
// Streams a self-contained `.byh` backup (a zip — see @/util/showBundle) of one
// show: the show row (authorization_code omitted), the inventory + firing
// profiles it references, its racks, and — when audio=embed — the raw audio
// bytes for each track. Round-trips onto any machine via the import endpoints.
//
// audio mode: defaults to "embed" when the show has audio tracks, else "link".
// "link" omits the audio/ folder but always keeps the audio_file track metadata
// inside show.json (it's part of the show row and tiny), so timing/waveform
// config survives and the operator re-attaches the sound on import.

import fs from 'fs';
import { getRepo } from '@/data';
import { getBlobStore } from '@/data/blobStore';
import {
  BYH_FORMAT,
  BYH_SCHEMA_VERSION,
  collectInventoryIds,
  packBundle,
  parseJsonOrNull,
  audioExt,
} from '@/util/showBundle';

export const config = {
  api: {
    // Embedded audio can push the response past Next's default 4mb cap.
    responseLimit: false,
  },
};

// Read one track's bytes regardless of where they live:
//   data: URI            -> decode inline
//   http(s):// (cloud)   -> fetch the (signed) URL
//   /api/shows/audio/... -> local fs blob, key = last path segment
// Returns a Uint8Array, or null if the bytes can't be located.
async function readTrackBytes(store, url) {
  if (!url || typeof url !== 'string') return null;
  if (/^data:/i.test(url)) {
    const comma = url.indexOf(',');
    if (comma === -1) return null;
    return new Uint8Array(Buffer.from(url.slice(comma + 1), 'base64'));
  }
  if (/^https?:\/\//i.test(url)) {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return new Uint8Array(await resp.arrayBuffer());
  }
  const key = decodeURIComponent(url.split(/[?#]/)[0].split('/').pop() || '');
  if (!key || typeof store.openForServe !== 'function') return null;
  const found = store.openForServe(key);
  if (!found) return null;
  return new Uint8Array(fs.readFileSync(found.path));
}

function safeFilename(name) {
  const base = String(name || 'show').replace(/[^\w.\- ]+/g, '_').trim() || 'show';
  return `${base}.byh`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { id } = req.query;

  let repo;
  try {
    repo = await getRepo(req);
  } catch (err) {
    return res.status(err?.status || 500).json({ error: err?.message || 'Failed to resolve data context.' });
  }

  try {
    const shows = await repo.shows.list();
    const show = shows.find((s) => String(s.id) === String(id));
    if (!show) return res.status(404).json({ error: 'Show not found.' });

    const displayItems = parseJsonOrNull(show.display_payload) ?? [];
    const audioObj = parseJsonOrNull(show.audio_file);
    const tracks = Array.isArray(audioObj?.tracks) ? audioObj.tracks : [];

    // Racks (parse their JSON cells/fuses so the id scan + bundle see objects).
    const rackRows = await repo.racks.listByShow(show.id);
    const racks = (rackRows || []).map((r) => ({
      id: r.id,
      name: r.name,
      x_rows: r.x_rows,
      x_spacing: r.x_spacing,
      y_rows: r.y_rows,
      y_spacing: r.y_spacing,
      cells: parseJsonOrNull(r.cells) ?? {},
      fuses: parseJsonOrNull(r.fuses) ?? {},
    }));

    // Which inventory does this show reference (deep scan of items + racks)?
    const refIds = collectInventoryIds(displayItems, racks);
    const allInventory = await repo.inventory.list();
    const inventory = allInventory
      .filter((it) => refIds.has(String(it.id)))
      .map((it) => ({ ...it, metadata: parseJsonOrNull(it.metadata) }));
    const bundledInvIds = new Set(inventory.map((it) => String(it.id)));

    const allProfiles = await repo.firingProfiles.list();
    const firingProfiles = allProfiles
      .filter((p) => bundledInvIds.has(String(p.inventory_id)))
      .map((p) => ({
        inventory_id: p.inventory_id,
        youtube_link: p.youtube_link ?? '',
        youtube_link_start_sec: p.youtube_link_start_sec ?? 0,
        shot_timestamps: parseJsonOrNull(p.shot_timestamps) ?? [],
      }));

    // Audio mode: explicit ?audio= wins; otherwise embed iff the show has audio.
    const requested = String(req.query.audio || '').toLowerCase();
    const audioMode = requested === 'link' || requested === 'embed'
      ? requested
      : tracks.length > 0 ? 'embed' : 'link';

    const warnings = [];
    const audioFiles = [];
    if (audioMode === 'embed' && tracks.length > 0) {
      const store = getBlobStore('audio');
      for (const t of tracks) {
        if (!t || !t.url) continue;
        const bytes = await readTrackBytes(store, t.url);
        if (!bytes) {
          warnings.push(`Audio bytes missing for track "${t.name || t.id}"`);
          continue;
        }
        const ext = audioExt(t.url) || audioExt(t.name) || '.mp3';
        const tid = String(t.id || `${audioFiles.length}`).replace(/[^\w.\-]+/g, '_');
        audioFiles.push({ name: `audio/${tid}${ext}`, bytes });
      }
    }

    // Clean show.json: known columns only, JSON normalized to objects, and the
    // sensitive authorization_code stripped (import mints a fresh one). audio
    // metadata is always kept regardless of embed/link mode.
    const showJson = {
      name: show.name,
      duration: show.duration,
      version: show.version,
      runtime_version: show.runtime_version,
      display_payload: displayItems,
      runtime_payload: parseJsonOrNull(show.runtime_payload) ?? {},
      protocol: show.protocol ?? null,
      audio_file: audioObj ?? null,
      receiver_locations: parseJsonOrNull(show.receiver_locations),
      receiver_labels: parseJsonOrNull(show.receiver_labels),
      show_receivers: parseJsonOrNull(show.show_receivers),
    };

    const manifest = {
      format: BYH_FORMAT,
      schemaVersion: BYH_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      audioMode,
      counts: {
        inventory: inventory.length,
        firingProfiles: firingProfiles.length,
        racks: racks.length,
        audioTracks: tracks.length,
        audioEmbedded: audioFiles.length,
      },
      warnings,
    };

    const zip = packBundle({
      manifest,
      show: showJson,
      inventory,
      firingProfiles,
      racks,
      audioFiles,
    });

    const filename = safeFilename(show.name);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.setHeader('Content-Length', String(zip.length));
    return res.status(200).send(Buffer.from(zip));
  } catch (error) {
    console.error('Show export failed:', error);
    return res.status(500).json({ error: 'Failed to export show.' });
  }
}
