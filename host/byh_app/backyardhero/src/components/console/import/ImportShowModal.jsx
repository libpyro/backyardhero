import React, { useEffect, useMemo, useState } from "react";
import { Modal, Button } from "@/design";
import useAppStore from "@/store/useAppStore";

import StepsHeader from "./StepsHeader";
import Step1SelectSource from "./Step1SelectSource";
import Step2ResolveReceivers from "./Step2ResolveReceivers";
import Step2ResolveInventory from "./Step2ResolveInventory";
import Step3MatchItems from "./Step3MatchItems";
import Step3Finalize from "./Step3Finalize";
import NativeRestoreConfirm from "./NativeRestoreConfirm";
import CueListModal from "./CueListModal";
import ResolveItemsModal from "./ResolveItemsModal";

import {
  IMPORT_SOURCES,
  getImportSource,
  getImportType,
  createConverter,
} from "@/util/showImport/registry";
import { BaseShowConverter } from "@/util/showImport/BaseShowConverter";
import { autoMatchLabels } from "@/util/showImport/itemMatch";
import { parseByhFile, autoMatchInventory } from "@/util/showImport/byhBundle";

const STEPS = [
  { id: 1, label: "Select & upload" },
  { id: 2, label: "Resolve receivers" },
  { id: 3, label: "Match items" },
  { id: 4, label: "Confirm" },
];

