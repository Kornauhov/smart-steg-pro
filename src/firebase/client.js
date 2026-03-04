import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyBGqPXXcmJTbL3PVrn-PKL0Gig45r6GPbQ",
  authDomain: "steg-lager-test.firebaseapp.com",
  projectId: "steg-lager-test",
  storageBucket: "steg-lager-test.appspot.com",
  messagingSenderId: "655203951825",
  appId: "1:655203951825:web:9edcfb40f29ed70f61d1f0"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);