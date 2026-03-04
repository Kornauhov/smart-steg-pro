import admin from "firebase-admin";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// JSON sicher laden (ohne import assert)
const serviceAccountPath = path.join(__dirname, "serviceAccountKey.json");
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const uid = process.argv[2];
const role = process.argv[3]; // admin | planung | versorger

if (!uid || !role) {
  console.log("Usage: node set-claims.js UID ROLE");
  process.exit(1);
}

if (!["admin", "planung", "versorger"].includes(role)) {
  console.log("Role must be: admin | planung | versorger");
  process.exit(1);
}

try {
  await admin.auth().setCustomUserClaims(uid, { role });
  console.log(`✅ Set role=${role} for uid=${uid}`);
} catch (e) {
  console.error("❌ Failed to set claims:", e);
  process.exit(1);
}