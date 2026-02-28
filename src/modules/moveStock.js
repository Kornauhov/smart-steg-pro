import { collection, getDocs, increment, setDoc, writeBatch } from "firebase/firestore";

/**
 * Slot komplett umlagern (alle Items im Slot) – concurrency safe via increment()
 */
export async function moveWholeSlot({
  db,
  APP_ID,
  slotDocRef,
  itemDocRef,
  sourceShelf,
  sourceLevel,
  targetShelf,
  targetLevel,
}) {
  const sourceSlotId = `${sourceShelf}_L${Number(sourceLevel)}`;
  const targetSlotId = `${targetShelf}_L${Number(targetLevel)}`;

  if (sourceSlotId === targetSlotId) throw new Error("Quelle und Ziel sind identisch.");

  const sourceItemsCol = collection(db, "artifacts", APP_ID, "public", "data", "slots", sourceSlotId, "items");
  const sourceSnap = await getDocs(sourceItemsCol);
  if (sourceSnap.empty) throw new Error("In diesem Slot ist kein Bestand vorhanden.");

  await setDoc(
    slotDocRef(targetSlotId),
    { appId: APP_ID, slotId: targetSlotId, shelf: targetShelf, level: Number(targetLevel), updatedAt: Date.now() },
    { merge: true }
  );

  const docs = sourceSnap.docs;
  const CHUNK = 450;

  for (let i = 0; i < docs.length; i += CHUNK) {
    const slice = docs.slice(i, i + CHUNK);
    const batch = writeBatch(db);

    for (const d of slice) {
      const data = d.data();
      const itemKey = String(data.itemKey || d.id);
      const qty = Number(data.quantity) || 0;

      if (!itemKey || qty <= 0) {
        batch.delete(d.ref);
        continue;
      }

      const targetItemRef = itemDocRef(targetSlotId, itemKey);

      batch.set(
        targetItemRef,
        {
          appId: APP_ID,
          slotId: targetSlotId,
          shelf: targetShelf,
          level: Number(targetLevel),
          itemKey,
          type: data.type || "steg",
          quantity: increment(qty),
          updatedAt: Date.now(),
          timestamp: data.timestamp || Date.now(),
        },
        { merge: true }
      );

      batch.delete(d.ref);
    }

    await batch.commit();
  }

  return { movedTypes: sourceSnap.size };
}