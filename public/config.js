// Berlim Homes Rent Ledger: Firebase settings.
// Copy apiKey and appId from Firebase console > Project settings > Your apps > Web app (</>).
// These web settings are not passwords; access is protected by the security rules.
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDKp8ToGCtznVD46ofpLysn1vZY-J_oIFk",
  authDomain: "berlim-homes-ltd.firebaseapp.com",
  projectId: "berlim-homes-ltd",
  storageBucket: "berlim-homes-ltd.firebasestorage.app",
  messagingSenderId: "913673292368",
  appId: "1:913673292368:web:105496f3581e5f31c29f55"
};
// Logins that are always administrators. Keep this list the same as ADMIN_EMAILS in firestore.rules.
export const ADMIN_EMAILS = ["berlimhomes@gmail.com"];
// File storage (meter photos, signed agreements, PDF links) needs Firebase Storage, which needs the Blaze plan.
// Leave false on the free Spark plan; change to true after you turn on Storage.
export const STORAGE_ON = false;
// Name of the Firestore database (Firebase console > Firestore > the database dropdown).
// Usually "(default)"; this project's database is named "default".
export const FIRESTORE_DB = "default";
