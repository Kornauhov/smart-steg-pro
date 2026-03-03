import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  forwardRef,
  useImperativeHandle,
} from "react";
import {
  collection,
  collectionGroup,
  deleteDoc,
  onSnapshot,
  query,
  updateDoc,
} from "firebase/firestore";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";

import { Html5Qrcode } from "html5-qrcode";

import { auth, db } from "./firebase/client.js";
import { DEBUG, APP_ID } from "./config/constants.js";
import { deriveFromPath, safeDocId, slotIdFrom } from "./utils/ids.js";
import { itemDocRef, slotDocRef } from "./firebase/refs.js";
import { moveWholeSlot } from "./modules/moveStock.js";
import { putawayStock } from "./modules/putawayStock.js";

import Icon from "./components/Icon.jsx";
import StatChip from "./components/StatChip.jsx";
import NavBtn from "./components/NavBtn.jsx";

/* =========================
   Helpers
========================= */
function parsePlace(text) {
  const raw = String(text || "").trim().toUpperCase();
  const m = raw.match(/^C(\d{1,2})(?:\s*[-_ ]?\s*L(\d))?$/);
  if (!m) return null;
  return { shelf: `C${Number(m[1])}`, level: m[2] ? Number(m[2]) : null };
}

/**
 * Etikett-Barcode (30 Ziffern)
 * Beispiel: 030000024438160000011600004316
 * - StegNr  = digits[7..13)  => 244381
 * - Länge   = digits[13..17) => 6000
 * - Menge   = digits[19..23) => 1160
 * - Extra   = digits[26..30) => 4316 (optional)
 */
function parseInboundBarcode(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length !== 30) return null;

  const itemKey = digits.slice(7, 13);
  const lengthMm = Number(digits.slice(13, 17));
  const qty = Number(digits.slice(19, 23));
  const extra = digits.slice(26, 30);

  if (!itemKey) return null;
  if (!Number.isFinite(lengthMm) || lengthMm <= 0) return null;
  if (!Number.isFinite(qty) || qty <= 0) return null;

  return { itemKey, lengthMm, qty, extra, raw: digits };
}

function findTopOccupiedLevel(slotMap, shelf, levelsTopDown) {
  for (const lvl of levelsTopDown) {
    const entries = slotMap.get(`${shelf}|${lvl}`) || [];
    if (entries.length) return lvl;
  }
  return null;
}

function findBottomEmptyLevel(slotMap, shelf, levelsTopDown) {
  const bottomUp = [...levelsTopDown].sort((a, b) => a - b);
  for (const lvl of bottomUp) {
    const entries = slotMap.get(`${shelf}|${lvl}`) || [];
    if (!entries.length) return lvl;
  }
  return null;
}

/* =========================
   Login Card
========================= */
function LoginCard({ onLogin, busy, error }) {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");

  return (
    <div className="bg-white p-7 rounded-[2.5rem] shadow-xl border border-slate-200 space-y-4">
      <div>
        <div className="text-[11px] font-black uppercase text-slate-400 tracking-widest">
          Mitarbeiter Login
        </div>
        <div className="text-2xl font-black text-slate-900 italic">Anmelden</div>
        <div className="text-xs font-bold text-slate-500 mt-1">
          Ohne Login kannst du nur ansehen.
        </div>
      </div>

      <input
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email"
        className="w-full p-4 bg-slate-50 rounded-2xl font-bold border-2 border-slate-100 outline-none focus:border-yellow-400"
      />
      <input
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        placeholder="Passwort"
        type="password"
        className="w-full p-4 bg-slate-50 rounded-2xl font-bold border-2 border-slate-100 outline-none focus:border-yellow-400"
      />

      {error ? (
        <div className="text-sm font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded-2xl p-3">
          {error}
        </div>
      ) : null}

      <button
        disabled={busy || !email || !pw}
        onClick={() => onLogin(email, pw)}
        className={`w-full py-4 rounded-[1.2rem] font-black uppercase text-white shadow-lg active:scale-95 transition-all ${
          busy || !email || !pw
            ? "bg-slate-300 cursor-not-allowed shadow-none"
            : "bg-slate-900 shadow-slate-900/20"
        }`}
      >
        {busy ? "Anmelden..." : "Login"}
      </button>

      <div className="text-[10px] text-slate-500 font-bold text-center">
        Rollen: Admin • Planung • Versorger
      </div>
    </div>
  );
}

