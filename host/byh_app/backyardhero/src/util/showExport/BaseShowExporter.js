// Experimental show exporters — turn a BackyardHero show into a foreign
// firing-system script (COBRA / Finale3D). These are the reverse of the
// importers in util/showImport, run entirely client-side from the show's
// display_payload, and produce { text, filename, mime } for a Blob download.
//
// A BackyardHero show item carries: startTime (s), duration (s), target (the
// pin/cue number on its receiver) and zone (the resolved receiver key). That's
// exactly what both target formats key off — receiver + cue + time + label.

export class BaseShowExporter {
  static sourceId = "base";
  static label = "Base";
  static extension = ".txt";
  static mime = "text/plain";

  // Parse a show row's display_payload (JSON string or array) into a clean,
  // sorted list of exportable cues. Items without a receiver (zone) or a valid
  // positive target can't be expressed as a foreign cue, so they're dropped.
  static extractCues(show) {
    let items = [];
    const dp = show?.display_payload;
    if (Array.isArray(dp)) items = dp;
    else if (typeof dp === "string") {
      try {
        items = JSON.parse(dp || "[]");
      } catch {
        items = [];
      }
    }
    const cues = [];
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      const target = Number(it.target);
      const zone = it.zone != null ? String(it.zone).trim() : "";
      if (!zone || !Number.isFinite(target) || target <= 0) continue;
      cues.push({
        startTime: Number(it.startTime) || 0,
        duration: Number(it.duration) || 0,
        target,
        zone,
        name: (it.name && String(it.name).trim()) || `Cue ${target}`,
      });
    }
    cues.sort(
      (a, b) =>
        a.startTime - b.startTime ||
        a.zone.localeCompare(b.zone, undefined, { numeric: true }) ||
        a.target - b.target,
    );
    return cues;
  }

  // Distinct receivers (in numeric-aware order) → 1-based channel numbers,
  // for formats that address a numbered channel/module (COBRA).
  static channelMap(cues) {
    const zones = [...new Set(cues.map((c) => c.zone))].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    );
    const map = new Map();
    zones.forEach((z, i) => map.set(z, i + 1));
    return map;
  }

  static pad(n, width = 2) {
    return String(n).padStart(width, "0");
  }

  // Quote a CSV field when it contains the delimiter, a quote, or a newline.
  static csvField(value, delim = ",") {
    const s = value == null ? "" : String(value);
    if (s.includes(delim) || s.includes('"') || /[\r\n]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  static safeFilename(name, ext) {
    const base = String(name || "show").replace(/[^\w.\- ]+/g, "_").trim() || "show";
    return `${base}${ext}`;
  }

  // Subclasses return { text, filename, mime }.
  export() {
    throw new Error("export() not implemented");
  }
}

export default BaseShowExporter;
