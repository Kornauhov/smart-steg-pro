import React, { useEffect, useMemo, useState } from "react";
import {
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  writeBatch,
} from "firebase/firestore";
import { onAuthStateChanged, signInAnonymously } from "firebase/auth";

import { auth, db } from "./firebase/client.js";
import { DEBUG, APP_ID } from "./config/constants.js";
import { deriveFromPath, safeDocId, slotIdFrom } from "./utils/ids.js";
import { itemDocRef, slotDocRef } from "./firebase/refs.js";

import Icon from "./components/Icon.jsx";
import Segmented from "./components/Segmented.jsx";
import StatChip from "./components/StatChip.jsx";
import NavBtn from "./components/NavBtn.jsx";

export default function App() {
    const [activeTab, setActiveTab] = useState("dashboard");
    const [loading, setLoading] = useState(true);
    const [user, setUser] = useState(null);

    const [rawItems, setRawItems] = useState([]);
    const [stegItems, setStegItems] = useState([]);
    const [masterItems, setMasterItems] = useState([]);

    const [searchQuery, setSearchQuery] = useState("");

    // forms
    const [newStock, setNewStock] = useState({ itemKey: "", shelf: "C1", level: 1, qty: "", source: "anlieferung" });
    const [outStock, setOutStock] = useState({ entryId: "", qty: "", destination: "produktion" });

    // NEW: Umlagern-Modus
    const [moveMode, setMoveMode] = useState("entry"); // "entry" | "slot"

    // entry move (ein Steg)
    const [moveStock, setMoveStock] = useState({ entryId: "", targetShelf: "C1", targetLevel: 1, qty: "" });

    // slot move (alle Stege in einem Slot)
    const [moveSlot, setMoveSlot] = useState({
      sourceShelf: "C1",
      sourceLevel: 1,
      targetShelf: "C1",
      targetLevel: 1
    });

    const shelves = useMemo(() => Array.from({ length: 38 }, (_, i) => `C${i + 1}`), []);
    const levels = [5, 4, 3, 2, 1];

    useEffect(() => {
      const init = async () => {
        try { await signInAnonymously(auth); }
        catch (e) { console.error("Auth Error:", e); }
      };
      init();

      const unsub = onAuthStateChanged(auth, (u) => {
        if (u) { setUser(u); setLoading(false); }
      });
      return () => unsub();
    }, []);

    useEffect(() => {
      if (window.lucide) window.lucide.createIcons();
    }, [activeTab, rawItems.length, stegItems.length, masterItems.length, searchQuery, moveMode]);

    useEffect(() => {
      if (!user) return;

      const itemsQ = query(collectionGroup(db, "items"));
      const unsubItems = onSnapshot(
        itemsQ,
        (snap) => {
          const docs = snap.docs.map(d => ({
            __path: d.ref.path,
            __id: d.id,
            ...d.data()
          }));
          if (DEBUG) console.log("RAW items snap:", snap.size, docs.slice(0,3));
          setRawItems(docs);
        },
        (err) => console.error("Items fetch error:", err)
      );

      const unsubSteg = onSnapshot(
        collection(db, "artifacts", APP_ID, "public", "data", "steg_items"),
        (snap) => {
          const items = snap.docs.map(d => {
            const data = d.data();
            return { id: d.id, code: data.code || data.name || d.id, ...data };
          }).sort((a,b) => String(a.code).localeCompare(String(b.code)));
          setStegItems(items);
        },
        (err) => console.error("Steg items fetch error:", err)
      );

      const unsubMaster = onSnapshot(
        collection(db, "artifacts", APP_ID, "public", "data", "master_items"),
        (snap) => setMasterItems(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
        (err) => console.error("Master items fetch error:", err)
      );

      return () => { unsubItems(); unsubSteg(); unsubMaster(); };
    }, [user]);

    // Filter client-side by appId OR by path containing "/artifacts/stege-lager-v1/"
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
        const slotId = d.slotId ?? derived.slotId ?? (shelf && level ? slotIdFrom(shelf, level) : null);

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
          quantity
        });
      }

      return out;
    }, [rawItems]);

    // slotMap for dashboard/inventory
    const slotMap = useMemo(() => {
      const m = new Map();
      for (const it of itemDocs) {
        const key = `${it.shelf}|${it.level}`;
        if (!m.has(key)) m.set(key, []);
        m.get(key).push(it);
      }
      for (const [k, arr] of m.entries()) {
        arr.sort((a,b) => String(a.itemKey).localeCompare(String(b.itemKey)));
        m.set(k, arr);
      }
      return m;
    }, [itemDocs]);

    const occupiedSlots = slotMap.size;
    const totalParts = useMemo(() => itemDocs.reduce((s, x) => s + (Number(x.quantity)||0), 0), [itemDocs]);

    // AWB index
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

    // grouped slots
    const groupedSlots = useMemo(() => {
      const rows = Array.from(slotMap.entries()).map(([key, entries]) => {
        const [shelf, levelStr] = key.split("|");
        return { shelf, level: Number(levelStr), entries };
      });
      const shelfNum = (s) => Number(String(s).replace("C","")) || 0;
      rows.sort((a,b) => {
        const ds = shelfNum(a.shelf) - shelfNum(b.shelf);
        if (ds !== 0) return ds;
        return b.level - a.level;
      });
      return rows;
    }, [slotMap]);

    const filteredSlots = useMemo(() => {
      const term = searchQuery.trim().toUpperCase();
      if (!term) return groupedSlots;

      return groupedSlots.map(slot => {
        const shelfMatch = String(slot.shelf).toUpperCase().includes(term);
        const matched = slot.entries.filter(e => {
          const keyMatch = String(e.itemKey).toUpperCase().includes(term);
          const awbMatch = getLinkedAWBs(e.itemKey).some(a => String(a).toUpperCase().includes(term));
          const lvlMatch = `L${slot.level}`.includes(term);
          return keyMatch || awbMatch || shelfMatch || lvlMatch;
        });

        const entriesToShow = shelfMatch ? slot.entries : matched;
        if (!entriesToShow.length) return null;
        return { ...slot, entries: entriesToShow };
      }).filter(Boolean);
    }, [groupedSlots, searchQuery, awbIndex]);

    // Firestore refs for writes (new model)

    const handleAddStock = async (e) => {
      e.preventDefault();
      const qty = Number(newStock.qty);
      const itemKey = newStock.itemKey;
      const shelf = newStock.shelf;
      const level = Number(newStock.level);
      if (!itemKey || !shelf || !level || !qty || qty <= 0) return;

      const slotId = `${shelf}_L${level}`;
      const sRef = slotDocRef(slotId);
      const iRef = itemDocRef(slotId, itemKey);

      try {
        await setDoc(sRef, { appId: APP_ID, slotId, shelf, level, updatedAt: Date.now() }, { merge: true });

        const snap = await getDoc(iRef);
        if (snap.exists()) {
          await updateDoc(iRef, {
            appId: APP_ID, slotId, shelf, level, itemKey,
            quantity: (Number(snap.data().quantity) || 0) + qty,
            updatedAt: Date.now(),
            lastSource: newStock.source
          });
        } else {
          await setDoc(iRef, {
            appId: APP_ID, slotId, shelf, level,
            itemKey, type: "steg", quantity: qty,
            timestamp: Date.now(), updatedAt: Date.now(),
            lastSource: newStock.source
          });
        }
        setNewStock({ ...newStock, qty: "", itemKey: "" });
        setActiveTab("inventory");
      } catch (err) {
        console.error("Add error:", err);
      }
    };

    const entryOptions = useMemo(() => {
      const shelfNum = (s) => Number(String(s).replace("C","")) || 0;
      const arr = itemDocs.map(x => ({
        entryId: `${x.slotId}__${safeDocId(x.itemKey)}`,
        slotId: x.slotId,
        shelf: x.shelf,
        level: x.level,
        itemKey: x.itemKey,
        quantity: x.quantity
      }));
      arr.sort((a,b) => {
        const ds = shelfNum(a.shelf) - shelfNum(b.shelf);
        if (ds !== 0) return ds;
        const dl = b.level - a.level;
        if (dl !== 0) return dl;
        return String(a.itemKey).localeCompare(String(b.itemKey));
      });
      return arr;
    }, [itemDocs]);

    // ===== NEW: Slot Preview (Quelle & Ziel) =====
    const sourceSlotKey = `${moveSlot.sourceShelf}|${Number(moveSlot.sourceLevel)}`;
    const targetSlotKey = `${moveSlot.targetShelf}|${Number(moveSlot.targetLevel)}`;

    const sourceSlotEntries = useMemo(() => slotMap.get(sourceSlotKey) || [], [slotMap, sourceSlotKey]);
    const targetSlotEntries = useMemo(() => slotMap.get(targetSlotKey) || [], [slotMap, targetSlotKey]);

    const sourceSlotStats = useMemo(() => ({
      types: sourceSlotEntries.length,
      qty: sourceSlotEntries.reduce((s, e) => s + (Number(e.quantity) || 0), 0)
    }), [sourceSlotEntries]);

    const targetSlotStats = useMemo(() => ({
      types: targetSlotEntries.length,
      qty: targetSlotEntries.reduce((s, e) => s + (Number(e.quantity) || 0), 0)
    }), [targetSlotEntries]);

    const handleRemoveStock = async (e) => {
      e.preventDefault();
      const qty = Number(outStock.qty);
      if (!outStock.entryId || !qty || qty <= 0) return;

      const selected = entryOptions.find(x => x.entryId === outStock.entryId);
      if (!selected) return;

      if (selected.quantity < qty) {
        alert("❗ Entnahmemenge ist größer als der aktuelle Bestand.");
        return;
      }

      const iRef = itemDocRef(selected.slotId, selected.itemKey);
      try {
        const newQty = selected.quantity - qty;
        if (newQty <= 0) await deleteDoc(iRef);
        else await updateDoc(iRef, { quantity: newQty, updatedAt: Date.now(), lastDestination: outStock.destination });

        setOutStock({ entryId: "", qty: "", destination: "produktion" });
        setActiveTab("inventory");
      } catch (err) {
        console.error("Remove error:", err);
      }
    };

    // ===== NEW: Eintrag umlagern (Teilmenge möglich) =====
    const handleMoveEntry = async (e) => {
      e.preventDefault();
      const selected = entryOptions.find(x => x.entryId === moveStock.entryId);
      if (!selected) return;

      const qty = Number(moveStock.qty);
      if (!qty || qty <= 0) return;

      if (qty > selected.quantity) {
        alert("❗ Umlager-Menge ist größer als der aktuelle Bestand.");
        return;
      }

      const targetShelf = moveStock.targetShelf;
      const targetLevel = Number(moveStock.targetLevel);
      const targetSlotId = `${targetShelf}_L${targetLevel}`;

      if (targetSlotId === selected.slotId) {
        alert("❗ Quelle und Ziel sind identisch.");
        return;
      }

      const sourceRef = itemDocRef(selected.slotId, selected.itemKey);
      const targetSlotRef = slotDocRef(targetSlotId);
      const targetItemRef = itemDocRef(targetSlotId, selected.itemKey);

      try {
        const ok = confirm(`Eintrag umlagern?\n\n${selected.shelf}-L${selected.level}  →  ${targetShelf}-L${targetLevel}\n${selected.itemKey} | ${qty} Stk`);
        if (!ok) return;

        // remove from source
        const remaining = selected.quantity - qty;
        if (remaining <= 0) await deleteDoc(sourceRef);
        else await updateDoc(sourceRef, { quantity: remaining, updatedAt: Date.now() });

        // ensure target slot
        await setDoc(targetSlotRef, { appId: APP_ID, slotId: targetSlotId, shelf: targetShelf, level: targetLevel, updatedAt: Date.now() }, { merge: true });

        // add to target item
        const tSnap = await getDoc(targetItemRef);
        if (tSnap.exists()) {
          await updateDoc(targetItemRef, { quantity: (Number(tSnap.data().quantity)||0) + qty, updatedAt: Date.now() });
        } else {
          await setDoc(targetItemRef, {
            appId: APP_ID, slotId: targetSlotId, shelf: targetShelf, level: targetLevel,
            itemKey: selected.itemKey, type: "steg", quantity: qty, timestamp: Date.now(), updatedAt: Date.now()
          });
        }

        setMoveStock({ entryId: "", targetShelf: "C1", targetLevel: 1, qty: "" });
        setActiveTab("inventory");
      } catch (err) {
        console.error("Move entry error:", err);
        alert("❗ Fehler beim Umlagern (Eintrag).");
      }
    };

    // ===== NEW: ganzen Slot umlagern (alle Stege im Slot) =====
    const handleMoveWholeSlot = async (e) => {
      e.preventDefault();

      const sourceShelf = moveSlot.sourceShelf;
      const sourceLevel = Number(moveSlot.sourceLevel);
      const targetShelf = moveSlot.targetShelf;
      const targetLevel = Number(moveSlot.targetLevel);

      const sourceSlotId = `${sourceShelf}_L${sourceLevel}`;
      const targetSlotId = `${targetShelf}_L${targetLevel}`;

      if (sourceSlotId === targetSlotId) {
        alert("❗ Quelle und Ziel sind identisch.");
        return;
      }

      // UI-Vorschau (aus slotMap) – wenn leer, sofort stoppen
      if (!sourceSlotEntries.length) {
        alert("ℹ️ In diesem Slot ist kein Bestand vorhanden.");
        return;
      }

      try {
        const ok = confirm(
          `Slot komplett umlagern?\n\n` +
          `${sourceShelf}-L${sourceLevel}  →  ${targetShelf}-L${targetLevel}\n` +
          `Sorten: ${sourceSlotStats.types} | Gesamt: ${sourceSlotStats.qty} Stk`
        );
        if (!ok) return;

        // Quelle: alle Items lesen (Firestore)
        const sourceItemsCol = collection(db, "artifacts", APP_ID, "public", "data", "slots", sourceSlotId, "items");
        const sourceSnap = await getDocs(sourceItemsCol);

        if (sourceSnap.empty) {
          alert("ℹ️ In diesem Slot ist kein Bestand vorhanden.");
          return;
        }

        // Ziel-Items einmal lesen -> Map für prev qty
        const targetItemsCol = collection(db, "artifacts", APP_ID, "public", "data", "slots", targetSlotId, "items");
        const targetSnap = await getDocs(targetItemsCol);
        const targetQtyMap = new Map();
        for (const d of targetSnap.docs) {
          const data = d.data();
          const itemKey = data.itemKey || d.id;
          const qty = Number(data.quantity) || 0;
          targetQtyMap.set(String(itemKey), qty);
        }

        // Ziel-Slot sicherstellen
        const targetSlotRef = slotDocRef(targetSlotId);
        await setDoc(targetSlotRef, {
          appId: APP_ID,
          slotId: targetSlotId,
          shelf: targetShelf,
          level: targetLevel,
          updatedAt: Date.now()
        }, { merge: true });

        const batch = writeBatch(db);

        // Für jedes Item: Ziel qty berechnen + Quelle löschen
        for (const d of sourceSnap.docs) {
          const data = d.data();
          const itemKey = String(data.itemKey || d.id);
          const qty = Number(data.quantity) || 0;
          if (!itemKey || qty <= 0) continue;

          const prev = Number(targetQtyMap.get(itemKey) || 0);
          const nextQty = prev + qty;

          const targetItemRef = itemDocRef(targetSlotId, itemKey);

          // Set mit merge + nextQty (wir haben prev aus targetQtyMap)
          batch.set(targetItemRef, {
            appId: APP_ID,
            slotId: targetSlotId,
            shelf: targetShelf,
            level: targetLevel,
            itemKey,
            type: data.type || "steg",
            quantity: nextQty,
            updatedAt: Date.now(),
            timestamp: data.timestamp || Date.now()
          }, { merge: true });

          // Quelle löschen
          batch.delete(d.ref);
        }

        await batch.commit();

        alert(`✅ Slot ${sourceShelf}-L${sourceLevel} komplett nach ${targetShelf}-L${targetLevel} umgelagert.`);
        setActiveTab("inventory");
      } catch (err) {
        console.error("Move whole slot error:", err);
        alert("❗ Fehler beim Slot-Umlagern. (Konsole prüfen)");
      }
    };

    if (loading) return (
      <div className="h-screen flex flex-col items-center justify-center bg-slate-900 text-yellow-500">
        <div className="w-16 h-16 border-4 border-yellow-500 border-t-transparent rounded-full animate-spin mb-6"></div>
        <p className="font-black italic uppercase tracking-widest">System wird initialisiert...</p>
      </div>
    );

    return (
      <div className="max-w-4xl mx-auto min-h-screen pb-36 relative">
        {/* DEBUG overlay */}
        {DEBUG && (
          <div className="fixed top-3 right-3 z-[999] bg-white/90 backdrop-blur border border-slate-200 shadow-lg rounded-2xl px-4 py-3 text-[11px] font-bold text-slate-700">
            <div>RAW docs: <span className="text-slate-900">{rawItems.length}</span></div>
            <div>APP docs: <span className="text-slate-900">{itemDocs.length}</span></div>
            <div>Slots: <span className="text-slate-900">{occupiedSlots}</span></div>
            <div>Sum qty: <span className="text-slate-900">{totalParts}</span></div>
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
            </div>
            <div className="bg-slate-800 p-3 rounded-2xl text-yellow-500 shadow-inner">
              <Icon name="factory" size={24} />
            </div>
          </div>
        </header>

        <main className="max-w-2xl mx-auto mt-6 px-4">
          {activeTab === "dashboard" && (
            <div className="space-y-6">
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
                    {shelves.map(s => (
                      <div key={s} className="flex flex-col gap-1.5 items-center">
                        <span className="text-[8px] font-black text-slate-500 mb-1">{s}</span>
                        {levels.map(l => {
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
                              className={`w-7 h-7 rounded-lg grid-cell shadow-inner flex items-center justify-center ${
                                count ? "bg-yellow-500 shadow-yellow-500/20 cursor-pointer" : "bg-slate-800 opacity-20 cursor-default"
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

          {activeTab === "inventory" && (
            <div className="space-y-4">
              <div className="relative">
                <input
                  placeholder="Suche Steg, Regal (C1...) oder Profil/AWB..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
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

              <div className="flex items-center justify-between px-1">
                <div className="text-[11px] font-bold text-slate-500">
                  Treffer: <span className="text-slate-900">{filteredSlots.length}</span>
                </div>
                {searchQuery.trim() && (
                  <button
                    onClick={() => setSearchQuery("")}
                    className="text-[11px] font-black text-yellow-800 bg-yellow-100 px-3 py-1.5 rounded-full active:scale-95"
                  >
                    Zurücksetzen
                  </button>
                )}
              </div>

              <div className="space-y-3">
                {filteredSlots.length === 0 ? (
                  <div className="bg-white p-6 rounded-[2rem] shadow-sm border border-slate-200 text-slate-500 font-bold italic">
                    Keine Treffer / kein Bestand.
                  </div>
                ) : filteredSlots.map(slot => (
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
                      {slot.entries.map(entry => {
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
                ))}
              </div>
            </div>
          )}

          {activeTab === "add" && (
            <div className="bg-white p-8 rounded-[2.5rem] shadow-xl border border-slate-200 space-y-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-emerald-100 text-emerald-600 rounded-xl"><Icon name="arrow-down-to-dot" /></div>
                <h3 className="font-black uppercase text-slate-800 italic text-xl">Wareneingang</h3>
              </div>

              <form onSubmit={handleAddStock} className="space-y-5">
                <div className="flex gap-2 p-1 bg-slate-100 rounded-2xl">
                  <button type="button"
                    onClick={() => setNewStock({ ...newStock, source: "anlieferung" })}
                    className={`flex-1 py-3 rounded-xl text-[10px] font-black uppercase transition-all ${
                      newStock.source === "anlieferung" ? "bg-white shadow-sm text-emerald-600" : "text-slate-400"
                    }`}>Anlieferung</button>
                  <button type="button"
                    onClick={() => setNewStock({ ...newStock, source: "produktion" })}
                    className={`flex-1 py-3 rounded-xl text-[10px] font-black uppercase transition-all ${
                      newStock.source === "produktion" ? "bg-white shadow-sm text-blue-600" : "text-slate-400"
                    }`}>Rücklauf</button>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase text-slate-400 ml-4">Steg auswählen</label>
                  <select required value={newStock.itemKey} onChange={e => setNewStock({ ...newStock, itemKey: e.target.value })}
                    className="w-full p-4 bg-slate-50 rounded-2xl font-bold border-2 border-slate-100 appearance-none outline-none focus:border-emerald-400">
                    <option value="">-- Typ wählen --</option>
                    {stegItems.map(s => <option key={s.id} value={s.code}>{s.code}</option>)}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-[10px] font-black uppercase text-slate-400 ml-4">Regal (C)</label>
                    <select value={newStock.shelf} onChange={e => setNewStock({ ...newStock, shelf: e.target.value })}
                      className="w-full p-4 bg-slate-50 rounded-2xl font-bold border-2 border-slate-100 outline-none">
                      {shelves.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-black uppercase text-slate-400 ml-4">Ebene</label>
                    <select value={newStock.level} onChange={e => setNewStock({ ...newStock, level: Number(e.target.value) })}
                      className="w-full p-4 bg-slate-50 rounded-2xl font-bold border-2 border-slate-100 outline-none">
                      {levels.map(l => <option key={l} value={l}>Ebene {l}</option>)}
                    </select>
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase text-slate-400 ml-4">Stückzahl</label>
                  <input required type="number" min="1" placeholder="Menge..."
                    value={newStock.qty} onChange={e => setNewStock({ ...newStock, qty: e.target.value })}
                    className="w-full p-4 bg-slate-50 rounded-2xl font-bold border-2 border-slate-100 outline-none focus:border-emerald-400" />
                </div>

                <button type="submit" className="w-full py-5 bg-emerald-600 text-white rounded-[1.5rem] font-black uppercase shadow-lg shadow-emerald-600/20 active:scale-95 transition-all sticky bottom-4">
                  Einlagern bestätigen
                </button>
              </form>
            </div>
          )}

          {/* ===== COMPLETELY NEW MOVE MODULE ===== */}
          {activeTab === "move" && (
            <div className="space-y-4">
              <div className="bg-white p-7 rounded-[2.5rem] shadow-xl border border-slate-200 space-y-5">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-blue-100 text-blue-600 rounded-xl"><Icon name="shuffle" /></div>
                  <div className="min-w-0">
                    <h3 className="font-black uppercase text-slate-800 italic text-xl leading-tight">Umlagern</h3>
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                      Eintrag oder kompletter Slot
                    </p>
                  </div>
                </div>

                <Segmented
                  value={moveMode}
                  onChange={setMoveMode}
                  options={[
                    { value: "entry", label: "Eintrag umlagern" },
                    { value: "slot", label: "Slot umlagern" }
                  ]}
                />

                {/* === ENTRY MOVE === */}
                {moveMode === "entry" && (
                  <form onSubmit={handleMoveEntry} className="space-y-5">
                    <div className="bg-slate-50 border border-slate-200 rounded-[2rem] p-5 space-y-4">
                      <div className="flex items-center justify-between">
                        <div className="font-black uppercase text-slate-700 text-sm">Eintrag wählen</div>
                        <div className="text-[10px] font-bold text-slate-400 uppercase">Teilmenge möglich</div>
                      </div>

                      <div className="space-y-1">
                        <label className="text-[10px] font-black uppercase text-slate-400 ml-2">Was umlagern?</label>
                        <select required value={moveStock.entryId}
                          onChange={e => {
                            const entryId = e.target.value;
                            const entry = entryOptions.find(x => x.entryId === entryId);
                            setMoveStock({ ...moveStock, entryId, qty: entry ? entry.quantity : "" });
                          }}
                          className="w-full p-4 bg-white rounded-2xl font-bold border-2 border-slate-100 appearance-none outline-none focus:border-blue-400">
                          <option value="">-- Bestand wählen --</option>
                          {entryOptions.map(e => (
                            <option key={e.entryId} value={e.entryId}>
                              {e.shelf}-L{e.level} | {e.itemKey} ({e.quantity} Stk)
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="space-y-1">
                        <label className="text-[10px] font-black uppercase text-slate-400 ml-2">Menge</label>
                        <input
                          type="number"
                          min="1"
                          max={(entryOptions.find(x => x.entryId === moveStock.entryId)?.quantity) || 1}
                          value={moveStock.qty}
                          onChange={e => setMoveStock({ ...moveStock, qty: e.target.value })}
                          className="w-full p-4 bg-white rounded-2xl font-bold border-2 border-slate-100 outline-none focus:border-blue-400"
                          placeholder="Menge..."
                        />
                        <p className="text-[9px] text-slate-400 ml-2 italic mt-1">* Max = aktueller Bestand.</p>
                      </div>

                      <div className="grid grid-cols-2 gap-4 pt-3 border-t border-slate-200">
                        <div className="space-y-1">
                          <label className="text-[10px] font-black uppercase text-slate-400 ml-2">Ziel Regal</label>
                          <select value={moveStock.targetShelf} onChange={e => setMoveStock({ ...moveStock, targetShelf: e.target.value })}
                            className="w-full p-4 bg-white rounded-2xl font-bold border-2 border-slate-100 outline-none">
                            {shelves.map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </div>
                        <div className="space-y-1">
                          <label className="text-[10px] font-black uppercase text-slate-400 ml-2">Ziel Ebene</label>
                          <select value={moveStock.targetLevel} onChange={e => setMoveStock({ ...moveStock, targetLevel: Number(e.target.value) })}
                            className="w-full p-4 bg-white rounded-2xl font-bold border-2 border-slate-100 outline-none">
                            {levels.map(l => <option key={l} value={l}>Ebene {l}</option>)}
                          </select>
                        </div>
                      </div>
                    </div>

                    <button type="submit" disabled={!moveStock.entryId}
                      className={`w-full py-5 text-white rounded-[1.5rem] font-black uppercase shadow-lg active:scale-95 transition-all sticky bottom-4 ${
                        moveStock.entryId ? "bg-blue-600 shadow-blue-600/20" : "bg-slate-300 shadow-none cursor-not-allowed"
                      }`}>
                      Eintrag umlagern
                    </button>
                  </form>
                )}

                {/* === SLOT MOVE (ALL STEGS) === */}
                {moveMode === "slot" && (
                  <form onSubmit={handleMoveWholeSlot} className="space-y-5">
                    <div className="bg-slate-50 border border-slate-200 rounded-[2rem] p-5 space-y-4">
                      <div className="flex items-center justify-between">
                        <div className="font-black uppercase text-slate-700 text-sm">Kompletter Slot</div>
                        <div className="text-[10px] font-bold text-slate-400 uppercase">Alle Stege werden verschoben</div>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1">
                          <label className="text-[10px] font-black uppercase text-slate-400 ml-2">Quelle Regal</label>
                          <select
                            value={moveSlot.sourceShelf}
                            onChange={e => setMoveSlot({ ...moveSlot, sourceShelf: e.target.value })}
                            className="w-full p-4 bg-white rounded-2xl font-bold border-2 border-slate-100 outline-none focus:border-blue-400"
                          >
                            {shelves.map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </div>
                        <div className="space-y-1">
                          <label className="text-[10px] font-black uppercase text-slate-400 ml-2">Quelle Ebene</label>
                          <select
                            value={moveSlot.sourceLevel}
                            onChange={e => setMoveSlot({ ...moveSlot, sourceLevel: Number(e.target.value) })}
                            className="w-full p-4 bg-white rounded-2xl font-bold border-2 border-slate-100 outline-none focus:border-blue-400"
                          >
                            {levels.map(l => <option key={l} value={l}>Ebene {l}</option>)}
                          </select>
                        </div>
                      </div>

                      {/* Live Vorschau Quelle */}
                      <div className="bg-white border border-slate-200 rounded-[1.5rem] p-4">
                        <div className="flex items-center justify-between mb-3">
                          <div className="font-black text-slate-800">
                            Quelle: {moveSlot.sourceShelf}-L{moveSlot.sourceLevel}
                          </div>
                          <div className="text-[10px] font-black uppercase text-slate-400">
                            Live Vorschau
                          </div>
                        </div>

                        <div className="flex gap-2 flex-wrap">
                          <StatChip label="Sorten" value={sourceSlotStats.types} tone={sourceSlotStats.types ? "blue" : "slate"} />
                          <StatChip label="Gesamt" value={`${sourceSlotStats.qty} Stk`} tone={sourceSlotStats.qty ? "yellow" : "slate"} />
                          <StatChip label="Status" value={sourceSlotEntries.length ? "Bestand vorhanden" : "Leer"} tone={sourceSlotEntries.length ? "emerald" : "rose"} />
                        </div>

                        {sourceSlotEntries.length ? (
                          <div className="mt-3 space-y-2">
                            {sourceSlotEntries.slice(0, 6).map(e => (
                              <div key={e.id} className="flex items-center justify-between bg-slate-50 border border-slate-100 rounded-2xl px-3 py-2">
                                <div className="font-black text-slate-800 truncate pr-3">{e.itemKey}</div>
                                <div className="font-black text-slate-900 bg-white border border-slate-200 rounded-xl px-3 py-1 min-w-[64px] text-center">
                                  {e.quantity}
                                </div>
                              </div>
                            ))}
                            {sourceSlotEntries.length > 6 && (
                              <div className="text-[10px] font-bold text-slate-400">
                                + {sourceSlotEntries.length - 6} weitere Sorten
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="mt-3 text-[11px] font-bold text-slate-500 italic">
                            Keine Stege in diesem Slot.
                          </div>
                        )}
                      </div>

                      <div className="grid grid-cols-2 gap-4 pt-3 border-t border-slate-200">
                        <div className="space-y-1">
                          <label className="text-[10px] font-black uppercase text-slate-400 ml-2">Ziel Regal</label>
                          <select
                            value={moveSlot.targetShelf}
                            onChange={e => setMoveSlot({ ...moveSlot, targetShelf: e.target.value })}
                            className="w-full p-4 bg-white rounded-2xl font-bold border-2 border-slate-100 outline-none focus:border-blue-400"
                          >
                            {shelves.map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </div>
                        <div className="space-y-1">
                          <label className="text-[10px] font-black uppercase text-slate-400 ml-2">Ziel Ebene</label>
                          <select
                            value={moveSlot.targetLevel}
                            onChange={e => setMoveSlot({ ...moveSlot, targetLevel: Number(e.target.value) })}
                            className="w-full p-4 bg-white rounded-2xl font-bold border-2 border-slate-100 outline-none focus:border-blue-400"
                          >
                            {levels.map(l => <option key={l} value={l}>Ebene {l}</option>)}
                          </select>
                        </div>
                      </div>

                      {/* Optional: Ziel-Vorschau */}
                      <div className="bg-white border border-slate-200 rounded-[1.5rem] p-4">
                        <div className="flex items-center justify-between mb-2">
                          <div className="font-black text-slate-800">
                            Ziel: {moveSlot.targetShelf}-L{moveSlot.targetLevel}
                          </div>
                          <div className="text-[10px] font-black uppercase text-slate-400">
                            Bestand im Ziel
                          </div>
                        </div>
                        <div className="flex gap-2 flex-wrap">
                          <StatChip label="Sorten" value={targetSlotStats.types} tone="slate" />
                          <StatChip label="Gesamt" value={`${targetSlotStats.qty} Stk`} tone="slate" />
                        </div>
                      </div>
                    </div>

                    <button
                      type="submit"
                      disabled={!sourceSlotEntries.length || (sourceSlotKey === targetSlotKey)}
                      className={`w-full py-5 text-white rounded-[1.5rem] font-black uppercase shadow-lg active:scale-95 transition-all sticky bottom-4 ${
                        (!sourceSlotEntries.length || (sourceSlotKey === targetSlotKey))
                          ? "bg-slate-300 shadow-none cursor-not-allowed"
                          : "bg-blue-700 shadow-blue-700/20"
                      }`}
                    >
                      Slot komplett umlagern
                    </button>
                  </form>
                )}
              </div>
            </div>
          )}

          {activeTab === "outbound" && (
            <div className="bg-white p-8 rounded-[2.5rem] shadow-xl border border-slate-200 space-y-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-rose-100 text-rose-600 rounded-xl"><Icon name="arrow-up-right-from-circle" /></div>
                <h3 className="font-black uppercase text-slate-800 italic text-xl">Warenausgang</h3>
              </div>

              <form onSubmit={handleRemoveStock} className="space-y-5">
                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase text-slate-400 ml-4">Eintrag wählen</label>
                  <select required value={outStock.entryId} onChange={e => setOutStock({ ...outStock, entryId: e.target.value })}
                    className="w-full p-4 bg-slate-50 rounded-2xl font-bold border-2 border-slate-100 appearance-none outline-none focus:border-rose-400">
                    <option value="">-- Bestand wählen --</option>
                    {entryOptions.map(e => (
                      <option key={e.entryId} value={e.entryId}>
                        {e.shelf}-L{e.level} | {e.itemKey} ({e.quantity} Stk)
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase text-slate-400 ml-4">Verwendung</label>
                  <select value={outStock.destination} onChange={e => setOutStock({ ...outStock, destination: e.target.value })}
                    className="w-full p-4 bg-slate-50 rounded-2xl font-bold border-2 border-slate-100 outline-none">
                    <option value="produktion">Produktion / Montage</option>
                    <option value="ausschuss">Ausschuss / Defekt</option>
                    <option value="inventur">Korrektur</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase text-slate-400 ml-4">Entnahmemenge</label>
                  <input required type="number" min="1" placeholder="Menge..."
                    value={outStock.qty} onChange={e => setOutStock({ ...outStock, qty: e.target.value })}
                    className="w-full p-4 bg-slate-50 rounded-2xl font-bold border-2 border-slate-100 outline-none focus:border-rose-400" />
                </div>

                <button type="submit" className="w-full py-5 bg-rose-600 text-white rounded-[1.5rem] font-black uppercase shadow-lg shadow-rose-600/20 active:scale-95 transition-all sticky bottom-4">
                  Auslagern bestätigen
                </button>
              </form>
            </div>
          )}
        </main>

        <nav className="fixed bottom-5 left-1/2 -translate-x-1/2 w-[94%] max-w-[560px] glass-effect rounded-[2.5rem] p-2.5 flex justify-around shadow-2xl border border-white/10 z-[100]">
          <NavBtn active={activeTab === "dashboard"} onClick={() => setActiveTab("dashboard")} icon="layout-dashboard" label="Home" />
          <NavBtn active={activeTab === "inventory"} onClick={() => setActiveTab("inventory")} icon="boxes" label="Bestand" />
          <NavBtn active={activeTab === "add"} onClick={() => setActiveTab("add")} icon="arrow-down-to-dot" label="Eingang" color="emerald" />
          <NavBtn active={activeTab === "move"} onClick={() => setActiveTab("move")} icon="shuffle" label="Umlagern" color="blue" />
          <NavBtn active={activeTab === "outbound"} onClick={() => setActiveTab("outbound")} icon="arrow-up-right-from-circle" label="Ausgang" color="rose" />
        </nav>
      </div>
    );
  }