// Native `.byh` restore runs a shorter, distinct flow (see the `native` source
// in the registry). It carries a whole show, so there are no cues/receivers to
// resolve — only inventory to match or create.
const NATIVE_STEPS = [
  { id: 1, label: "Select & upload" },
  { id: 2, label: "Resolve inventory" },
  { id: 3, label: "Confirm" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const deriveName = (filename) =>
  String(filename || "")
    .replace(/\.[^.]+$/, "")
    .trim() || "Imported show";

export default function ImportShowModal({ isOpen, onClose, onImported }) {
  const dbReceivers = useAppStore((s) => s.receivers);
  const createShow = useAppStore((s) => s.createShow);
  const systemConfig = useAppStore((s) => s.systemConfig);
  const inventory = useAppStore((s) => s.inventory);
  const inventoryById = useAppStore((s) => s.inventoryById);
  const fetchShows = useAppStore((s) => s.fetchShows);
  const fetchInventory = useAppStore((s) => s.fetchInventory);

  const protocolKeys = useMemo(
    () => Object.keys(systemConfig?.protocols || {}),
    [systemConfig],
  );

  const [step, setStep] = useState(1);
  const [sourceId, setSourceId] = useState(null);
  const [typeId, setTypeId] = useState(null);
  const [file, setFile] = useState(null);

  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [processError, setProcessError] = useState(null);

  const [conversion, setConversion] = useState(null);
  const [resolutions, setResolutions] = useState({});

  const [name, setName] = useState("");
  const [authCode, setAuthCode] = useState("");
  const [protocol, setProtocol] = useState("");

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const [cueModal, setCueModal] = useState({ open: false, key: null });

  // Cue-name -> inventory id matches, plus the resolve window's open state.
  const [itemMatches, setItemMatches] = useState({});
  const [resolveOpen, setResolveOpen] = useState(false);

  // Native `.byh` restore state: the parsed bundle + per-item resolution map
  // (bundledInventoryId -> { action:"match", existingId } | { action:"create" }).
  const [bundle, setBundle] = useState(null);
  const [invResolution, setInvResolution] = useState({});

  // Reset everything whenever the modal (re)opens.
  useEffect(() => {
    if (!isOpen) return;
    setStep(1);
    setSourceId(null);
    setTypeId(null);
    setFile(null);
    setProcessing(false);
    setProgress(0);
    setProcessError(null);
    setConversion(null);
    setResolutions({});
    setName("");
    setAuthCode("");
    setProtocol(protocolKeys[0] || "");
    setSaving(false);
    setSaveError(null);
    setCueModal({ open: false, key: null });
    setItemMatches({});
    setResolveOpen(false);
    setBundle(null);
    setInvResolution({});
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const source = getImportSource(sourceId);
  const type = getImportType(sourceId, typeId);
  const isNative = !!source?.native;
  const steps = isNative ? NATIVE_STEPS : STEPS;

  const allResolved = useMemo(() => {
    const recs = conversion?.receivers || [];
    return recs.length > 0 && recs.every((r) => resolutions[r.key]);
  }, [conversion, resolutions]);

  const handleSelectSource = (id) => {
    const src = getImportSource(id);
    setSourceId(id);
    setTypeId(src?.types?.[0]?.id || null);
    setFile(null);
    setProcessError(null);
    setBundle(null);
    setInvResolution({});
  };

  const handleSelectType = (id) => {
    setTypeId(id);
    setFile(null);
    setProcessError(null);
  };

  // Native restore: read + validate the .byh in the browser, seed the
  // inventory resolution, and advance to the resolve step. The authoritative
  // parse happens server-side on commit.
  const handleProcessNative = async () => {
    if (!file) return;
    setProcessing(true);
    setProgress(20);
    setProcessError(null);
    const started = Date.now();
    const { bundle: parsed, error } = await parseByhFile(file);
    if (error) {
      setProcessError(error);
      setProgress(0);
      setProcessing(false);
      return;
    }
    setBundle(parsed);
    setInvResolution(autoMatchInventory(parsed.inventory, inventory));
    setName((n) => n || parsed.show?.name || deriveName(file.name));
    const elapsed = Date.now() - started;
    if (elapsed < 400) await sleep(400 - elapsed);
    setProgress(100);
    await sleep(150);
    setStep(2);
    setProcessing(false);
  };

  const handleProcess = async () => {
    if (isNative) return handleProcessNative();
    const converter = createConverter(sourceId, typeId);
    if (!converter || !file) return;
    setProcessing(true);
    setProgress(6);
    setProcessError(null);
    const started = Date.now();
    try {
      const conv = await converter.convert(file, {
        onProgress: (p) => setProgress((prev) => Math.max(prev, p)),
      });
      if (!conv || !conv.cues.length) {
        setProcessError(
          "No cues were found in this file. Double-check the file and import type.",
        );
        setProgress(0);
        setProcessing(false);
        return;
      }
      // Seed resolutions with auto-matches, de-duplicating so two imported
      // receivers can't claim the same real receiver.
      const claimed = new Set();
      const init = {};
      for (const r of conv.receivers) {
        const m = BaseShowConverter.matchReceiverId(r.key, dbReceivers);
        if (m && !claimed.has(m)) {
          init[r.key] = m;
          claimed.add(m);
        } else {
          init[r.key] = "";
        }
      }
      // Keep the processing bar visible long enough to read.
      const elapsed = Date.now() - started;
      if (elapsed < 650) await sleep(650 - elapsed);
      setProgress(100);
      await sleep(180);
      setConversion(conv);
      setResolutions(init);
      // Seed cue-name -> inventory matches from the current inventory.
      setItemMatches(autoMatchLabels(conv.cues, inventory));
      setName((n) => n || conv.suggestedName || deriveName(file.name));
      setStep(2);
    } catch (e) {
      setProcessError(e?.message || "Failed to process the file.");
      setProgress(0);
    } finally {
      setProcessing(false);
    }
  };

  const handleChangeResolution = (key, id) => {
    setResolutions((prev) => ({ ...prev, [key]: id }));
  };

  const handleSetMatch = (label, id) => {
    setItemMatches((prev) => ({ ...prev, [label]: id }));
  };

  const handleChangeInvResolution = (bundledId, entry) => {
    setInvResolution((prev) => ({ ...prev, [bundledId]: entry }));
  };

  // Native restore: upload the original .byh + resolution map to the commit
  // endpoint, then refresh the store so the restored show + any created
  // inventory appear immediately.
  const handleRestore = async () => {
    if (!file) return;
    setSaving(true);
    setSaveError(null);
    try {
      const fd = new FormData();
      fd.append("file", file, file.name);
      fd.append("resolution", JSON.stringify(invResolution));
      if (name.trim()) fd.append("name", name.trim());
      if (authCode.trim()) fd.append("authorization_code", authCode.trim());
      const res = await fetch("/api/shows/import", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSaveError(body?.error || "Failed to restore the backup.");
        setSaving(false);
        return;
      }
      await Promise.all([fetchShows?.(), fetchInventory?.()]);
      onImported?.(body.id);
      onClose?.();
    } catch (e) {
      setSaveError(e?.message || "Failed to restore the backup.");
    } finally {
      setSaving(false);
    }
  };

  const goToMatch = () => setStep(3);

  const goToFinalize = () => {
    if (!protocol) setProtocol(protocolKeys[0] || "");
    setStep(4);
  };

  const handleCreate = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const payload = BaseShowConverter.buildShowPayload({
        conversion,
        resolutions,
        name: name.trim(),
        authorization_code: authCode.trim(),
        protocol,
        itemMatches,
        inventoryById,
      });
      const id = await createShow(payload);
      if (!id) {
        setSaveError("Failed to create the show. See console for details.");
        setSaving(false);
        return;
      }
      onImported?.(id);
      onClose?.();
    } catch (e) {
      setSaveError(e?.message || "Failed to create the show.");
    } finally {
      setSaving(false);
    }
  };

  const cueModalReceiver =
    cueModal.open && conversion
      ? conversion.receivers.find((r) => r.key === cueModal.key)
      : null;
  const cueModalResolvedId = cueModalReceiver
    ? resolutions[cueModalReceiver.key]
    : null;
  const cueModalResolvedLabel = cueModalResolvedId
    ? dbReceivers?.[cueModalResolvedId]?.label || cueModalResolvedId
    : null;

  const nativeFooter = (
    <>
      {step === 1 ? (
        <>
          <Button variant="outline" onClick={onClose} disabled={processing}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleProcess}
            loading={processing}
            disabled={!file || processing}
          >
            Read backup
          </Button>
        </>
      ) : null}
      {step === 2 ? (
        <>
          <Button variant="outline" onClick={() => setStep(1)}>
            Back
          </Button>
          <Button variant="primary" onClick={() => setStep(3)}>
            Continue
          </Button>
        </>
      ) : null}
      {step === 3 ? (
        <>
          <Button variant="outline" onClick={() => setStep(2)} disabled={saving}>
            Back
          </Button>
          <Button
            variant="primary"
            onClick={handleRestore}
            loading={saving}
            disabled={!name.trim() || saving}
          >
            Restore show
          </Button>
        </>
      ) : null}
    </>
  );

  const converterFooter = (
    <>
      {step === 1 ? (
        <>
          <Button variant="outline" onClick={onClose} disabled={processing}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleProcess}
            loading={processing}
            disabled={!sourceId || !typeId || !file || processing}
          >
            Process
          </Button>
        </>
      ) : null}
      {step === 2 ? (
        <>
          <Button variant="outline" onClick={() => setStep(1)}>
            Back
          </Button>
          <Button variant="primary" onClick={goToMatch} disabled={!allResolved}>
            Continue
          </Button>
        </>
      ) : null}
      {step === 3 ? (
        <>
          <Button variant="outline" onClick={() => setStep(2)}>
            Back
          </Button>
          <Button variant="primary" onClick={goToFinalize}>
            Continue
          </Button>
        </>
      ) : null}
      {step === 4 ? (
        <>
          <Button variant="outline" onClick={() => setStep(3)} disabled={saving}>
            Back
          </Button>
          <Button
            variant="primary"
            onClick={handleCreate}
            loading={saving}
            disabled={!name.trim() || !authCode.trim() || !protocol || saving}
          >
            Create imported show
          </Button>
        </>
      ) : null}
    </>
  );

  const footer = isNative ? nativeFooter : converterFooter;

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Import a show"
        size="2xl"
        footer={footer}
      >
        <div className="flex flex-col gap-5">
          <StepsHeader
            steps={steps}
            current={step}
            progress={processing ? progress : null}
          />

          {step === 1 ? (
            <Step1SelectSource
              sources={IMPORT_SOURCES}
              sourceId={sourceId}
              onSelectSource={handleSelectSource}
              source={source}
              typeId={typeId}
              onSelectType={handleSelectType}
              type={type}
              file={file}
              onSelectFile={setFile}
              processing={processing}
              processError={processError}
            />
          ) : null}

          {/* Native `.byh` restore flow */}
          {isNative && step === 2 ? (
            <Step2ResolveInventory
              bundleInventory={bundle?.inventory}
              resolution={invResolution}
              onChange={handleChangeInvResolution}
              inventory={inventory}
            />
          ) : null}

          {isNative && step === 3 ? (
            <NativeRestoreConfirm
              bundle={bundle}
              resolution={invResolution}
              name={name}
              onNameChange={setName}
              authCode={authCode}
              onAuthCodeChange={setAuthCode}
              saveError={saveError}
            />
          ) : null}

          {/* Converter-backed flow (Finale3D / COBRA) */}
          {!isNative && step === 2 ? (
            <Step2ResolveReceivers
              conversion={conversion}
              resolutions={resolutions}
              dbReceivers={dbReceivers}
              onChangeResolution={handleChangeResolution}
              onOpenCueList={(key) => setCueModal({ open: true, key })}
            />
          ) : null}

          {!isNative && step === 3 ? (
            <Step3MatchItems
              conversion={conversion}
              itemMatches={itemMatches}
              inventoryById={inventoryById}
              onOpenResolve={() => setResolveOpen(true)}
            />
          ) : null}

          {!isNative && step === 4 ? (
            <Step3Finalize
              conversion={conversion}
              name={name}
              onNameChange={setName}
              authCode={authCode}
              onAuthCodeChange={setAuthCode}
              protocol={protocol}
              onProtocolChange={setProtocol}
              protocols={protocolKeys}
              saveError={saveError}
            />
          ) : null}
        </div>
      </Modal>

      <CueListModal
        isOpen={cueModal.open}
        onClose={() => setCueModal({ open: false, key: null })}
        receiver={cueModalReceiver}
        resolvedLabel={cueModalResolvedLabel}
      />

      <ResolveItemsModal
        isOpen={resolveOpen}
        onClose={() => setResolveOpen(false)}
        cues={conversion?.cues}
        itemMatches={itemMatches}
        onSetMatch={handleSetMatch}
      />
    </>
  );
}
