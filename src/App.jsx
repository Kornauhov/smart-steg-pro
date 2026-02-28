// App.jsx (MOVE TAB: NUR SLOT-UMAGERN PER QR)
// Copy/Paste Block: füge das in dein App.jsx ein (ersetzt deinen aktuellen "move"-Tab + remove entry-move stuff)
//
// VORAUSSETZUNGEN:
// - Du hast: slotMap (Map mit key `${shelf}|${level}`), levels = [5,4,3,2,1]
// - Du hast moveWholeSlot Modul (increment-safe) oder deine bisherige handleMoveWholeSlot-Logik.
//   Empfehlung: nutze moveWholeSlot aus ./modules/moveStock.js wie vorher.
// - Du hast: db, APP_ID, slotDocRef, itemDocRef, setActiveTab, activeTab, Icon, StatChip
//
// 1) OBEN in App.jsx: import erweitern
// import { moveWholeSlot } from "./modules/moveStock.js";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { moveWholeSlot } from "./modules/moveStock.js";

// -------------------- QR HELPERS --------------------
function parsePlace(text) {
  const raw = String(text || "").trim().toUpperCase();
  // akzeptiert: C1, C1-L5, C1_L5, C1 L5
  const m = raw.match(/^C(\d{1,2})(?:\s*[-_ ]?\s*L(\d))?$/);
  if (!m) return null;
  const shelf = `C${Number(m[1])}`;
  const level = m[2] ? Number(m[2]) : null;
  return { shelf, level };
}

// Quelle: nächstoberste belegte Ebene (oben -> unten: 5,4,3,2,1)
function findTopOccupiedLevel(slotMap, shelf, levels) {
  for (const lvl of levels) {
    const entries = slotMap.get(`${shelf}|${lvl}`) || [];
    if (entries.length) return lvl;
  }
  return null;
}

// Ziel: nächste freie Ebene von unten (unten -> oben: 1,2,3,4,5)
function findBottomEmptyLevel(slotMap, shelf, levels) {
  const bottomUp = [...levels].sort((a, b) => a - b); // [1..5]
  for (const lvl of bottomUp) {
    const entries = slotMap.get(`${shelf}|${lvl}`) || [];
    if (!entries.length) return lvl;
  }
  return null;
}

// -------------------- QR SCANNER COMPONENT --------------------
function QRScanner({ onResult, onError }) {
  const videoRef = useRef(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let stream;
    let raf;
    let detector;

    async function start() {
      try {
        if (!("BarcodeDetector" in window)) {
          onError?.(new Error("BarcodeDetector nicht verfügbar (Fallback nutzen)."));
          return;
        }

        detector = new window.BarcodeDetector({ formats: ["qr_code"] });

        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });

        if (!videoRef.current) return;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setRunning(true);

        const scan = async () => {
          try {
            if (!videoRef.current) return;
            const barcodes = await detector.detect(videoRef.current);
            if (barcodes?.length) {
              const value = barcodes[0].rawValue;
              if (value) onResult(value);
            }
          } catch (e) {
            // ignorieren, weiter scannen
          }
          raf = requestAnimationFrame(scan);
        };

        raf = requestAnimationFrame(scan);
      } catch (e) {
        onError?.(e);
      }
    }

    start();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      setRunning(false);
    };
  }, [onResult, onError]);

  return (
    <div className="bg-slate-900 rounded-2xl overflow-hidden border border-slate-700">
      <video ref={videoRef} className="w-full h-56 object-cover" playsInline muted />
      <div className="p-3 text-[11px] font-bold text-slate-300">
        {running ? "Scanner aktiv (QR ins Bild halten)" : "Scanner wird gestartet... (Fallback möglich)"}
      </div>
    </div>
  );
}

