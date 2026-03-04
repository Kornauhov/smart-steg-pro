// src/utils/ids.js

// SlotId Standard bei dir: "C10_L1"
export function slotIdFrom(shelf, level) {
  return `${String(shelf || "").toUpperCase()}_L${Number(level)}`;
}

// Firestore doc ids dürfen kein "/" enthalten.
export function safeDocId(input) {
  return String(input ?? "")
    .trim()
    .replace(/\//g, "_")
    .replace(/#/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 150);
}

// Pfad -> Infos ableiten
export function deriveFromPath(path = "") {
  const p = String(path || "");

  // artifacts/{APP_ID}/public/data/slots/{slotId}/items/{itemId}
  const m = p.match(
    /artifacts\/([^/]+)\/public\/data\/slots\/([^/]+)\/items\/([^/]+)/
  );
  if (m) {
    const appId = m[1];
    const slotIdRaw = m[2];

    // SlotId kann sein: "C1_L4", "C1_l4", "C1-L4", "C1L4", "C1|4"
    const mm = String(slotIdRaw)
      .toUpperCase()
      .match(/^C(\d{1,2})(?:[|_\- ]?L?(\d))?$/);

    const shelf = mm ? `C${Number(mm[1])}` : null;
    const level = mm && mm[2] ? Number(mm[2]) : null;

    // slotId immer normalisieren auf "Cxx_Ly"
    const slotId = shelf && level ? slotIdFrom(shelf, level) : String(slotIdRaw);

    return { appId, slotId, shelf, level };
  }

  return { appId: null, slotId: null, shelf: null, level: null };
}