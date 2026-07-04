// COBRA firing-system script CSV exporter (experimental).
//
// Reverse of CobraCsvConverter. Emits the three-section COBRA script:
//   #@firmware6.1
//   <script header>           (#Trigger Channel … #SMPTE Timecode)
//   <script values>           (Autofire, the show name, …)
//   <event header>            (#Event Time … #DMX Duration)
//   <event rows>              MM:SS.SSs, Channel, Cue, Description, ,
//   END
//
// Each BackyardHero receiver becomes a numbered COBRA channel; the item's
// target is the COBRA cue. Times are the COBRA clock "MM:SS.SSs".

import { BaseShowExporter } from "./BaseShowExporter";

const SCRIPT_HEADER = [
  "#Trigger Channel", "#Trigger Button", "#Deadman Button", "#Return Channel",
  "#AudioBox Filename", "#Script Name", "#Disable Firing Button",
  "#Alternate Firing Button", "#Alternate 2 Firing Button", "#SMPTE Timecode",
];

const EVENT_HEADER = [
  "#Event Time", "#Channel", "#Cue", "#Event Description", "#Disable Groups",
  "#Fire Time", "#DMX Ramp From Value", "#DMX Universe", "#DMX Channel",
  "#DMX Value", "#DMX Duration",
];

export class CobraCsvExporter extends BaseShowExporter {
  static sourceId = "cobra";
  static label = "COBRA Script CSV";
  static extension = ".csv";
  static mime = "text/csv";

  // Seconds → "MM:SS.SSs" (e.g. 64 → "01:04.00s"). Minutes are not wrapped to
  // hours — COBRA clocks run MM:SS.
  static clock(sec) {
    const s = Math.max(0, Number(sec) || 0);
    const mm = Math.floor(s / 60);
    const rem = s - mm * 60;
    return `${BaseShowExporter.pad(mm)}:${rem.toFixed(2).padStart(5, "0")}s`;
  }

  export(show) {
    const cues = BaseShowExporter.extractCues(show);
    const channels = BaseShowExporter.channelMap(cues);
    const scriptName = show?.name || "Show";

    const lines = [];
    lines.push("#@firmware6.1");
    lines.push(SCRIPT_HEADER.join(","));
    lines.push(
      ["0", "Autofire", "", "0", "", BaseShowExporter.csvField(scriptName), "", "", "2", ""].join(","),
    );
    lines.push(EVENT_HEADER.join(","));
    for (const c of cues) {
      lines.push(
        [
          CobraCsvExporter.clock(c.startTime),
          channels.get(c.zone),
          c.target,
          BaseShowExporter.csvField(c.name),
          "", // Disable Groups
          "", // Fire Time
        ].join(","),
      );
    }
    lines.push("END");

    return {
      text: lines.join("\r\n") + "\r\n",
      filename: BaseShowExporter.safeFilename(show?.name, ".csv"),
      mime: "text/csv",
    };
  }
}

export default CobraCsvExporter;