// -------------------- IN DEINER App COMPONENT: STATES + HANDLER --------------------
// Füge diese States in App() rein:
export function useMoveByQR({ slotMap, levels, db, APP_ID, slotDocRef, itemDocRef, setActiveTab }) {
  const [qrMode, setQrMode] = useState("source"); // "source" | "target"
  const [qrSource, setQrSource] = useState({ shelf: null, level: null });
  const [qrTarget, setQrTarget] = useState({ shelf: null, level: null });
  const [qrTextFallback, setQrTextFallback] = useState("");
  const [lastScan, setLastScan] = useState({ value: "", at: 0 });

  // Anti-Spam: gleiche QR nicht 20x pro Sekunde verarbeiten
  const applyScan = (raw) => {
    const now = Date.now();
    const val = String(raw || "").trim();
    if (!val) return;

    if (val === lastScan.value && now - lastScan.at < 1200) return;
    setLastScan({ value: val, at: now });

    const parsed = parsePlace(val);
    if (!parsed) {
      alert("❗ QR ungültig. Erwartet z.B. C1 oder C1-L5");
      return;
    }

    if (qrMode === "source") {
      const shelf = parsed.shelf;
      const level = parsed.level ?? findTopOccupiedLevel(slotMap, shelf, levels);
      if (!level) {
        alert(`ℹ️ ${shelf} hat keinen Bestand (keine belegte Ebene).`);
        return;
      }
      setQrSource({ shelf, level });
      setQrMode("target");
      return;
    }

    // target
    const shelf = parsed.shelf;
    const level = parsed.level ?? findBottomEmptyLevel(slotMap, shelf, levels);
    if (!level) {
      alert(`❗ ${shelf} ist voll (keine freie Ebene).`);
      return;
    }
    setQrTarget({ shelf, level });
  };

  const resetSource = () => {
    setQrMode("source");
    setQrSource({ shelf: null, level: null });
  };

  const resetTarget = () => {
    setQrTarget({ shelf: null, level: null });
  };

  const handleMoveByQR = async () => {
    if (!qrSource.shelf || !qrSource.level || !qrTarget.shelf || !qrTarget.level) return;

    const ok = confirm(
      `Slot umlagern?\n\n` +
        `Quelle: ${qrSource.shelf}-L${qrSource.level} (oberste belegte Ebene)\n` +
        `Ziel:   ${qrTarget.shelf}-L${qrTarget.level} (unterste freie Ebene)\n\n` +
        `Alle Stege werden verschoben.`
    );
    if (!ok) return;

    try {
      const res = await moveWholeSlot({
        db,
        APP_ID,
        slotDocRef,
        itemDocRef,
        sourceShelf: qrSource.shelf,
        sourceLevel: qrSource.level,
        targetShelf: qrTarget.shelf,
        targetLevel: qrTarget.level,
      });

      alert(`✅ Umlagerung fertig.\nSorten verschoben: ${res.movedTypes}`);

      // reset flow
      setQrSource({ shelf: null, level: null });
      setQrTarget({ shelf: null, level: null });
      setQrMode("source");
      setQrTextFallback("");
      setActiveTab?.("inventory");
    } catch (e) {
      console.error(e);
      alert(`❗ Fehler: ${e?.message || "Konsole prüfen"}`);
    }
  };

  // Live previews (optional)
  const sourceKey =
    qrSource.shelf && qrSource.level ? `${qrSource.shelf}|${Number(qrSource.level)}` : null;
  const targetKey =
    qrTarget.shelf && qrTarget.level ? `${qrTarget.shelf}|${Number(qrTarget.level)}` : null;

  const sourceEntries = useMemo(() => (sourceKey ? slotMap.get(sourceKey) || [] : []), [slotMap, sourceKey]);
  const targetEntries = useMemo(() => (targetKey ? slotMap.get(targetKey) || [] : []), [slotMap, targetKey]);

  const sourceStats = useMemo(
    () => ({
      types: sourceEntries.length,
      qty: sourceEntries.reduce((s, e) => s + (Number(e.quantity) || 0), 0),
    }),
    [sourceEntries]
  );

  const targetStats = useMemo(
    () => ({
      types: targetEntries.length,
      qty: targetEntries.reduce((s, e) => s + (Number(e.quantity) || 0), 0),
    }),
    [targetEntries]
  );

  return {
    qrMode,
    setQrMode,
    qrSource,
    qrTarget,
    qrTextFallback,
    setQrTextFallback,
    applyScan,
    handleMoveByQR,
    resetSource,
    resetTarget,
    sourceEntries,
    targetEntries,
    sourceStats,
    targetStats,
  };
}

// -------------------- MOVE TAB JSX (ersetze deinen activeTab === "move" Block) --------------------
// In App() rufst du den Hook so auf:
// const qr = useMoveByQR({ slotMap, levels, db, APP_ID, slotDocRef, itemDocRef, setActiveTab });
//
// Dann im return:

