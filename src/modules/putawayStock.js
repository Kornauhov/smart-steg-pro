import { getDoc, setDoc, updateDoc } from "firebase/firestore";

export async function putawayStock({
  APP_ID,
  slotDocRef,
  itemDocRef,
  slotMap,
  shelves,
  levels,
  itemKey,
  qty,
  preferredShelf = null,
  preferredLevel = null,
  source = "anlieferung",
  meta = {},
}) {
  const quantity = Number(qty);
  if (!itemKey) throw new Error("Steg-Nr fehlt.");
  if (!quantity || quantity <= 0) throw new Error("Menge fehlt/ungültig.");

  const bottomUp = [...levels].map(Number).sort((a, b) => a - b);

  const pickSlot = () => {
    if (preferredShelf && preferredLevel) return { shelf: preferredShelf, level: Number(preferredLevel) };

    if (preferredShelf && !preferredLevel) {
      for (const lvl of bottomUp) {
        const entries = slotMap.get(`${preferredShelf}|${lvl}`) || [];
        if (!entries.length) return { shelf: preferredShelf, level: lvl };
      }
      return null;
    }

    for (const shelf of shelves) {
      for (const lvl of bottomUp) {
        const entries = slotMap.get(`${shelf}|${lvl}`) || [];
        if (!entries.length) return { shelf, level: lvl };
      }
    }
    return null;
  };

  const target = pickSlot();
  if (!target) throw new Error(preferredShelf ? `Kein freier Platz in ${preferredShelf}.` : "Kein freier Platz im Lager.");

  const { shelf, level } = target;
  const slotId = `${shelf}_L${level}`;

  const sRef = slotDocRef(slotId);
  const iRef = itemDocRef(slotId, itemKey);

  await setDoc(sRef, { appId: APP_ID, slotId, shelf, level, updatedAt: Date.now() }, { merge: true });

  const snap = await getDoc(iRef);
  const base = {
    appId: APP_ID,
    slotId,
    shelf,
    level,
    itemKey,
    type: "steg",
    updatedAt: Date.now(),
    lastSource: source,
    ...meta,
  };

  if (snap.exists()) {
    await updateDoc(iRef, { ...base, quantity: (Number(snap.data().quantity) || 0) + quantity });
  } else {
    await setDoc(iRef, { ...base, quantity, timestamp: Date.now() });
  }

  return { shelf, level, slotId };
}
