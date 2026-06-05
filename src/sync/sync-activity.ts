/**
 * Live, in-memory view of what the sync engine is doing *right now*.
 *
 * {@link CandidateStore} already notifies the UI on every *persistent* state
 * change (reconcile, markSynced, defer, pause, …), which keeps the Sharing
 * Status count table live. What it cannot express is the transient
 * "currently sharing file X" / "a bulk pass is running" signal — no store
 * mutation fires when a pass begins or advances to the next file.
 *
 * `SyncActivity` fills that gap: the shared `syncAndApplyFile` path reports the
 * file it is currently syncing (whoever drives it), and `BulkSync` reports
 * whether a pass is in flight. The Sharing Status panel subscribes via
 * {@link SyncActivity.onChange} to re-render the top status section in real time.
 *
 * @packageDocumentation
 */

/** Immutable snapshot of the engine's current activity. */
export interface SyncActivitySnapshot {
	/** True while a bulk-sync pass is in flight. */
	bulkRunning: boolean;
	/**
	 * Path of the file currently being synced — set by `syncAndApplyFile`
	 * regardless of whether a bulk pass or a single-file sync is driving — or
	 * `null` when no file is in flight.
	 */
	currentPath: string | null;
}

/**
 * Observable holder for the engine's transient activity state.
 *
 * Modeled on {@link CandidateStore}'s listener pattern: setters mutate the
 * in-memory snapshot and fire registered listeners, but only when the value
 * actually changes so a busy pass does not spam re-renders. Listeners run
 * synchronously in registration order; a throwing listener is logged and
 * skipped so it cannot block the others or the caller's progress.
 */
export class SyncActivity {
	private state: SyncActivitySnapshot = {
		bulkRunning: false,
		currentPath: null,
	};

	private readonly changeListeners = new Set<() => void>();

	/**
	 * Subscribe to activity-changed notifications. Returns an unsubscribe
	 * function — call it on teardown to prevent leaks.
	 */
	onChange(listener: () => void): () => void {
		this.changeListeners.add(listener);
		return () => { this.changeListeners.delete(listener); };
	}

	private fireChanged(): void {
		for (const listener of this.changeListeners) {
			try {
				listener();
			} catch (err) {
				// Listeners are UI code; an error here must not abort the engine
				// path that reported the activity change.
				console.error('SyncActivity change listener threw', err);
			}
		}
	}

	/** Mark a bulk pass as running or finished. Fires listeners only on change. */
	setBulkRunning(running: boolean): void {
		if (this.state.bulkRunning === running) return;
		this.state = { ...this.state, bulkRunning: running };
		this.fireChanged();
	}

	/** Set the file currently being synced (or `null` when none). Fires only on change. */
	setCurrentPath(path: string | null): void {
		if (this.state.currentPath === path) return;
		this.state = { ...this.state, currentPath: path };
		this.fireChanged();
	}

	/** Returns an independent copy of the current activity snapshot. */
	getSnapshot(): SyncActivitySnapshot {
		return { ...this.state };
	}
}