export function MoveTabQR({ qr, Icon, StatChip }) {
  return (
    <div className="space-y-4">
      <div className="bg-white p-7 rounded-[2.5rem] shadow-xl border border-slate-200 space-y-5">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-100 text-blue-600 rounded-xl">
            <Icon name="qr-code" />
          </div>
          <div className="min-w-0">
            <h3 className="font-black uppercase text-slate-800 italic text-xl leading-tight">
              Umlagern (QR)
            </h3>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
              Quelle scannen → Ziel scannen → Slot umlagern
            </p>
          </div>
        </div>

        <div className="flex gap-2 flex-wrap">
          <StatChip
            label="Modus"
            value={qr.qrMode === "source" ? "Quelle scannen" : "Ziel scannen"}
            tone="blue"
          />
          <StatChip
            label="Quelle"
            value={qr.qrSource.shelf ? `${qr.qrSource.shelf}-L${qr.qrSource.level}` : "—"}
            tone={qr.qrSource.shelf ? "emerald" : "slate"}
          />
          <StatChip
            label="Ziel"
            value={qr.qrTarget.shelf ? `${qr.qrTarget.shelf}-L${qr.qrTarget.level}` : "—"}
            tone={qr.qrTarget.shelf ? "emerald" : "slate"}
          />
        </div>

        <QRScanner
          onResult={(val) => qr.applyScan(val)}
          onError={() => {
            // Fallback bleibt aktiv
          }}
        />

        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-2">
          <div className="text-[10px] font-black uppercase text-slate-400">
            Fallback (wenn Scanner nicht geht)
          </div>
          <div className="flex gap-2">
            <input
              value={qr.qrTextFallback}
              onChange={(e) => qr.setQrTextFallback(e.target.value)}
              placeholder="z.B. C1 oder C2"
              className="flex-1 p-3 bg-white rounded-xl font-bold border-2 border-slate-100 outline-none"
            />
            <button
              type="button"
              onClick={() => qr.applyScan(qr.qrTextFallback)}
              className="px-4 py-3 bg-slate-900 text-yellow-500 rounded-xl font-black"
            >
              Anwenden
            </button>
          </div>
          <div className="text-[10px] text-slate-500 font-bold">
            Quelle: nimmt <span className="text-slate-900">oberste belegte</span> Ebene • Ziel: nimmt{" "}
            <span className="text-slate-900">unterste freie</span> Ebene
          </div>
        </div>

        {/* Live Vorschau Quelle */}
        {qr.qrSource.shelf && (
          <div className="bg-white border border-slate-200 rounded-[1.5rem] p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="font-black text-slate-800">
                Quelle: {qr.qrSource.shelf}-L{qr.qrSource.level}
              </div>
              <div className="text-[10px] font-black uppercase text-slate-400">Live Vorschau</div>
            </div>
            <div className="flex gap-2 flex-wrap">
              <StatChip label="Sorten" value={qr.sourceStats.types} tone={qr.sourceStats.types ? "blue" : "slate"} />
              <StatChip label="Gesamt" value={`${qr.sourceStats.qty} Stk`} tone={qr.sourceStats.qty ? "yellow" : "slate"} />
              <StatChip label="Status" value={qr.sourceEntries.length ? "Bestand vorhanden" : "Leer"} tone={qr.sourceEntries.length ? "emerald" : "rose"} />
            </div>

            {qr.sourceEntries.length ? (
              <div className="mt-3 space-y-2">
                {qr.sourceEntries.slice(0, 6).map((e) => (
                  <div key={e.id} className="flex items-center justify-between bg-slate-50 border border-slate-100 rounded-2xl px-3 py-2">
                    <div className="font-black text-slate-800 truncate pr-3">{e.itemKey}</div>
                    <div className="font-black text-slate-900 bg-white border border-slate-200 rounded-xl px-3 py-1 min-w-[64px] text-center">
                      {e.quantity}
                    </div>
                  </div>
                ))}
                {qr.sourceEntries.length > 6 && (
                  <div className="text-[10px] font-bold text-slate-400">
                    + {qr.sourceEntries.length - 6} weitere Sorten
                  </div>
                )}
              </div>
            ) : (
              <div className="mt-3 text-[11px] font-bold text-slate-500 italic">
                Keine Stege in diesem Slot.
              </div>
            )}
          </div>
        )}

        {/* Ziel Preview */}
        {qr.qrTarget.shelf && (
          <div className="bg-white border border-slate-200 rounded-[1.5rem] p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="font-black text-slate-800">
                Ziel: {qr.qrTarget.shelf}-L{qr.qrTarget.level}
              </div>
              <div className="text-[10px] font-black uppercase text-slate-400">Bestand im Ziel</div>
            </div>
            <div className="flex gap-2 flex-wrap">
              <StatChip label="Sorten" value={qr.targetStats.types} tone="slate" />
              <StatChip label="Gesamt" value={`${qr.targetStats.qty} Stk`} tone="slate" />
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={qr.handleMoveByQR}
          disabled={!qr.qrSource.shelf || !qr.qrTarget.shelf}
          className={`w-full py-5 text-white rounded-[1.5rem] font-black uppercase shadow-lg active:scale-95 transition-all sticky bottom-4 ${
            !qr.qrSource.shelf || !qr.qrTarget.shelf
              ? "bg-slate-300 shadow-none cursor-not-allowed"
              : "bg-blue-700 shadow-blue-700/20"
          }`}
        >
          Slot umlagern
        </button>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={qr.resetSource}
            className="flex-1 py-3 bg-slate-100 rounded-xl font-black text-[11px] text-slate-700"
          >
            Quelle zurücksetzen
          </button>
          <button
            type="button"
            onClick={qr.resetTarget}
            className="flex-1 py-3 bg-slate-100 rounded-xl font-black text-[11px] text-slate-700"
          >
            Ziel zurücksetzen
          </button>
        </div>
      </div>
    </div>
  );
}
