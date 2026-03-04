import { initializeApp } from "firebase/app";
import { getAnalytics, isSupported } from "firebase/analytics";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyBGqPXXcmJTbL3PVrn-PKL0Gig45r6GPbQ",
  authDomain: "steg-lager-test.firebaseapp.com",
  databaseURL: "https://steg-lager-test-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "steg-lager-test",
  storageBucket: "steg-lager-test.firebasestorage.app",
  messagingSenderId: "655203951825",
  appId: "1:655203951825:web:9edcfb40f29ed70f61d1f0",
  measurementId: "G-Q6FX41P556"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

// Analytics nur wenn unterstützt
isSupported().then((ok) => {
  if (ok) getAnalytics(app);
});tics(app);
});