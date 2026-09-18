// Обгортка над Firebase (Auth + Firestore) для синхронізації даних
// між Mac-застосунком "Навантаження" та цим iPhone PWA.

(function () {
    const firebaseApp = firebase.initializeApp(window.FIREBASE_CONFIG);
    const auth = firebase.auth();
    const db = firebase.firestore();

    db.enablePersistence({ synchronizeTabs: true }).catch((err) => {
        console.warn('Firestore persistence не увімкнено:', err.code);
    });

    function docRef(uid) {
        return db.collection('planners').doc(uid);
    }

    window.PlannerSync = {
        onAuthChange(callback) {
            return auth.onAuthStateChanged(callback);
        },

        signIn(email, password) {
            return auth.signInWithEmailAndPassword(email, password);
        },

        signOut() {
            return auth.signOut();
        },

        resetPassword(email) {
            return auth.sendPasswordResetEmail(email);
        },

        currentUser() {
            return auth.currentUser;
        },

        watchData(uid, callback) {
            return docRef(uid).onSnapshot(
                { includeMetadataChanges: true },
                (snap) => callback(snap.exists ? snap.data() : null, snap.metadata),
                (err) => console.error('Firestore watch error:', err)
            );
        },

        async saveData(uid, data) {
            await docRef(uid).set(data, { merge: false });
        }
    };
})();
