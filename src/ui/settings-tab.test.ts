import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App } from 'obsidian';
import { VaultShareSettingTab } from './settings-tab';
import type VaultSharePlugin from '../main';

const { promptMock } = vi.hoisted(() => ({ promptMock: vi.fn() }));
vi.mock('./confirmation-modal', () => ({ ConfirmationModal: { prompt: promptMock } }));

interface PluginMock {
	app: { vault: { getName: () => string } };
	settings: {
		driveFolderPath: string;
		fileConflict: string;
		textFileConflict: string;
		excludeRules: string[];
		bulkSyncPoll: number;
		openFilePoll: number;
		openFileChangeHoldDown: number;
		logHorizon: number;
	};
	auth: { isAuthenticated: boolean };
	statsTracker: { getCurrent: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn> };
	saveData: ReturnType<typeof vi.fn>;
	onDriveFolderPathChange: ReturnType<typeof vi.fn>;
	rebuildExcludeMatcher: ReturnType<typeof vi.fn>;
	login: ReturnType<typeof vi.fn>;
	logout: ReturnType<typeof vi.fn>;
	pluginReset: ReturnType<typeof vi.fn>;
	getGroupVaultSchemaVersion: ReturnType<typeof vi.fn>;
}

function makePlugin(over: { authenticated?: boolean; stats?: Record<string, number> | undefined } = {}): PluginMock {
	return {
		app: { vault: { getName: () => 'my-vault' } },
		settings: {
			driveFolderPath: '/vault-share/my-vault',
			fileConflict: 'Use Newer',
			textFileConflict: 'Merge',
			excludeRules: ['*.tmp'],
			bulkSyncPoll: 60,
			openFilePoll: 30,
			openFileChangeHoldDown: 5,
			logHorizon: 100,
		},
		auth: { isAuthenticated: over.authenticated ?? false },
		statsTracker: {
			getCurrent: vi.fn(() => over.stats),
			reset: vi.fn(() => Promise.resolve()),
		},
		saveData: vi.fn(() => Promise.resolve()),
		onDriveFolderPathChange: vi.fn(() => Promise.resolve()),
		rebuildExcludeMatcher: vi.fn(),
		login: vi.fn(() => Promise.resolve()),
		logout: vi.fn(() => Promise.resolve()),
		pluginReset: vi.fn(() => Promise.resolve()),
		getGroupVaultSchemaVersion: vi.fn(() => Promise.resolve(3)),
	};
}

function makeTab(plugin: PluginMock): VaultShareSettingTab {
	return new VaultShareSettingTab(new App(), plugin as unknown as VaultSharePlugin);
}

