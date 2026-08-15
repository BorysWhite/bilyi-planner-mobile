// Обгортка над Firebase (Auth + Firestore) для синхронізації даних
// між Mac-застосунком та iPhone PWA. Використовує "compat" SDK,
// тож підключається простими <script> тегами, без збірника.

(function () {
    const firebaseApp = firebase.initializeApp(window.FIREBASE_CONFIG);
    const auth = firebase.auth();
    const db = firebase.firestore();

    // Офлайн-кеш у браузері (IndexedDB), щоб додаток працював без інтернету
    // і показував останні відомі дані, а після повернення мережі — синхронізував.
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

        currentUser() {
            return auth.currentUser;
        },

        // Підписка на дані користувача в реальному часі.
        // callback отримує {calendarEvents, subjectNotes, checklistTasks, settings} або null, якщо документа ще нема.
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
