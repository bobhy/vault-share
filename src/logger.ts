import type { LogSeverity } from './settings';

export type { LogSeverity };

export interface LogEntry {
	timestamp: number;  // epoch ms
	severity: LogSeverity;
	message: string;
	detail?: string;
}

const SEVERITY_RANK: Record<LogSeverity, number> = {
	DEBUG: 0,
	INFO: 1,
	WARNING: 2,
	ERROR: 3,
};

/**
 * Plugin-wide logger.
 * Writes to the JS console and maintains a bounded ring buffer for the
 * optional sidebar log view.
 */
export class Logger {
	private entries: LogEntry[] = [];
	private onAppend: (() => void) | null = null;

	constructor(
		private readonly getMinSeverity: () => LogSeverity,
		private readonly getHorizon: () => number,
	) {}

	/** Register a callback invoked whenever a new entry is appended. */
	setAppendCallback(cb: () => void): void {
		this.onAppend = cb;
	}

	debug(message: string, detail?: string): void {
		this.log('DEBUG', message, detail);
	}

	info(message: string, detail?: string): void {
		this.log('INFO', message, detail);
	}

	warning(message: string, detail?: string): void {
		this.log('WARNING', message, detail);
	}

	error(message: string, detail?: string): void {
		this.log('ERROR', message, detail);
	}

	/** Return a snapshot of the current ring buffer (oldest → newest). */
	getEntries(): readonly LogEntry[] {
		return this.entries;
	}

	private log(severity: LogSeverity, message: string, detail?: string): void {
		if (SEVERITY_RANK[severity] < SEVERITY_RANK[this.getMinSeverity()]) return;

		const entry: LogEntry = { timestamp: Date.now(), severity, message, detail };

		const horizon = Math.max(1, this.getHorizon());
		this.entries.push(entry);
		if (this.entries.length > horizon) {
			this.entries = this.entries.slice(this.entries.length - horizon);
		}

		const prefix = `[vault-share] [${severity}]`;
		if (severity === 'ERROR') {
			console.error(prefix, message, detail ?? '');
		} else if (severity === 'WARNING') {
			console.warn(prefix, message, detail ?? '');
		} else {
			// eslint-disable-next-line obsidianmd/rule-custom-message -- logger module: console output is the designated mechanism per ARCHITECTURE.md
			console.log(prefix, message, detail ?? '');
		}

		this.onAppend?.();
	}
}