/** The `.setting-item` whose name matches, or throw. */
function settingByName(container: HTMLElement, name: string): HTMLElement {
	const item = [...container.querySelectorAll('.setting-item')]
		.find(i => i.querySelector('.setting-item-name')?.textContent === name);
	if (!item) throw new Error(`setting not found: ${name}`);
	return item as HTMLElement;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('VaultShareSettingTab — structure', () => {
	it('renders all section headings', () => {
		const tab = makeTab(makePlugin());
		tab.display();
		const headings = [...tab.containerEl.querySelectorAll('.setting-item-heading .setting-item-name')]
			.map(e => e.textContent);
		expect(headings).toEqual(
			expect.arrayContaining(['Connection', 'Conflict resolution', 'Sharing', 'Logging', 'Plugin']),
		);
	});

	it('clears the container on each display() so re-render does not duplicate', () => {
		const tab = makeTab(makePlugin());
		tab.display();
		const first = tab.containerEl.querySelectorAll('.setting-item').length;
		tab.display();
		expect(tab.containerEl.querySelectorAll('.setting-item').length).toBe(first);
	});
});

describe('VaultShareSettingTab — connection', () => {
	it('drive folder path blur invokes onDriveFolderPathChange with the value', () => {
		const plugin = makePlugin();
		const tab = makeTab(plugin);
		tab.display();
		const input = settingByName(tab.containerEl, 'Drive folder path').querySelector('input') as HTMLInputElement;
		input.value = '/new/path';
		input.dispatchEvent(new Event('blur'));
		expect(plugin.onDriveFolderPathChange).toHaveBeenCalledWith('/new/path');
	});

	it('shows Log In and calls login() when not authenticated', () => {
		const plugin = makePlugin({ authenticated: false });
		const tab = makeTab(plugin);
		tab.display();
		const btn = settingByName(tab.containerEl, 'Google Drive account').querySelector('button') as HTMLButtonElement;
		expect(btn.textContent).toBe('Log In');
		btn.click();
		expect(plugin.login).toHaveBeenCalled();
		expect(plugin.logout).not.toHaveBeenCalled();
	});

	it('shows Log Out and calls logout() when authenticated', () => {
		const plugin = makePlugin({ authenticated: true });
		const tab = makeTab(plugin);
		tab.display();
		const btn = settingByName(tab.containerEl, 'Google Drive account').querySelector('button') as HTMLButtonElement;
		expect(btn.textContent).toBe('Log Out');
		btn.click();
		expect(plugin.logout).toHaveBeenCalled();
	});
});

describe('VaultShareSettingTab — conflict resolution dropdowns', () => {
	it('changing "For most files" writes the setting and saves', () => {
		const plugin = makePlugin();
		const tab = makeTab(plugin);
		tab.display();
		const select = settingByName(tab.containerEl, 'For most files').querySelector('select') as HTMLSelectElement;
		select.value = 'Keep Both';
		select.dispatchEvent(new Event('change'));
		expect(plugin.settings.fileConflict).toBe('Keep Both');
		expect(plugin.saveData).toHaveBeenCalledWith(plugin.settings);
	});

	it('changing "For text files" writes textFileConflict', () => {
		const plugin = makePlugin();
		const tab = makeTab(plugin);
		tab.display();
		const select = settingByName(tab.containerEl, 'For text files (.md, .txt)').querySelector('select') as HTMLSelectElement;
		select.value = 'Use Newer';
		select.dispatchEvent(new Event('change'));
		expect(plugin.settings.textFileConflict).toBe('Use Newer');
		expect(plugin.saveData).toHaveBeenCalled();
	});
});

describe('VaultShareSettingTab — sharing settings', () => {
	it('exclude rules textarea splits lines, saves, and rebuilds the matcher', async () => {
		const plugin = makePlugin();
		const tab = makeTab(plugin);
		tab.display();
		const area = settingByName(tab.containerEl, 'Exclude rules').querySelector('textarea') as HTMLTextAreaElement;
		area.value = 'a\n!b\nc';
		area.dispatchEvent(new Event('input'));
		await Promise.resolve(); await Promise.resolve(); // rebuildExcludeMatcher runs after `await saveData`
		expect(plugin.settings.excludeRules).toEqual(['a', '!b', 'c']);
		expect(plugin.saveData).toHaveBeenCalled();
		expect(plugin.rebuildExcludeMatcher).toHaveBeenCalled();
	});

	it('a valid sharing interval is parsed and saved', () => {
		const plugin = makePlugin();
		const tab = makeTab(plugin);
		tab.display();
		const input = settingByName(tab.containerEl, 'Sharing interval').querySelector('input') as HTMLInputElement;
		input.value = '120';
		input.dispatchEvent(new Event('input'));
		expect(plugin.settings.bulkSyncPoll).toBe(120);
		expect(plugin.saveData).toHaveBeenCalled();
	});

	it('an invalid (non-numeric) interval is ignored', () => {
		const plugin = makePlugin();
		const tab = makeTab(plugin);
		tab.display();
		const input = settingByName(tab.containerEl, 'Sharing interval').querySelector('input') as HTMLInputElement;
		input.value = 'oops';
		input.dispatchEvent(new Event('input'));
		expect(plugin.settings.bulkSyncPoll).toBe(60); // unchanged
		expect(plugin.saveData).not.toHaveBeenCalled();
	});

	// The remaining numeric fields share the parse-and-save shape; cover each so
	// every onChange handler is exercised.
	it.each<[string, keyof PluginMock['settings']]>([
		['Open file poll interval', 'openFilePoll'],
		['Edit holddown', 'openFileChangeHoldDown'],
		['Log history size', 'logHorizon'],
	])('%s parses and saves a valid value', (label, key) => {
		const plugin = makePlugin();
		const tab = makeTab(plugin);
		tab.display();
		const input = settingByName(tab.containerEl, label).querySelector('input') as HTMLInputElement;
		input.value = '42';
		input.dispatchEvent(new Event('input'));
		expect(plugin.settings[key]).toBe(42);
		expect(plugin.saveData).toHaveBeenCalled();
	});
});

describe('VaultShareSettingTab — statistics section', () => {
	it('omits the stat rows when there are no stats (heading always shown)', () => {
		const plugin = makePlugin({ stats: undefined });
		const tab = makeTab(plugin);
		tab.display();
		const names = [...tab.containerEl.querySelectorAll('.setting-item-name')].map(e => e.textContent);
		expect(names).not.toContain('Reset statistics');
		expect(names).not.toContain('Group vault schema');
		expect(plugin.getGroupVaultSchemaVersion).not.toHaveBeenCalled();
	});

	it('renders stat rows and a reset button when stats exist', async () => {
		const plugin = makePlugin({ stats: {
			serverClockSkew: 1, APIResponseTime: 2, bulkSyncPasses: 3, bulkPassesWithDuplicates: 0,
			singleFileSyncCount: 4, filesPushed: 5, filesPulled: 6, filesMerged: 7,
			contentConflicts: 8, deleteConflicts: 9,
		} });
		const tab = makeTab(plugin);
		tab.display();

		const headings = [...tab.containerEl.querySelectorAll('.setting-item-heading .setting-item-name')]
			.map(e => e.textContent);
		expect(headings).toContain('Statistics');
		expect(plugin.getGroupVaultSchemaVersion).toHaveBeenCalled();

		const resetBtn = settingByName(tab.containerEl, 'Reset statistics').querySelector('button') as HTMLButtonElement;
		resetBtn.click();
		await Promise.resolve();
		expect(plugin.statsTracker.reset).toHaveBeenCalled();
	});
});

describe('VaultShareSettingTab — reset plugin', () => {
	it('resets after confirmation', async () => {
		promptMock.mockResolvedValue(true);
		const plugin = makePlugin();
		const tab = makeTab(plugin);
		tab.display();
		const btn = settingByName(tab.containerEl, 'Reset plugin').querySelector('button') as HTMLButtonElement;
		btn.click();
		await Promise.resolve(); await Promise.resolve();
		expect(promptMock).toHaveBeenCalled();
		expect(plugin.pluginReset).toHaveBeenCalled();
	});

	it('does nothing when the confirmation is declined', async () => {
		promptMock.mockResolvedValue(false);
		const plugin = makePlugin();
		const tab = makeTab(plugin);
		tab.display();
		const btn = settingByName(tab.containerEl, 'Reset plugin').querySelector('button') as HTMLButtonElement;
		btn.click();
		await Promise.resolve(); await Promise.resolve();
		expect(plugin.pluginReset).not.toHaveBeenCalled();
	});
});
