import React, { useMemo } from "react";
import { Field, inputClass } from "@/design";
import { summarizeResolution } from "@/util/showImport/byhBundle";

const fmtDuration = (s) => {
  if (!s || !Number.isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const r = Math.round(s) % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
};

// Native restore, final step: review what the backup will create and name the
// restored show. Protocol isn't asked for — the backup carries the show's own.
// Auth code is optional; leaving it blank lets the server mint a fresh one.
export default function NativeRestoreConfirm({
  bundle,
  resolution,
  name,
  onNameChange,
  authCode,
  onAuthCodeChange,
  saveError,
}) {
  const show = bundle?.show || null;
  const inv = summarizeResolution(bundle?.inventory, resolution);
  const rackCount = Array.isArray(bundle?.racks) ? bundle.racks.length : 0;
  const audioMode = bundle?.manifest?.audioMode || "link";
  const trackCount = Array.isArray(show?.audio_file?.tracks)
    ? show.audio_file.tracks.length
    : 0;

  const audioLabel = useMemo(() => {
    if (trackCount === 0) return "None";
    if (audioMode === "embed") return `${trackCount} embedded`;
    return `${trackCount} — re-attach`;
  }, [audioMode, trackCount]);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <SummaryCell label="Duration" value={fmtDuration(show?.duration)} />
        <SummaryCell
          label="Inventory"
          value={`${inv.total}`}
          hint={inv.total ? `${inv.matched} match · ${inv.created} new` : null}
        />
        <SummaryCell label="Racks" value={rackCount} />
        <SummaryCell label="Audio" value={audioLabel} />
      </div>

      {audioMode !== "embed" && trackCount > 0 ? (
        <div className="rounded-sm border border-warn/40 bg-warn-bg/60 px-3 py-2 text-xs text-warn-fg">
          This backup was saved without audio. The timeline and track settings
          restore, but you'll need to re-attach the audio file in the builder.
        </div>
      ) : null}

      <Field label="Show name">
        <input
          type="text"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          className={inputClass}
          placeholder="Restored show"
          autoFocus
        />
      </Field>

      <Field label="Auth code" hint="Used to edit and launch this show. Leave blank to generate one.">
        <input
          type="text"
          value={authCode}
          onChange={(e) => onAuthCodeChange(e.target.value)}
          className={inputClass}
          placeholder="Auto-generated if blank"
        />
      </Field>

      {saveError ? (
        <div className="rounded-sm border border-danger/40 bg-danger-bg/60 px-3 py-2 text-xs text-danger-fg">
          {saveError}
        </div>
      ) : null}
    </div>
  );
}

function SummaryCell({ label, value, hint }) {
  return (
    <div className="rounded-sm bg-surface-1 border border-border-subtle px-2 py-1.5">
      <div className="text-2xs text-fg-muted">{label}</div>
      <div className="num text-sm text-fg-primary leading-none mt-0.5 tabular-nums">
        {value}
      </div>
      {hint ? <div className="text-2xs text-fg-muted mt-0.5">{hint}</div> : null}
    </div>
  );
}