/* =========================
   QRScanner (html5-qrcode)
   - AutoStart wenn enabled
   - steuerbar via ref.start / ref.stop
========================= */
const QRScanner = forwardRef(function QRScanner(
  { enabled, autoStart = false, onResult, onError },
  ref
) {
  const regionIdRef = useRef(`qr-reader-${Math.random().toString(16).slice(2)}`);
  const qrRef = useRef(null);

  const [running, setRunning] = useState(false);
  const lastTextRef = useRef("");

  const stop = async () => {
    try {
      if (!qrRef.current) return;
      await qrRef.current.stop().catch(() => {});
      await qrRef.current.clear().catch(() => {});
    } finally {
      setRunning(false);
      lastTextRef.current = "";
    }
  };

  const start = async () => {
    try {
      if (!enabled || running) return;

      if (!qrRef.current) {
        qrRef.current = new Html5Qrcode(regionIdRef.current);
      }

      setRunning(true);

      // 1) facingMode environment
      try {
        await qrRef.current.start(
          { facingMode: "environment" },
          { fps: 12, qrbox: { width: 260, height: 260 } },
          (decodedText) => {
            const t = String(decodedText || "").trim();
            if (!t) return;
            if (t === lastTextRef.current) return;
            lastTextRef.current = t;
            onResult(t);
          },
          () => {}
        );
        return;
      } catch (e) {
        console.warn("facingMode failed, fallback deviceId:", e);
      }

      // 2) deviceId fallback
      const cams = await Html5Qrcode.getCameras();
      if (!cams || cams.length === 0) {
        alert("❗ Keine Kamera gefunden.");
        setRunning(false);
        return;
      }
      const preferred =
        cams.find((c) => /back|rear|environment/i.test(c.label)) || cams[0];

      await qrRef.current.start(
        { deviceId: { exact: preferred.id } },
        { fps: 12, qrbox: { width: 260, height: 260 } },
        (decodedText) => {
          const t = String(decodedText || "").trim();
          if (!t) return;
          if (t === lastTextRef.current) return;
          lastTextRef.current = t;
          onResult(t);
        },
        () => {}
      );
    } catch (e) {
      console.error("QR start error:", e);
      setRunning(false);
      onError?.(e);
      alert(
        "❗ Kamera konnte nicht gestartet werden. (HTTPS + Kamera-Berechtigung prüfen)"
      );
    }
  };

  useImperativeHandle(ref, () => ({ start, stop, isRunning: () => running }), [
    running,
  ]);

  // ✅ AutoStart wenn enabled
  useEffect(() => {
    if (!enabled) {
      if (running) stop();
      return;
    }
    if (autoStart && !running) start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, autoStart]);

  useEffect(() => {
    return () => {
      stop();
      qrRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="bg-slate-900 rounded-2xl overflow-hidden border border-slate-700">
      <div id={regionIdRef.current} className="w-full" style={{ minHeight: 320 }} />

      <div className="p-3 flex items-center justify-between gap-2">
        <div className="text-[11px] font-bold text-slate-300">
          {!enabled ? "Scanner pausiert" : running ? "Scanner aktiv" : "Scanner startet…"}
        </div>

        {enabled && running ? (
          <button
            type="button"
            onClick={stop}
            className="px-4 py-2 bg-slate-700 text-white rounded-xl font-black text-[11px] active:scale-95"
          >
            Stop
          </button>
        ) : null}
      </div>
    </div>
  );
});

export default function App() {
  const [activeTab, setActiveTab] = useState("dashboard");
  const [loading, setLoading] = useState(true);

  // Auth
  const [user, setUser] = useState(null);
  const [role, setRole] = useState("guest"); // guest | versorger | planung | admin
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");

  // Data
  const [rawItems, setRawItems] = useState([]);
  const [stegItems, setStegItems] = useState([]);
  const [masterItems, setMasterItems] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");

  const shelves = useMemo(
    () => Array.from({ length: 38 }, (_, i) => `C${i + 1}`),
    []
  );
  const levels = [5, 4, 3, 2, 1];

  const refreshRole = async (u) => {
    if (!u) {
      setRole("guest");
      return;
    }
    try {
      const tok = await u.getIdTokenResult(true);
      const r = tok?.claims?.role ? String(tok.claims.role) : "guest";
      setRole(r);
    } catch {
      setRole("guest");
    }
  };

  const doLogin = async (email, pw) => {
    setAuthError("");
    setAuthBusy(true);
    try {
      const cred = await signInWithEmailAndPassword(auth, email, pw);
      setUser(cred.user);
      await refreshRole(cred.user);
      setActiveTab("dashboard");
    } catch (e) {
      console.error(e);
      setAuthError("Login fehlgeschlagen. Email/Passwort prüfen.");
    } finally {
      setAuthBusy(false);
    }
  };

  const doLogout = async () => {
    try {
      await signOut(auth);
    } finally {
      setUser(null);
      setRole("guest");
      setActiveTab("dashboard");
    }
  };

  const canWriteStock =
    role === "versorger" || role === "planung" || role === "admin";

  const goTab = (t) => {
    const protectedTabs = new Set(["add", "move", "outbound"]);
    if (protectedTabs.has(t) && !canWriteStock) {
      setActiveTab("dashboard"); // bleibt sichtbar, aber führt zurück
      return;
    }
    setActiveTab(t);
  };

  /* =========================
     EINLAGERN (AutoStart + AutoSwitch)
========================= */
  const inboundScannerRef = useRef(null);

  const [inStep, setInStep] = useState("place"); // "place" | "barcode"
  const inStepRef = useRef("place");
  const inboundIgnoreUntilRef = useRef(0);

  useEffect(() => {
    inStepRef.current = inStep;
  }, [inStep]);

  const [inPlace, setInPlace] = useState(null); // { shelf, level|null }
  const [barcodeRaw, setBarcodeRaw] = useState("");

  const [inbound, setInbound] = useState({
    itemKey: "",
    lengthMm: "",
    qty: "",
    deliveryDate: new Date().toISOString().slice(0, 10),
    extra: "",
  });

  const [manualStegQuery, setManualStegQuery] = useState("");

  const resetInboundAll = async () => {
    await inboundScannerRef.current?.stop?.();
    setInStep("place");
    inStepRef.current = "place";
    setInPlace(null);
    setBarcodeRaw("");
    setManualStegQuery("");
    setInbound({
      itemKey: "",
      lengthMm: "",
      qty: "",
      deliveryDate: new Date().toISOString().slice(0, 10),
      extra: "",
    });
    inboundIgnoreUntilRef.current = Date.now() + 500;
    setTimeout(() => inboundScannerRef.current?.start?.(), 250);
  };

  const resetInboundToPlace = async () => {
    await inboundScannerRef.current?.stop?.();
    setInStep("place");
    inStepRef.current = "place";
    setInPlace(null);
    setBarcodeRaw("");
    setInbound((x) => ({ ...x, itemKey: "", lengthMm: "", qty: "", extra: "" }));
    inboundIgnoreUntilRef.current = Date.now() + 700;
    setTimeout(() => inboundScannerRef.current?.start?.(), 250);
  };

  const resetInboundToBarcode = async () => {
    if (!inPlace?.shelf) {
      alert("Bitte zuerst Platz scannen.");
      return;
    }
    await inboundScannerRef.current?.stop?.();
    setInStep("barcode");
    inStepRef.current = "barcode";
    setBarcodeRaw("");
    setInbound((x) => ({ ...x, itemKey: "", lengthMm: "", qty: "", extra: "" }));
    inboundIgnoreUntilRef.current = Date.now() + 700;
    setTimeout(() => inboundScannerRef.current?.start?.(), 250);
  };

  const onScanPlaceForInbound = async (decodedText) => {
    const p = parsePlace(decodedText);
    if (!p) {
      alert("❗ Platz ungültig. Erwartet z.B. C1 oder C1-L3");
      return;
    }

    setInPlace(p);

    // ✅ sofort barcode mode
    setInStep("barcode");
    inStepRef.current = "barcode";

    // ✅ ignore next frames
    inboundIgnoreUntilRef.current = Date.now() + 900;

    // ✅ stop and restart scanner -> clean switch
    await inboundScannerRef.current?.stop?.();
    setTimeout(() => inboundScannerRef.current?.start?.(), 250);

    try {
      navigator.vibrate?.(30);
    } catch {}
  };

  const onScanBarcodeForInbound = async (decodedText) => {
    const raw = String(decodedText || "").trim();
    if (!raw) return;

    const p = parseInboundBarcode(raw);
    if (!p) {
      alert("❗ Barcode-Format unbekannt. Erwartet 30 Ziffern.");
      return;
    }

    setBarcodeRaw(p.raw);
    setInbound((x) => ({
      ...x,
      itemKey: p.itemKey,
      lengthMm: String(p.lengthMm),
      qty: String(p.qty),
      extra: p.extra,
    }));

    // ✅ stop after barcode scan to prevent double scans
    await inboundScannerRef.current?.stop?.();
    inboundIgnoreUntilRef.current = Date.now() + 600;

    try {
      navigator.vibrate?.([30, 30]);
    } catch {}
  };

  const reqMissing = useMemo(() => {
    return {
      place: !inPlace?.shelf,
      itemKey: !String(inbound.itemKey || "").trim(),
      qty: !(Number(inbound.qty) > 0),
      lengthMm: !(Number(inbound.lengthMm) > 0),
    };
  }, [inPlace, inbound]);

  const canPutaway =
    canWriteStock &&
    !reqMissing.place &&
    !reqMissing.itemKey &&
    !reqMissing.qty &&
    !reqMissing.lengthMm;

  /* =========================
     Auth init (Email/Passwort + Guest)
========================= */
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u || null);
      await refreshRole(u || null);
      setLoading(false);
    });
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (window.lucide) window.lucide.createIcons();
  }, [activeTab, rawItems.length, stegItems.length, masterItems.length, searchQuery]);

  /* =========================
     Firestore subscriptions
     - Für Gäste: READ ist erlaubt (Rules)
     - Für eingeloggte: auch read
========================= */
  useEffect(() => {
    // Wir laden Daten auch ohne Login (guest view).
    // Falls du lesen NUR mit Auth willst -> Rules ändern und hier: if (!user) return;
    const itemsQ = query(collectionGroup(db, "items"));
    const unsubItems = onSnapshot(
      itemsQ,
      (snap) => {
        const docs = snap.docs.map((d) => ({
          __path: d.ref.path,
          __id: d.id,
          ...d.data(),
        }));
        if (DEBUG) console.log("RAW items snap:", snap.size, docs.slice(0, 3));
        setRawItems(docs);
      },
      (err) => console.error("Items fetch error:", err)
    );

    const unsubSteg = onSnapshot(
      collection(db, "artifacts", APP_ID, "public", "data", "steg_items"),
      (snap) => {
        const items = snap.docs
          .map((d) => {
            const data = d.data();
            return { id: d.id, code: data.code || data.name || d.id, ...data };
          })
          .sort((a, b) => String(a.code).localeCompare(String(b.code)));
        setStegItems(items);
      },
      (err) => console.error("Steg items fetch error:", err)
    );

    const unsubMaster = onSnapshot(
      collection(db, "artifacts", APP_ID, "public", "data", "master_items"),
      (snap) => setMasterItems(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (err) => console.error("Master items fetch error:", err)
    );

    return () => {
      unsubItems();
      unsubSteg();
      unsubMaster();
    };
  }, []);

  /* =========================
     Normalize item docs
========================= */
  const itemDocs = useMemo(() => {
    const out = [];

    for (const d of rawItems) {
      const path = d.__path || "";
      const pathHasApp = path.includes(`artifacts/${APP_ID}/`);
      const fieldHasApp = String(d.appId || "") === APP_ID;
      if (!pathHasApp && !fieldHasApp) continue;

      const derived = deriveFromPath(path);

      const shelf = d.shelf ?? d.location?.shelf ?? derived.shelf;
      const level = Number(d.level ?? d.location?.level ?? derived.level);
      const slotId =
        d.slotId ??
        derived.slotId ??
        (shelf && level ? slotIdFrom(shelf, level) : null);

      const itemKey = d.itemKey ?? d.key ?? d.code ?? d.__id;
      const quantity = Number(d.quantity) || 0;

      if (!shelf || !level || !slotId || !itemKey) continue;
      if (quantity <= 0) continue;

      out.push({
        id: `${slotId}__${safeDocId(itemKey)}`,
        firestoreId: d.__id,
        path,
        appId: d.appId || APP_ID,
        slotId,
        shelf,
        level,
        itemKey: String(itemKey),
        quantity,
      });
    }

    return out;
  }, [rawItems]);

  /* =========================
     slotMap + stats
========================= */
  const slotMap = useMemo(() => {
    const m = new Map();
    for (const it of itemDocs) {
      const key = `${it.shelf}|${it.level}`;
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(it);
    }
    for (const [k, arr] of m.entries()) {
      arr.sort((a, b) => String(a.itemKey).localeCompare(String(b.itemKey)));
      m.set(k, arr);
    }
    return m;
  }, [itemDocs]);

  const occupiedSlots = slotMap.size;
  const totalParts = useMemo(
    () => itemDocs.reduce((s, x) => s + (Number(x.quantity) || 0), 0),
    [itemDocs]
  );

  /* =========================
     AWB index
========================= */
  const awbIndex = useMemo(() => {
    const m = new Map();
    for (const it of masterItems) {
      const awb = it?.awb ? String(it.awb) : null;
      if (!awb) continue;
      for (const steg of [it?.steg1, it?.steg2]) {
        if (!steg) continue;
        const key = String(steg).toUpperCase();
        if (!m.has(key)) m.set(key, new Set());
        m.get(key).add(awb);
      }
    }
    return m;
  }, [masterItems]);

  const getLinkedAWBs = (stegCode) => {
    const s = awbIndex.get(String(stegCode || "").toUpperCase());
    return s ? Array.from(s) : [];
  };

  /* =========================
     grouped + filtered slots
========================= */
  const groupedSlots = useMemo(() => {
    const rows = Array.from(slotMap.entries()).map(([key, entries]) => {
      const [shelf, levelStr] = key.split("|");
      return { shelf, level: Number(levelStr), entries };
    });
    const shelfNum = (s) => Number(String(s).replace("C", "")) || 0;
    rows.sort((a, b) => {
      const ds = shelfNum(a.shelf) - shelfNum(b.shelf);
      if (ds !== 0) return ds;
      return b.level - a.level;
    });
    return rows;
  }, [slotMap]);

  const filteredSlots = useMemo(() => {
    const term = searchQuery.trim().toUpperCase();
    if (!term) return groupedSlots;

    return groupedSlots
      .map((slot) => {
        const shelfMatch = String(slot.shelf).toUpperCase().includes(term);
        const matched = slot.entries.filter((e) => {
          const keyMatch = String(e.itemKey).toUpperCase().includes(term);
          const awbMatch = getLinkedAWBs(e.itemKey).some((a) =>
            String(a).toUpperCase().includes(term)
          );
          const lvlMatch = `L${slot.level}`.includes(term);
          return keyMatch || awbMatch || shelfMatch || lvlMatch;
        });

        const entriesToShow = shelfMatch ? slot.entries : matched;
        if (!entriesToShow.length) return null;
        return { ...slot, entries: entriesToShow };
      })
      .filter(Boolean);
  }, [groupedSlots, searchQuery, awbIndex]);

  /* =========================
     Einlagern: Putaway
========================= */
  const doInboundPutaway = async () => {
    try {
      if (!canWriteStock) return alert("❗ Bitte als Mitarbeiter anmelden (Versorger/Planung/Admin).");
      if (!inPlace?.shelf) return alert("Bitte zuerst Platz scannen.");

      const itemKey = String(inbound.itemKey || "").trim();
      const qty = Number(inbound.qty);
      const lengthMm = Number(inbound.lengthMm);

      if (!itemKey) return alert("Steg-Nr fehlt.");
      if (!qty || qty <= 0) return alert("Menge fehlt/ungültig.");
      if (!lengthMm || lengthMm <= 0) return alert("Länge fehlt/ungültig.");

      const res = await putawayStock({
        APP_ID,
        slotDocRef,
        itemDocRef,
        slotMap,
        shelves,
        levels,
        itemKey,
        qty,
        preferredShelf: inPlace.shelf,
        preferredLevel: inPlace.level ?? null,
        source: "anlieferung",
        meta: {
          lengthMm,
          deliveryDate: inbound.deliveryDate || null,
          barcodeRaw: barcodeRaw || null,
          barcodeExtra: inbound.extra || null,
        },
      });

      alert(`✅ Eingelagert in ${res.shelf}-L${res.level}`);

      await resetInboundAll();
      setActiveTab("inventory");
    } catch (e) {
      console.error(e);
      alert(`❗ Fehler: ${e?.message || "Konsole prüfen"}`);
    }
  };

  const stegCandidates = useMemo(() => {
    const q = String(manualStegQuery || "").trim().replace(/\D/g, "");
    if (!q) return [];
    return stegItems
      .map((s) => String(s.code || s.id || ""))
      .filter(Boolean)
      .filter((code) => code.startsWith(q))
      .slice(0, 8);
  }, [manualStegQuery, stegItems]);

  const suggestedSteg = stegCandidates[0] || "";

  /* =========================
     OUTBOUND
========================= */
  const entryOptions = useMemo(() => {
    const shelfNum = (s) => Number(String(s).replace("C", "")) || 0;
    const arr = itemDocs.map((x) => ({
      entryId: `${x.slotId}__${safeDocId(x.itemKey)}`,
      slotId: x.slotId,
      shelf: x.shelf,
      level: x.level,
      itemKey: x.itemKey,
      quantity: x.quantity,
    }));
    arr.sort((a, b) => {
      const ds = shelfNum(a.shelf) - shelfNum(b.shelf);
      if (ds !== 0) return ds;
      const dl = b.level - a.level;
      if (dl !== 0) return dl;
      return String(a.itemKey).localeCompare(String(b.itemKey));
    });
    return arr;
  }, [itemDocs]);

  const [outStock, setOutStock] = useState({
    entryId: "",
    qty: "",
    destination: "produktion",
  });

  const handleRemoveStock = async (e) => {
    e.preventDefault();
    if (!canWriteStock) return alert("❗ Bitte als Mitarbeiter anmelden (Versorger/Planung/Admin).");

    const qty = Number(outStock.qty);
    if (!outStock.entryId || !qty || qty <= 0) return;

    const selected = entryOptions.find((x) => x.entryId === outStock.entryId);
    if (!selected) return;

    if (selected.quantity < qty) {
      alert("❗ Entnahmemenge ist größer als der aktuelle Bestand.");
      return;
    }

    const iRef = itemDocRef(selected.slotId, selected.itemKey);
    try {
      const newQty = selected.quantity - qty;
      if (newQty <= 0) await deleteDoc(iRef);
      else
        await updateDoc(iRef, {
          quantity: newQty,
          updatedAt: Date.now(),
          lastDestination: outStock.destination,
        });

      setOutStock({ entryId: "", qty: "", destination: "produktion" });
      setActiveTab("inventory");
    } catch (err) {
      console.error("Remove error:", err);
      alert("❗ Fehler beim Auslagern (Konsole prüfen).");
    }
  };

  /* =========================
     MOVE (QR SLOT ONLY)
========================= */
  const [qrSource, setQrSource] = useState({ shelf: null, level: null });
  const [qrTarget, setQrTarget] = useState({ shelf: null, level: null });
  const [qrTextFallback, setQrTextFallback] = useState("");

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const [lastScan, setLastScan] = useState({ value: "", at: 0 });

  const stepRef = useRef("source");
  const ignoreUntilRef = useRef(0);

  const resetMoveAll = () => {
    stepRef.current = "source";
    setQrSource({ shelf: null, level: null });
    setQrTarget({ shelf: null, level: null });
    setQrTextFallback("");
    setConfirmOpen(false);
  };

  const resetSource = () => {
    stepRef.current = "source";
    setQrSource({ shelf: null, level: null });
    setQrTarget({ shelf: null, level: null });
    setConfirmOpen(false);
  };

  const resetTarget = () => {
    stepRef.current = "target";
    setQrTarget({ shelf: null, level: null });
    setConfirmOpen(false);
  };

  const applyScan = (raw) => {
    if (!canWriteStock) return;
    if (moving || confirmOpen) return;
    const now = Date.now();
    if (now < ignoreUntilRef.current) return;

    const val = String(raw || "").trim();
    if (!val) return;

    if (val === lastScan.value && now - lastScan.at < 900) return;
    setLastScan({ value: val, at: now });

    const parsed = parsePlace(val);
    if (!parsed) {
      alert("❗ QR ungültig. Erwartet z.B. C8 oder C8-L3");
      return;
    }

    const step = stepRef.current;
    const cooldownAfterSourceMs = 1200;
    const sourceSetAtRef =
      applyScan.sourceSetAtRef || (applyScan.sourceSetAtRef = { t: 0 });
    const sourceShelfRef =
      applyScan.sourceShelfRef || (applyScan.sourceShelfRef = { shelf: null });

    if (step === "source") {
      const lvl = parsed.level ?? findTopOccupiedLevel(slotMap, parsed.shelf, levels);
      if (!lvl) {
        alert(`ℹ️ ${parsed.shelf} hat keinen Bestand.`);
        return;
      }

      setQrSource({ shelf: parsed.shelf, level: lvl });
      stepRef.current = "target";

      sourceShelfRef.shelf = parsed.shelf;
      sourceSetAtRef.t = Date.now();

      ignoreUntilRef.current = Date.now() + cooldownAfterSourceMs;
      try {
        navigator.vibrate?.(30);
      } catch {}
      return;
    }

    if (now - sourceSetAtRef.t < cooldownAfterSourceMs) return;

    if (sourceShelfRef.shelf && parsed.shelf === sourceShelfRef.shelf) {
      alert(`ℹ️ Ziel muss ein anderes Regal sein als die Quelle (${sourceShelfRef.shelf}).`);
      ignoreUntilRef.current = Date.now() + 800;
      return;
    }

    const lvl = parsed.level ?? findBottomEmptyLevel(slotMap, parsed.shelf, levels);
    if (!lvl) {
      alert(`❗ ${parsed.shelf} ist voll.`);
      ignoreUntilRef.current = Date.now() + 800;
      return;
    }

    setQrTarget({ shelf: parsed.shelf, level: lvl });
    setConfirmOpen(true);
    try {
      navigator.vibrate?.([30, 30, 30]);
    } catch {}
  };

  const doMove = async () => {
    if (!canWriteStock) return alert("❗ Bitte als Mitarbeiter anmelden (Versorger/Planung/Admin).");
    if (!qrSource.shelf || !qrTarget.shelf) return;

    setMoving(true);
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
      resetMoveAll();
      setActiveTab("inventory");
    } catch (e) {
      console.error(e);
      alert(`❗ Fehler: ${e?.message || "Konsole prüfen"}`);
      setConfirmOpen(false);
    } finally {
      setMoving(false);
      ignoreUntilRef.current = Date.now() + 800;
    }
  };

  const scannerEnabled =
    canWriteStock && activeTab === "move" && !confirmOpen && !moving;

  /* =========================
     Loading
========================= */
  if (loading) {
    return (
      <div className="h-screen flex flex-col items-center justify-center bg-slate-900 text-yellow-500">
        <div className="w-16 h-16 border-4 border-yellow-500 border-t-transparent rounded-full animate-spin mb-6"></div>
        <p className="font-black italic uppercase tracking-widest">System wird initialisiert...</p>
      </div>
    );
  }

  const roleLabel =
    role === "admin"
      ? "ADMIN"
      : role === "planung"
      ? "PLANUNG"
      : role === "versorger"
      ? "VERSORGER"
      : "GAST";

  return (
    <div className="max-w-4xl mx-auto min-h-screen pb-36 relative">
      {DEBUG && (
        <div className="fixed top-3 right-3 z-[999] bg-white/90 backdrop-blur border border-slate-200 shadow-lg rounded-2xl px-4 py-3 text-[11px] font-bold text-slate-700">
          <div>
            RAW docs: <span className="text-slate-900">{rawItems.length}</span>
          </div>
          <div>
            APP docs: <span className="text-slate-900">{itemDocs.length}</span>
          </div>
          <div>
            Slots: <span className="text-slate-900">{occupiedSlots}</span>
          </div>
          <div>
            Sum qty: <span className="text-slate-900">{totalParts}</span>
          </div>
          <div className="mt-2">
            Role: <span className="text-slate-900">{roleLabel}</span>
          </div>
        </div>
      )}

      <header className="bg-slate-900 text-white p-6 rounded-b-[2.5rem] shadow-2xl border-b-4 border-yellow-500 sticky top-0 z-50">
        <div className="flex justify-between items-center max-w-2xl mx-auto">
          <div>
            <h1 className="text-2xl font-black italic tracking-tighter uppercase leading-none">
              Smart Steg <span className="text-yellow-500">PRO</span>
            </h1>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">
              Lagerverwaltung Kran-Gestell
            </p>

            <div className="mt-2 flex items-center gap-2">
              <span
                className={`text-[10px] font-black uppercase px-3 py-1 rounded-full border ${
                  role === "guest"
                    ? "bg-slate-800 text-slate-300 border-slate-700"
                    : "bg-yellow-500 text-slate-900 border-yellow-400"
                }`}
              >
                {roleLabel}
              </span>

              {user ? (
                <button
                  type="button"
                  onClick={doLogout}
                  className="text-[10px] font-black uppercase px-3 py-1 rounded-full bg-slate-800 border border-slate-700 text-slate-200 active:scale-95"
                >
                  Logout
                </button>
              ) : (
                <span className="text-[10px] font-bold text-slate-500">
                  (nur Ansicht)
                </span>
              )}
            </div>
          </div>

          <div className="bg-slate-800 p-3 rounded-2xl text-yellow-500 shadow-inner">
            <Icon name="factory" size={24} />
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto mt-6 px-4">
        {/* DASHBOARD */}
        {activeTab === "dashboard" && (
          <div className="space-y-6">
            {role === "guest" ? (
              <LoginCard onLogin={doLogin} busy={authBusy} error={authError} />
            ) : null}

            <div className="grid grid-cols-3 gap-3">
              <div className="bg-white p-4 rounded-3xl shadow-sm border border-slate-200">
                <p className="text-[9px] font-black text-slate-400 uppercase mb-1">Stege DB</p>
                <p className="text-2xl font-black text-slate-800 leading-none">{stegItems.length}</p>
              </div>
              <div className="bg-white p-4 rounded-3xl shadow-sm border border-slate-200">
                <p className="text-[9px] font-black text-slate-400 uppercase mb-1">Teile Gesamt</p>
                <p className="text-2xl font-black text-yellow-600 leading-none">{totalParts}</p>
              </div>
              <div className="bg-white p-4 rounded-3xl shadow-sm border border-slate-200">
                <p className="text-[9px] font-black text-slate-400 uppercase mb-1">Belegte Plätze</p>
                <p className="text-2xl font-black text-slate-800 leading-none">{occupiedSlots}/190</p>
              </div>
            </div>

            <div className="bg-slate-900 p-6 rounded-[2.5rem] shadow-2xl text-white">
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-xs font-black uppercase text-yellow-500 tracking-widest flex items-center gap-2">
                  <Icon name="grid" size={16} /> Aktuelle Belegung
                </h3>
                <span className="text-[10px] text-slate-500 font-bold">Gestell C1 - C38</span>
              </div>

              <div className="overflow-x-auto custom-scrollbar pb-4">
                <div className="flex gap-2 min-w-max px-2">
                  {shelves.map((s) => (
                    <div key={s} className="flex flex-col gap-1.5 items-center">
                      <span className="text-[8px] font-black text-slate-500 mb-1">{s}</span>
                      {levels.map((l) => {
                        const entries = slotMap.get(`${s}|${l}`) || [];
                        const count = entries.length;
                        return (
                          <div
                            key={l}
                            onClick={() => {
                              if (!count) return;
                              setSearchQuery(`${s}`);
                              setActiveTab("inventory");
                            }}
                            className={`w-7 h-7 rounded-lg shadow-inner flex items-center justify-center ${
                              count ? "bg-yellow-500 shadow-yellow-500/20 cursor-pointer" : "bg-slate-800 opacity-20"
                            }`}
                            title={`${s} - L${l}`}
                          >
                            {count ? <span className="text-[11px] font-black text-slate-900">{count}</span> : null}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-4 text-[10px] text-slate-400 font-bold">
                * Zahl im Feld = Anzahl verschiedener Sorten im Platz (Tippen öffnet Bestand)
              </div>
            </div>
          </div>
        )}

        {/* INVENTORY */}
        {activeTab === "inventory" && (
          <div className="space-y-4">
            <div className="relative">
              <input
                placeholder="Suche Steg, Regal (C1...) oder Profil/AWB..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full px-6 py-4 pr-24 bg-white rounded-3xl shadow-lg outline-none font-bold text-slate-800 border-2 border-transparent focus:border-yellow-400 transition-all"
              />
              <div className="absolute right-5 top-4 flex items-center gap-2">
                {searchQuery.trim() && (
                  <button
                    onClick={() => setSearchQuery("")}
                    className="bg-slate-100 hover:bg-slate-200 text-slate-600 font-black text-[11px] px-3 py-1.5 rounded-full active:scale-95"
                    title="Suche löschen"
                  >
                    X
                  </button>
                )}
                <div className="text-slate-300"><Icon name="search" size={20} /></div>
              </div>
            </div>

            <div className="space-y-3">
              {filteredSlots.length === 0 ? (
                <div className="bg-white p-6 rounded-[2rem] shadow-sm border border-slate-200 text-slate-500 font-bold italic">
                  Keine Treffer / kein Bestand.
                </div>
              ) : (
                filteredSlots.map((slot) => (
                  <div key={`${slot.shelf}|${slot.level}`} className="bg-white p-5 rounded-[2rem] shadow-sm border border-slate-200">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-[15px] font-black bg-slate-900 text-yellow-500 px-3 py-1 rounded-full">
                        {slot.shelf} - L{slot.level}
                      </span>
                      <span className="text-[11px] font-black text-slate-500 uppercase">
                        {slot.entries.length} Stege
                      </span>
                    </div>

                    <div className="space-y-2">
                      {slot.entries.map((entry) => {
                        const linked = getLinkedAWBs(entry.itemKey);
                        return (
                          <div key={entry.id} className="flex items-center justify-between bg-slate-50 rounded-2xl px-4 py-3 border border-slate-100">
                            <div className="min-w-0 pr-3">
                              <div className="font-black text-slate-800 truncate">{entry.itemKey}</div>
                              <div className="text-[11px] text-slate-400 font-bold uppercase truncate">
                                {linked.length ? `Ref: ${linked.join(" | ")}` : "Einzel-Komponente"}
                              </div>
                            </div>

                            <div className="text-right">
                              <div className="text-[10px] font-black uppercase text-slate-400">Stk</div>
                              <div className="bg-white text-slate-900 px-4 py-2 rounded-2xl font-black text-2xl border border-slate-200 shadow-sm min-w-[84px] text-center">
                                {entry.quantity}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* EINGANG / EINLAGERN */}
        {activeTab === "add" && (
          <div className="space-y-4">
            {!canWriteStock ? (
              <LoginCard onLogin={doLogin} busy={authBusy} error={authError} />
            ) : (
              <div className="bg-white p-7 rounded-[2.5rem] shadow-xl border border-slate-200 space-y-5">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-emerald-100 text-emerald-600 rounded-xl">
                    <Icon name="arrow-down-to-dot" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-black uppercase text-slate-800 italic text-xl leading-tight">
                      Einlagern (QR → Barcode)
                    </h3>
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                      Platz scannen → Barcode scannen → Bestätigen
                    </p>
                  </div>
                </div>

                <div className="flex gap-2 flex-wrap">
                  <StatChip label="Schritt" value={inStep === "place" ? "Platz" : "Barcode"} tone="emerald" />
                  <StatChip
                    label="Platz"
                    value={inPlace?.shelf ? `${inPlace.shelf}${inPlace.level ? `-L${inPlace.level}` : ""}` : "—"}
                    tone={inPlace?.shelf ? "emerald" : "slate"}
                  />
                  <StatChip label="Steg" value={inbound.itemKey || "—"} tone={inbound.itemKey ? "emerald" : "slate"} />
                </div>

                <QRScanner
                  ref={inboundScannerRef}
                  enabled={activeTab === "add"}
                  autoStart={true}
                  onResult={(txt) => {
                    if (Date.now() < inboundIgnoreUntilRef.current) return;

                    // ✅ WICHTIG: wenn Platz schon gescannt ist -> IMMER Barcode
                    if (inPlace?.shelf) {
                      onScanBarcodeForInbound(txt);
                      return;
                    }

                    if (inStepRef.current === "place") onScanPlaceForInbound(txt);
                    else onScanBarcodeForInbound(txt);
                  }}
                  onError={() => {}}
                />

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={resetInboundToPlace}
                    className="flex-1 py-3 bg-slate-100 rounded-xl font-black text-[11px] text-slate-700"
                  >
                    Platz neu scannen
                  </button>
                  <button
                    type="button"
                    onClick={resetInboundToBarcode}
                    className="flex-1 py-3 bg-slate-100 rounded-xl font-black text-[11px] text-slate-700"
                  >
                    Barcode neu scannen
                  </button>
                </div>

                <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-2">
                  <div className="text-[10px] font-black uppercase text-slate-400">Barcode Roh</div>
                  <div className="text-[11px] font-bold text-slate-700 break-all">{barcodeRaw || "—"}</div>
                </div>

                <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-2">
                  <div className="text-[10px] font-black uppercase text-slate-400">Daten</div>

                  <input
                    value={inbound.itemKey}
                    onChange={(e) => setInbound((x) => ({ ...x, itemKey: e.target.value }))}
                    placeholder="Steg Nr"
                    className={`w-full p-3 rounded-2xl border-2 font-bold outline-none ${
                      reqMissing.itemKey ? "border-red-400 bg-red-50" : "border-slate-100 bg-white"
                    }`}
                  />
                  <input
                    value={inbound.lengthMm}
                    onChange={(e) => setInbound((x) => ({ ...x, lengthMm: e.target.value }))}
                    placeholder="Länge (mm)"
                    className={`w-full p-3 rounded-2xl border-2 font-bold outline-none ${
                      reqMissing.lengthMm ? "border-red-400 bg-red-50" : "border-slate-100 bg-white"
                    }`}
                  />
                  <input
                    value={inbound.qty}
                    onChange={(e) => setInbound((x) => ({ ...x, qty: e.target.value }))}
                    placeholder="Menge"
                    className={`w-full p-3 rounded-2xl border-2 font-bold outline-none ${
                      reqMissing.qty ? "border-red-400 bg-red-50" : "border-slate-100 bg-white"
                    }`}
                  />
                  <input
                    type="date"
                    value={inbound.deliveryDate}
                    onChange={(e) => setInbound((x) => ({ ...x, deliveryDate: e.target.value }))}
                    className="w-full p-3 rounded-2xl border-2 border-slate-100 font-bold outline-none"
                  />

                  <button
                    type="button"
                    onClick={doInboundPutaway}
                    disabled={!canPutaway}
                    className={`w-full py-4 rounded-[1.2rem] font-black uppercase text-white shadow-lg active:scale-95 transition-all ${
                      canPutaway
                        ? "bg-emerald-600 shadow-emerald-600/20"
                        : "bg-slate-300 shadow-none cursor-not-allowed"
                    }`}
                  >
                    Einlagern bestätigen
                  </button>
                </div>

                <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-3">
                  <div className="text-[10px] font-black uppercase text-slate-400">Manuell Steg auswählen</div>

                  <input
                    value={manualStegQuery}
                    onChange={(e) => setManualStegQuery(e.target.value)}
                    placeholder="erste Zahlen tippen… z.B. 244"
                    className="w-full p-3 bg-white rounded-xl font-bold border-2 border-slate-100 outline-none"
                  />

                  {suggestedSteg ? (
                    <button
                      type="button"
                      onClick={() => setInbound((x) => ({ ...x, itemKey: suggestedSteg }))}
                      className="w-full px-4 py-3 rounded-xl bg-white border border-slate-200 font-black text-left"
                    >
                      Vorschlag: <span className="text-emerald-700">{suggestedSteg}</span> (antippen)
                    </button>
                  ) : (
                    <div className="text-xs font-bold text-slate-500">Kein Vorschlag</div>
                  )}

                  {stegCandidates.length > 1 ? (
                    <div className="grid grid-cols-2 gap-2">
                      {stegCandidates.slice(1).map((k) => (
                        <button
                          key={k}
                          type="button"
                          onClick={() => setInbound((x) => ({ ...x, itemKey: k }))}
                          className="px-3 py-2 rounded-xl bg-white border border-slate-200 font-bold text-sm"
                        >
                          {k}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>

                <button
                  type="button"
                  onClick={resetInboundAll}
                  className="w-full py-3 bg-slate-900 text-yellow-500 rounded-xl font-black text-[11px] active:scale-95"
                >
                  Einlagern komplett zurücksetzen
                </button>
              </div>
            )}
          </div>
        )}

        {/* UMLAGERN */}
        {activeTab === "move" && (
          <div className="space-y-4">
            {!canWriteStock ? (
              <LoginCard onLogin={doLogin} busy={authBusy} error={authError} />
            ) : (
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
                      Quelle scannen → Ziel scannen → Bestätigen
                    </p>
                  </div>
                </div>

                <div className="flex gap-2 flex-wrap">
                  <StatChip
                    label="Modus"
                    value={stepRef.current === "source" ? "Quelle scannen" : "Ziel scannen"}
                    tone="blue"
                  />
                  <StatChip
                    label="Quelle"
                    value={qrSource.shelf ? `${qrSource.shelf}-L${qrSource.level}` : "—"}
                    tone={qrSource.shelf ? "emerald" : "slate"}
                  />
                  <StatChip
                    label="Ziel"
                    value={qrTarget.shelf ? `${qrTarget.shelf}-L${qrTarget.level}` : "—"}
                    tone={qrTarget.shelf ? "emerald" : "slate"}
                  />
                </div>

                {confirmOpen && qrSource.shelf && qrTarget.shelf ? (
                  <div className="bg-blue-50 border border-blue-200 rounded-[1.5rem] p-4">
                    <div className="text-[10px] font-black uppercase text-blue-700 tracking-widest mb-2">
                      Umlagerung bestätigen
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-white border border-slate-200 rounded-2xl p-3">
                        <div className="text-[10px] font-black uppercase text-slate-400">Quelle</div>
                        <div className="font-black text-slate-900 text-lg">
                          {qrSource.shelf}-L{qrSource.level}
                        </div>
                      </div>

                      <div className="bg-white border border-slate-200 rounded-2xl p-3">
                        <div className="text-[10px] font-black uppercase text-slate-400">Ziel</div>
                        <div className="font-black text-slate-900 text-lg">
                          {qrTarget.shelf}-L{qrTarget.level}
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={async () => {
                        setConfirmOpen(false);
                        await doMove();
                      }}
                      disabled={moving}
                      className={`w-full mt-4 py-4 text-white rounded-[1.2rem] font-black uppercase shadow-lg active:scale-95 transition-all ${
                        moving ? "bg-slate-400 shadow-none cursor-not-allowed" : "bg-blue-700 shadow-blue-700/20"
                      }`}
                    >
                      {moving ? "Umlagern..." : "Bestätigen"}
                    </button>

                    <div className="mt-2 text-[10px] text-blue-700/80 font-bold text-center">
                      Scanner ist pausiert bis zur Bestätigung.
                    </div>
                  </div>
                ) : null}

                <QRScanner enabled={scannerEnabled} autoStart={true} onResult={applyScan} onError={() => {}} />

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={resetSource}
                    className="flex-1 py-3 bg-slate-100 rounded-xl font-black text-[11px] text-slate-700"
                  >
                    Quelle zurücksetzen
                  </button>
                  <button
                    type="button"
                    onClick={resetTarget}
                    className="flex-1 py-3 bg-slate-100 rounded-xl font-black text-[11px] text-slate-700"
                  >
                    Ziel zurücksetzen
                  </button>
                </div>

                <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-3">
                  <div className="text-[10px] font-black uppercase text-slate-400">Fallback</div>

                  <input
                    value={qrTextFallback}
                    onChange={(e) => setQrTextFallback(e.target.value)}
                    placeholder="z.B. C8 oder C8-L3"
                    className="w-full p-3 bg-white rounded-xl font-bold border-2 border-slate-100 outline-none"
                  />

                  <div className="flex justify-center">
                    <button
                      type="button"
                      onClick={() => applyScan(qrTextFallback)}
                      disabled={moving || confirmOpen}
                      className={`px-10 py-3 rounded-xl font-black active:scale-95 transition-all ${
                        moving || confirmOpen
                          ? "bg-slate-300 text-white cursor-not-allowed"
                          : "bg-slate-900 text-yellow-500"
                      }`}
                    >
                      Anwenden
                    </button>
                  </div>

                  <div className="text-[10px] text-slate-500 font-bold text-center">
                    Quelle: oberste belegte Ebene • Ziel: unterste freie Ebene
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* OUTBOUND */}
        {activeTab === "outbound" && (
          <div className="space-y-4">
            {!canWriteStock ? (
              <LoginCard onLogin={doLogin} busy={authBusy} error={authError} />
            ) : (
              <div className="bg-white p-8 rounded-[2.5rem] shadow-xl border border-slate-200 space-y-6">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-rose-100 text-rose-600 rounded-xl">
                    <Icon name="arrow-up-right-from-circle" />
                  </div>
                  <h3 className="font-black uppercase text-slate-800 italic text-xl">Warenausgang</h3>
                </div>

                <form onSubmit={handleRemoveStock} className="space-y-5">
                  <div className="space-y-1">
                    <label className="text-[10px] font-black uppercase text-slate-400 ml-4">Eintrag wählen</label>
                    <select
                      required
                      value={outStock.entryId}
                      onChange={(e) => setOutStock({ ...outStock, entryId: e.target.value })}
                      className="w-full p-4 bg-slate-50 rounded-2xl font-bold border-2 border-slate-100 appearance-none outline-none focus:border-rose-400"
                    >
                      <option value="">-- Bestand wählen --</option>
                      {entryOptions.map((e) => (
                        <option key={e.entryId} value={e.entryId}>
                          {e.shelf}-L{e.level} | {e.itemKey} ({e.quantity} Stk)
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[10px] font-black uppercase text-slate-400 ml-4">Verwendung</label>
                    <select
                      value={outStock.destination}
                      onChange={(e) => setOutStock({ ...outStock, destination: e.target.value })}
                      className="w-full p-4 bg-slate-50 rounded-2xl font-bold border-2 border-slate-100 outline-none"
                    >
                      <option value="produktion">Produktion / Montage</option>
                      <option value="ausschuss">Ausschuss / Defekt</option>
                      <option value="inventur">Korrektur</option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[10px] font-black uppercase text-slate-400 ml-4">Entnahmemenge</label>
                    <input
                      required
                      type="number"
                      min="1"
                      placeholder="Menge..."
                      value={outStock.qty}
                      onChange={(e) => setOutStock({ ...outStock, qty: e.target.value })}
                      className="w-full p-4 bg-slate-50 rounded-2xl font-bold border-2 border-slate-100 outline-none focus:border-rose-400"
                    />
                  </div>

                  <button
                    type="submit"
                    className="w-full py-5 bg-rose-600 text-white rounded-[1.5rem] font-black uppercase shadow-lg shadow-rose-600/20 active:scale-95 transition-all sticky bottom-4"
                  >
                    Auslagern bestätigen
                  </button>
                </form>
              </div>
            )}
          </div>
        )}
      </main>

      <nav className="fixed bottom-5 left-1/2 -translate-x-1/2 w-[94%] max-w-[560px] glass-effect rounded-[2.5rem] p-2.5 flex justify-around shadow-2xl border border-white/10 z-[100]">
        <NavBtn active={activeTab === "dashboard"} onClick={() => goTab("dashboard")} icon="layout-dashboard" label="Home" />
        <NavBtn active={activeTab === "inventory"} onClick={() => goTab("inventory")} icon="boxes" label="Bestand" />
        <NavBtn active={activeTab === "add"} onClick={() => goTab("add")} icon="arrow-down-to-dot" label="Eingang" color="emerald" />
        <NavBtn active={activeTab === "move"} onClick={() => goTab("move")} icon="shuffle" label="Umlagern" color="blue" />
        <NavBtn active={activeTab === "outbound"} onClick={() => goTab("outbound")} icon="arrow-up-right-from-circle" label="Ausgang" color="rose" />
      </nav>
    </div>
  );
}
