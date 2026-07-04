// Finale3D "BRP CSV" exporter (experimental).
//
// Reverse of Finale3DBrpCsvConverter — emits the tab-separated BRP layout the
// importer already reads, so BackyardHero ↔ Finale3D is a clean round trip
// through a format we parse. (We intentionally do NOT hand-write the
// proprietary .fin ZIP.)
//
// Column layout (0-based) the importer keys off:
//   0  Cue          sequence number (must be numeric so the header row is skipped)
//   1  Event Time   "HH:MM:SS.mmm"
//   4  Duration     seconds (float)
//   6  Description  label
//   12 Rail Address receiver key (our zone)
//   13 Pin Address  cue number (our target)
// All other columns are blank filler.

import { BaseShowExporter } from "./BaseShowExporter";

const COLUMNS = 14; // indices 0..13
const HEADER = (() => {
  const h = new Array(COLUMNS).fill("");
  h[0] = "Cue";
  h[1] = "Event Time";
  h[4] = "Duration";
  h[6] = "Description";
  h[12] = "Rail Address";
  h[13] = "Pin Address";
  return h;
})();

export class Finale3DBrpCsvExporter extends BaseShowExporter {
  static sourceId = "finale3d";
  static label = "Finale3D BRP CSV";
  static extension = ".csv";
  static mime = "text/csv";

  // Seconds → "HH:MM:SS.mmm" (clockToSeconds reads it as base-60).
  static clock(sec) {
    const s = Math.max(0, Number(sec) || 0);
    const whole = Math.floor(s);
    const ms = Math.round((s - whole) * 1000);
    const hh = Math.floor(whole / 3600);
    const mm = Math.floor((whole % 3600) / 60);
    const ss = whole % 60;
    return `${BaseShowExporter.pad(hh)}:${BaseShowExporter.pad(mm)}:${BaseShowExporter.pad(ss)}.${BaseShowExporter.pad(ms, 3)}`;
  }

  // Tab-separated, so scrub tabs/newlines from free text rather than quoting.
  static cell(v) {
    return String(v == null ? "" : v).replace(/[\t\r\n]+/g, " ").trim();
  }

  export(show) {
    const cues = BaseShowExporter.extractCues(show);
    const rows = [HEADER.map(Finale3DBrpCsvExporter.cell).join("\t")];

    cues.forEach((c, i) => {
      const row = new Array(COLUMNS).fill("");
      row[0] = String(i + 1);
      row[1] = Finale3DBrpCsvExporter.clock(c.startTime);
      row[4] = String(Number.isFinite(c.duration) ? c.duration : 0);
      row[6] = Finale3DBrpCsvExporter.cell(c.name);
      row[12] = Finale3DBrpCsvExporter.cell(c.zone);
      row[13] = String(c.target);
      rows.push(row.join("\t"));
    });

    return {
      text: rows.join("\r\n") + "\r\n",
      filename: BaseShowExporter.safeFilename(show?.name, ".csv"),
      mime: "text/csv",
    };
  }
}

export default Finale3DBrpCsvExporter;
