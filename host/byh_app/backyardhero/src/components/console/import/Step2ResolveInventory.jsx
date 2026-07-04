import React, { useEffect, useMemo, useState } from "react";
import { FaCheck, FaPlus } from "react-icons/fa";
import { Badge, Button, cn } from "@/design";
import { getTypeLabel } from "@/constants";
import InventorySearch from "./InventorySearch";

// Native-restore step 2: resolve each inventory item the backup references
// against this machine's inventory. For every bundled item the operator either
// matches an existing item (reusing InventorySearch) or creates a fresh copy.
// Master–detail: bundled items on the left, the selected item's resolver on the
// right. Every item always has a valid resolution (create by default), so the
// step can always continue.
//
// resolution: { [String(bundledId)]: { action:"match", existingId } | { action:"create" } }
export default function Step2ResolveInventory({
  bundleInventory,
  resolution,
  onChange,
  inventory,
}) {
  const items = useMemo(
    () =>
      (bundleInventory || [])
        .filter((it) => it && it.id !== undefined && it.id !== null)
        .slice()
        .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""))),
    [bundleInventory],
  );

  const invOptions = useMemo(
    () =>
      (inventory || [])
        .filter((it) => it)
        .slice()
        .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""))),
    [inventory],
  );
  const invById = useMemo(() => {
    const m = new Map();
    for (const it of invOptions) m.set(String(it.id), it);
    return m;
  }, [invOptions]);

  const [selectedId, setSelectedId] = useState(null);
  useEffect(() => {
    if (selectedId != null && items.some((it) => String(it.id) === String(selectedId))) return;
    setSelectedId(items[0] ? String(items[0].id) : null);
  }, [items, selectedId]);

  if (items.length === 0) {
    return (
      <div className="rounded-md border border-border-subtle bg-surface-base/40 px-4 py-6 text-center text-sm text-fg-muted">
        This backup references no inventory — nothing to resolve.
      </div>
    );
  }

  const selected = items.find((it) => String(it.id) === String(selectedId)) || null;
  const selRes = selected ? resolution?.[String(selected.id)] || { action: "create" } : null;
  const matchedExisting =
    selRes?.action === "match" ? invById.get(String(selRes.existingId)) : null;

  const setAction = (entry) => {
    if (selected) onChange(String(selected.id), entry);
  };

  return (
    <div className="flex flex-col md:flex-row h-[54vh] min-h-0 rounded-md border border-border-subtle overflow-hidden">
      {/* Master: bundled inventory list */}
      <div className="md:w-64 shrink-0 border-b md:border-b-0 md:border-r border-border-subtle overflow-y-auto max-h-40 md:max-h-none">
        <ul className="flex flex-col">
          {items.map((it) => {
            const r = resolution?.[String(it.id)] || { action: "create" };
            const active = String(it.id) === String(selectedId);
            return (
              <li key={it.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(String(it.id))}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-2 text-left border-l-2 transition-colors",
                    active
                      ? "bg-surface-3/60 border-accent"
                      : "border-transparent hover:bg-surface-3/30",
                  )}
                >
                  <span
                    className={cn(
                      "w-1.5 h-1.5 rounded-full shrink-0",
                      r.action === "match" ? "bg-ok" : "bg-accent",
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-fg-primary">{it.name}</span>
                    <span className="block truncate text-2xs text-fg-muted">
                      {getTypeLabel(it.type)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Detail: resolver for the selected bundled item */}
      <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-3 p-4">
        {selected ? (
          <>
            <div className="flex items-center gap-2 min-w-0 shrink-0">
              <h4 className="min-w-0 flex-1 truncate text-sm font-semibold text-fg-primary">
                {selected.name}
                {selected.type ? (
                  <span className="ml-1.5 text-2xs text-fg-muted">
                    {getTypeLabel(selected.type)}
                  </span>
                ) : null}
              </h4>
              {selRes?.action === "match" ? (
                <Badge tone="ok" size="sm" leading={<FaCheck className="w-2.5 h-2.5" />}>
                  {matchedExisting ? "Matched" : "Match (missing)"}
                </Badge>
              ) : (
                <Badge tone="neutral" size="sm" leading={<FaPlus className="w-2.5 h-2.5" />}>
                  Create new
                </Badge>
              )}
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <ChoiceButton
                active={selRes?.action === "create"}
                onClick={() => setAction({ action: "create" })}
              >
                Create a new copy
              </ChoiceButton>
              <ChoiceButton
                active={selRes?.action === "match"}
                onClick={() =>
                  setAction(
                    matchedExisting
                      ? selRes
                      : { action: "match", existingId: invOptions[0]?.id ?? null },
                  )
                }
                disabled={invOptions.length === 0}
              >
                Match an existing item
              </ChoiceButton>
            </div>

            {selRes?.action === "match" ? (
              <div className="border-t border-border-subtle pt-3 flex-1 min-h-0 flex flex-col">
                <InventorySearch
                  key={`byh-inv-${selected.id}`}
                  label={selected.name}
                  items={invOptions}
                  selectedId={selRes.existingId}
                  onSelect={(id) =>
                    setAction(
                      id == null ? { action: "create" } : { action: "match", existingId: id },
                    )
                  }
                  className="flex-1 min-h-0"
                />
              </div>
            ) : (
              <div className="border-t border-border-subtle pt-3 flex-1 min-h-0 flex items-center justify-center text-center text-sm text-fg-muted">
                A new inventory item will be created from the backup, preserving its
                firing profile.
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

function ChoiceButton({ active, onClick, disabled, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "px-2.5 py-1 text-xs rounded-sm border transition-colors",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        active
          ? "border-accent bg-surface-3/60 text-fg-primary"
          : "border-border text-fg-muted hover:bg-surface-3/30",
      )}
    >
      {children}
    </button>
  );
}
