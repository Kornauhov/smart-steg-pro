import { doc } from "firebase/firestore";
import { db } from "./client.js";
import { APP_ID } from "../config/constants.js";
import { safeDocId } from "../utils/ids.js";

export const slotDocRef = (slotId) =>
  doc(db, "artifacts", APP_ID, "public", "data", "slots", slotId);

export const itemDocRef = (slotId, itemKey) =>
  doc(db, "artifacts", APP_ID, "public", "data", "slots", slotId, "items", safeDocId(itemKey));
