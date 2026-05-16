import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { Logger } from './logger';
import type { LogSeverity } from './logger';

function makeLogger(minSeverity: LogSeverity = 'DEBUG', horizon = 100): Logger {
	return new Logger(() => minSeverity, () => horizon);
}

describe('Logger', () => {
	describe('severity filtering', () => {
		it('logs DEBUG when min severity is DEBUG', () => {
			const logger = makeLogger('DEBUG');
			logger.debug('msg');
			expect(logger.getEntries()).toHaveLength(1);
		});

		it('filters DEBUG when min severity is INFO', () => {
			const logger = makeLogger('INFO');
			logger.debug('msg');
			expect(logger.getEntries()).toHaveLength(0);
		});

		it('filters DEBUG and INFO when min severity is WARNING', () => {
			const logger = makeLogger('WARNING');
			logger.debug('d');
			logger.info('i');
			logger.warning('w');
			expect(logger.getEntries()).toHaveLength(1);
			expect(logger.getEntries()[0]!.severity).toBe('WARNING');
		});

		it('only logs ERROR when min severity is ERROR', () => {
			const logger = makeLogger('ERROR');
			logger.debug('d');
			logger.info('i');
			logger.warning('w');
			logger.error('e');
			expect(logger.getEntries()).toHaveLength(1);
			expect(logger.getEntries()[0]!.severity).toBe('ERROR');
		});
	});

	describe('ring buffer / horizon', () => {
		it('retains up to horizon entries', () => {
			const logger = makeLogger('DEBUG', 3);
			logger.info('a');
			logger.info('b');
			logger.info('c');
			expect(logger.getEntries()).toHaveLength(3);
		});

		it('trims oldest entries when horizon is exceeded', () => {
			const logger = makeLogger('DEBUG', 3);
			logger.info('a');
			logger.info('b');
			logger.info('c');
			logger.info('d');
			const entries = logger.getEntries();
			expect(entries).toHaveLength(3);
			expect(entries[0]!.message).toBe('b');
			expect(entries[2]!.message).toBe('d');
		});

		it('always retains at least 1 entry when horizon is 0', () => {
			const logger = makeLogger('DEBUG', 0);
			logger.info('only');
			expect(logger.getEntries()).toHaveLength(1);
		});
	});

	describe('entry shape', () => {
		it('records severity, message, and timestamp', () => {
			const logger = makeLogger();
			const before = Date.now();
			logger.info('hello');
			const after = Date.now();
			const [entry] = logger.getEntries();
			expect(entry!.severity).toBe('INFO');
			expect(entry!.message).toBe('hello');
			expect(entry!.detail).toBeUndefined();
			expect(entry!.timestamp).toBeGreaterThanOrEqual(before);
			expect(entry!.timestamp).toBeLessThanOrEqual(after);
		});

		it('records optional detail', () => {
			const logger = makeLogger();
			logger.error('oops', 'stack trace here');
			expect(logger.getEntries()[0]!.detail).toBe('stack trace here');
		});
	});

	describe('getEntries', () => {
		it('returns entries oldest to newest', () => {
			const logger = makeLogger();
			logger.info('first');
			logger.info('second');
			const entries = logger.getEntries();
			expect(entries[0]!.message).toBe('first');
			expect(entries[1]!.message).toBe('second');
		});
	});

	describe('clear', () => {
		it('empties the entry buffer', () => {
			const logger = makeLogger();
			logger.info('msg');
			logger.clear();
			expect(logger.getEntries()).toHaveLength(0);
		});
	});

	describe('append callback', () => {
		it('is called on each log entry', () => {
			const logger = makeLogger();
			const cb = vi.fn();
			logger.setAppendCallback(cb);
			logger.info('a');
			logger.warning('b');
			expect(cb).toHaveBeenCalledTimes(2);
		});

		it('is called on clear', () => {
			const logger = makeLogger();
			const cb = vi.fn();
			logger.setAppendCallback(cb);
			logger.clear();
			expect(cb).toHaveBeenCalledTimes(1);
		});

		it('is not called for filtered-out entries', () => {
			const logger = makeLogger('ERROR');
			const cb = vi.fn();
			logger.setAppendCallback(cb);
			logger.debug('filtered');
			expect(cb).not.toHaveBeenCalled();
		});

		it('replacing the callback stops the old one from firing', () => {
			const logger = makeLogger();
			const cb1 = vi.fn();
			const cb2 = vi.fn();
			logger.setAppendCallback(cb1);
			logger.setAppendCallback(cb2);
			logger.info('msg');
			expect(cb1).not.toHaveBeenCalled();
			expect(cb2).toHaveBeenCalledTimes(1);
		});
	});

	describe('console output', () => {
		let logSpy: MockInstance;
		let warnSpy: MockInstance;
		let errorSpy: MockInstance;

		beforeEach(() => {
			logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
			warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		});

		it('uses console.log for DEBUG', () => {
			const logger = makeLogger();
			logger.debug('d');
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[DEBUG]'), 'd', '');
		});

		it('uses console.log for INFO', () => {
			const logger = makeLogger();
			logger.info('i');
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[INFO]'), 'i', '');
		});

		it('uses console.warn for WARNING', () => {
			const logger = makeLogger();
			logger.warning('w');
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[WARNING]'), 'w', '');
		});

		it('uses console.error for ERROR', () => {
			const logger = makeLogger();
			logger.error('e', 'detail');
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[ERROR]'), 'e', 'detail');
		});
	});
});
