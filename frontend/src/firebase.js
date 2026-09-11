import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// TODO: Replace this with your own Firebase project configuration!
// You get this when you create a web app in your Firebase Console.
const firebaseConfig = {
  apiKey: "AIzaSyALFU6J7gqU1-NMVsuHaFuKbv8yiLqxC7U",
  authDomain: "chat-33b07.firebaseapp.com",
  projectId: "chat-33b07",
  storageBucket: "chat-33b07.firebasestorage.app",
  messagingSenderId: "377001865061",
  appId: "1:377001865061:web:fc8d53b199501464c87b8c",
  measurementId: "G-J226JQH35S"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Export Auth and Firestore to use in App.jsx
export const auth = getAuth(app);
export const db = getFirestore(app);
