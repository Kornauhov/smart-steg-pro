export const safeDocId = (s) => String(s || "").replace(/\//g, "_").trim();
export const slotIdFrom = (shelf, level) => `${String(shelf)}_L${Number(level)}`;

// derive slotId/shelf/level from path: artifacts/{appId}/public/data/slots/{slotId}/items/{itemId}
export const deriveFromPath = (path) => {
  const parts = String(path).split("/");
  const idx = parts.indexOf("slots");
  if (idx === -1) return { slotId: null, shelf: null, level: null };
  const slotId = parts[idx + 1] || null;
  if (!slotId) return { slotId: null, shelf: null, level: null };

  const m = String(slotId).match(/^(.+)_L(\d+)$/);
  if (!m) return { slotId, shelf: null, level: null };
  return { slotId: m[0], shelf: m[1], level: Number(m[2]) };
};
