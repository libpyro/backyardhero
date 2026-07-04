import React, { useMemo, useState } from "react";
import { FaFileExport, FaFlask } from "react-icons/fa";

import { IconButton, Modal, Button, Toggle, Badge } from "@/design";
import { parseAudioField } from "@/utils/audioTracks";
import { asyncAlert } from "@/components/common/AsyncPrompt";
import { EXPORT_SOURCES, createExporter } from "@/util/showExport/registry";

// Per-card "Export" action for the show picker. Opens a dialog offering:
//   • the native self-contained `.byh` backup (see @/util/showBundle), with an
//     optional "include audio" toggle when the show has audio, and
//   • experimental client-side exports to foreign firing-system formats
//     (COBRA / Finale3D CSV), built straight from the show's cues.

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return null;
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function safeName(name) {
  return String(name || "show").replace(/[^\w.\- ]+/g, "_").trim() || "show";
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function ExportShowMenu({ show }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [includeAudio, setIncludeAudio] = useState(true);
  const [byhBusy, setByhBusy] = useState(false);
  const [fmtBusy, setFmtBusy] = useState(null); // exporter id mid-download

  const audio = useMemo(() => {
    if (!show?.audio_file) return { tracks: [], bytes: 0 };
    try {
      const { tracks } = parseAudioField(JSON.parse(show.audio_file));
      const bytes = tracks.reduce((sum, t) => sum + (Number(t.size) || 0), 0);
      return { tracks, bytes };
    } catch {
      return { tracks: [], bytes: 0 };
    }
  }, [show?.audio_file]);

  const hasAudio = audio.tracks.length > 0;
  const audioSizeLabel = formatBytes(audio.bytes);

  const runByhExport = async () => {
    setByhBusy(true);
    try {
      const audioMode = hasAudio && includeAudio ? "embed" : "link";
      const res = await fetch(`/api/shows/${show.id}/export?audio=${audioMode}`);
      if (!res.ok) {
        const msg = await res.json().catch(() => ({}));
        throw new Error(msg?.error || `Export failed (${res.status}).`);
      }
      downloadBlob(await res.blob(), `${safeName(show.name)}.byh`);
      setModalOpen(false);
    } catch (err) {
      await asyncAlert({ title: "Export failed", message: err?.message || "Could not export the show." });
    } finally {
      setByhBusy(false);
    }
  };

  const runFormatExport = async (id) => {
    setFmtBusy(id);
    try {
      const exporter = createExporter(id);
      if (!exporter) throw new Error("Unknown export format.");
      const { text, filename, mime } = exporter.export(show);
      downloadBlob(new Blob([text], { type: mime || "text/plain" }), filename);
    } catch (err) {
      await asyncAlert({ title: "Export failed", message: err?.message || "Could not build the export." });
    } finally {
      setFmtBusy(null);
    }
  };

  const busy = byhBusy || fmtBusy != null;

  return (
    <>
      <IconButton
        label="Export / convert show"
        variant="ghost"
        size="sm"
        onClick={(e) => {
          e.stopPropagation();
          setIncludeAudio(true);
          setModalOpen(true);
        }}
      >
        <FaFileExport />
      </IconButton>

      <Modal
        isOpen={modalOpen}
        onClose={() => (busy ? null : setModalOpen(false))}
        title="Export show"
        size="md"
        footer={
          <Button variant="outline" onClick={() => setModalOpen(false)} disabled={busy}>
            Close
          </Button>
        }
      >
        <div className="flex flex-col gap-5">
          {/* Native backup */}
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h4 className="text-sm font-semibold text-fg-primary">BackyardHero backup</h4>
                <p className="text-2xs text-fg-muted">
                  Self-contained <span className="num">.byh</span> — restores on any machine.
                </p>
              </div>
              <Button variant="primary" size="sm" onClick={runByhExport} loading={byhBusy} disabled={busy}>
                Download .byh
              </Button>
            </div>
            {hasAudio ? (
              <Toggle
                checked={includeAudio}
                onChange={setIncludeAudio}
                label="Include audio in file"
                description={
                  audioSizeLabel
                    ? `Adds about ${audioSizeLabel}. Turn off for a small structure-only file.`
                    : "Turn off for a small structure-only file (re-attach audio on import)."
                }
              />
            ) : null}
          </section>

          {/* Experimental foreign-format exporters */}
          <section className="flex flex-col gap-2 border-t border-border-subtle pt-4">
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-semibold text-fg-primary">Convert to other systems</h4>
              <Badge tone="warn" size="sm" leading={<FaFlask className="w-2.5 h-2.5" />}>
                Experimental
              </Badge>
            </div>
            <p className="text-2xs text-fg-muted">
              Exports cue timing, receiver/channel and pin only — inventory, racks and audio are not included.
            </p>
            <div className="flex flex-col divide-y divide-border-subtle rounded-md border border-border-subtle">
              {EXPORT_SOURCES.map((src) => (
                <div key={src.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-sm text-fg-primary">{src.name}</div>
                    <div className="text-2xs text-fg-muted">{src.typeLabel}</div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => runFormatExport(src.id)}
                    loading={fmtBusy === src.id}
                    disabled={busy}
                  >
                    Export
                  </Button>
                </div>
              ))}
            </div>
          </section>
        </div>
      </Modal>
    </>
  );
}
