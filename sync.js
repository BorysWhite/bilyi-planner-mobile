// Обгортка над Firebase (Auth + Firestore) для синхронізації даних
// між Mac-застосунком та iPhone PWA. Той самий Firebase-проєкт, що й
// у "Навантаженні", але окрема колекція Firestore ("personalhub"),
// щоб дані двох застосунків не перетиналися.

(function () {
    const firebaseApp = firebase.initializeApp(window.FIREBASE_CONFIG);
    const auth = firebase.auth();
    const db = firebase.firestore();

    db.enablePersistence({ synchronizeTabs: true }).catch((err) => {
        console.warn('Firestore persistence не увімкнено:', err.code);
    });

    function docRef(uid) {
        return db.collection('personalhub').doc(uid);
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
