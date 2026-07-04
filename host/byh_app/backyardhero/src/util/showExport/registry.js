// Registry of experimental show exporters (foreign firing-system formats),
// mirroring util/showImport/registry. Adding a format is a matter of writing a
// BaseShowExporter subclass and adding an entry here.

import { CobraCsvExporter } from "./CobraCsvExporter";
import { Finale3DBrpCsvExporter } from "./Finale3DBrpCsvExporter";

export const EXPORT_SOURCES = [
  {
    id: "cobra",
    name: "COBRA",
    typeLabel: "Script CSV (.csv)",
    experimental: true,
    ExporterClass: CobraCsvExporter,
  },
  {
    id: "finale3d",
    name: "Finale3D",
    typeLabel: "BRP CSV (.csv)",
    experimental: true,
    ExporterClass: Finale3DBrpCsvExporter,
  },
];

export function getExportSource(id) {
  return EXPORT_SOURCES.find((s) => s.id === id) || null;
}

export function createExporter(id) {
  const src = getExportSource(id);
  return src ? new src.ExporterClass() : null;
}
