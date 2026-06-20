/* =========================================================================
   firebase-init.js — Firebase Setup
   =========================================================================
   Initialisiert Firebase App, Firestore (mit lokalem Cache), Auth und
   Realtime Database (RTDB). Exportiert die wichtigsten Refs und
   Helper-Funktionen, die andere Module brauchen.
   =========================================================================
   EXPORTIERT (window.*):
   - db, auth, app, rtdb (über Imports)
   - rosterDocRef, historyCollectionRef, userProfilesCollectionRef,
   - lootCollectionRef, denylistCollectionRef, aliasDocRef
   - Konstanten: DATA_COLLECTION, HISTORY_COLLECTION, USER_PROFILES_COLLECTION, LOOT_COLLECTION
   - Firestore-Funktionen (re-exportiert): doc, setDoc, onSnapshot, collection, etc.
   - RTDB-Funktionen: rtdbRef, rtdbSet, rtdbOnValue, rtdbOnDisconnect, rtdbServerTimestamp, rtdbOff
   - Auth-Funktionen: onAuthStateChanged, signInWithEmailAndPassword, signOut, signInAnonymously
   - window.firebaseTools = { db, doc, getDoc, collection, getDocs, updateDoc, rtdb, ... }
   ========================================================================= */

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import {
    getFirestore, initializeFirestore, persistentLocalCache,
    doc, setDoc, onSnapshot, collection, deleteDoc, getDoc,
    serverTimestamp, query, orderBy, addDoc, updateDoc, where,
    getDocs, limit
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import {
    getAuth, signInAnonymously, onAuthStateChanged,
    signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import {
    getDatabase,
    ref as rtdbRef,
    set as rtdbSet,
    onValue as rtdbOnValue,
    onDisconnect as rtdbOnDisconnect,
    off as rtdbOff,
    serverTimestamp as rtdbServerTimestamp
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-database.js";

// Firestore-Funktionen re-exportieren, damit andere Module nicht selbst importieren müssen
export {
    doc, setDoc, onSnapshot, collection, deleteDoc, getDoc,
    serverTimestamp, query, orderBy, addDoc, updateDoc, where,
    getDocs, limit,
    onAuthStateChanged, signInWithEmailAndPassword, signOut, signInAnonymously,
    // RTDB-Funktionen
    rtdbRef, rtdbSet, rtdbOnValue, rtdbOnDisconnect, rtdbOff, rtdbServerTimestamp
};


// =============================================================================
// FIREBASE-CONFIG & INIT
// =============================================================================

const firebaseConfig = {
    apiKey: "AIzaSyBmqCCIOKq0OQOTEgJJ7Lj8CYlLihVBVSU",
    authDomain: "panik-raid.firebaseapp.com",
    databaseURL: "https://panik-raid-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "panik-raid",
    storageBucket: "panik-raid.appspot.com",
    messagingSenderId: "120578974053",
    appId: "1:120578974053:web:927a81dccbb4b33f86c18c"
};

export const app = initializeApp(firebaseConfig);

// Firestore mit persistentem Cache initialisieren
export const db = initializeFirestore(app, {
    localCache: persistentLocalCache()
});

export const auth = getAuth(app);

// Realtime Database initialisieren (für Presence-System)
export const rtdb = getDatabase(app);


// =============================================================================
// COLLECTION-KONSTANTEN
// =============================================================================

export const DATA_COLLECTION = "raid-tool-data";
export const HISTORY_COLLECTION = "raid-tool-history";
export const USER_PROFILES_COLLECTION = "user_profiles";
export const LOOT_COLLECTION = "raid-tool-loot";


// =============================================================================
// FIRESTORE-REFERENZEN
// =============================================================================

export const rosterDocRef = doc(db, DATA_COLLECTION, "currentRoster");
export const historyCollectionRef = collection(db, HISTORY_COLLECTION);
export const userProfilesCollectionRef = collection(db, USER_PROFILES_COLLECTION);
export const lootCollectionRef = collection(db, LOOT_COLLECTION);
export const denylistCollectionRef = collection(db, "snapshot_player_denylist");
export const aliasDocRef = doc(db, DATA_COLLECTION, "nameAliasMap");


// =============================================================================
// GLOBAL-EXPOSURE (für Legacy-Code)
// =============================================================================

// Damit Inline-Handler und andere Module ohne Import zugreifen können.
// Wir exposen großzügig, damit alte Code-Pfade (slot-system.js, cd-auto-planner.js,
// dynamisch geladene Boss-Seiten) ohne Anpassung funktionieren.
window.firebaseTools = {
    db, auth, rtdb,
    doc, setDoc, onSnapshot, collection, deleteDoc, getDoc,
    serverTimestamp, query, orderBy, addDoc, updateDoc, where,
    getDocs, limit,
    // RTDB-Funktionen
    rtdbRef, rtdbSet, rtdbOnValue, rtdbOnDisconnect, rtdbOff, rtdbServerTimestamp
};