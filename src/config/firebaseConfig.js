// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
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

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
