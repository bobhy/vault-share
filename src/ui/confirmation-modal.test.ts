import { describe, it, expect, vi, afterEach } from 'vitest';
import { App } from 'obsidian';
import { ConfirmationModal } from './confirmation-modal';

const app = new App();

afterEach(() => {
	// Remove any modals left open by the test.
	activeDocument.body.innerHTML = '';
});

describe('ConfirmationModal', () => {
	describe('prompt()', () => {
		it('resolves true when Continue is clicked', async () => {
			const promise = ConfirmationModal.prompt(app, 'Title', '<p>Body</p>');

			const continueBtn = activeDocument.querySelector<HTMLButtonElement>('.modal-button-container .mod-cta');
			expect(continueBtn).not.toBeNull();
			continueBtn!.click();

			await expect(promise).resolves.toBe(true);
		});

		it('resolves false when Quit is clicked', async () => {
			const promise = ConfirmationModal.prompt(app, 'Title', '<p>Body</p>');

			const buttons = activeDocument.querySelectorAll<HTMLButtonElement>('.modal-button-container button');
			const quitBtn = Array.from(buttons).find(b => b.textContent === 'Quit');
			expect(quitBtn).not.toBeUndefined();
			quitBtn!.click();

			await expect(promise).resolves.toBe(false);
		});

		it('removes the modal from the DOM after a button is clicked', async () => {
			const promise = ConfirmationModal.prompt(app, 'Title', '<p>Body</p>');
			expect(activeDocument.querySelector('.modal-container')).not.toBeNull();

			activeDocument.querySelector<HTMLButtonElement>('.modal-button-container .mod-cta')!.click();
			await promise;

			expect(activeDocument.querySelector('.modal-container')).toBeNull();
		});

		it('renders title and button labels in contentEl', () => {
			void ConfirmationModal.prompt(app, 'Sync now?', '<p>Proceed?</p>');

			const h2 = activeDocument.querySelector('.modal-content h2');
			expect(h2?.textContent).toBe('Sync now?');

			const continueBtn = activeDocument.querySelector<HTMLButtonElement>('.modal-button-container .mod-cta');
			expect(continueBtn?.textContent).toBe('Continue');

			const buttons = activeDocument.querySelectorAll<HTMLButtonElement>('.modal-button-container button');
			const quitBtn = Array.from(buttons).find(b => b.textContent === 'Quit');
			expect(quitBtn).toBeDefined();
		});

		it('supports custom button labels', async () => {
			const promise = ConfirmationModal.prompt(app, 'Title', '<p>Body</p>', 'Resume', 'Keep paused');

			const continueBtn = activeDocument.querySelector<HTMLButtonElement>('.modal-button-container .mod-cta');
			expect(continueBtn?.textContent).toBe('Resume');

			const buttons = activeDocument.querySelectorAll<HTMLButtonElement>('.modal-button-container button');
			const cancelBtn = Array.from(buttons).find(b => b.textContent === 'Keep paused');
			expect(cancelBtn).toBeDefined();

			continueBtn!.click();
			await expect(promise).resolves.toBe(true);
		});

		it('calls sanitizeHTMLToDom with the provided body HTML', async () => {
			const { sanitizeHTMLToDom } = await import('obsidian');
			const spy = vi.mocked(sanitizeHTMLToDom);

			void ConfirmationModal.prompt(app, 'Title', '<b>important</b>');

			expect(spy).toHaveBeenCalledWith('<b>important</b>');
		});
	});

	describe('alert()', () => {
		it('renders a single button with the given label and no cancel button', () => {
			void ConfirmationModal.alert(app, 'Heads up', '<p>Body</p>', 'OK');

			const buttons = activeDocument.querySelectorAll<HTMLButtonElement>('.modal-button-container button');
			expect(buttons).toHaveLength(1);
			expect(buttons[0]!.textContent).toBe('OK');
		});

		it('defaults the button label to "OK"', () => {
			void ConfirmationModal.alert(app, 'Heads up', '<p>Body</p>');

			const btn = activeDocument.querySelector<HTMLButtonElement>('.modal-button-container button');
			expect(btn?.textContent).toBe('OK');
		});

		it('resolves and removes the modal when the button is clicked', async () => {
			const promise = ConfirmationModal.alert(app, 'Heads up', '<p>Body</p>');
			expect(activeDocument.querySelector('.modal-container')).not.toBeNull();

			activeDocument.querySelector<HTMLButtonElement>('.modal-button-container button')!.click();

			await expect(promise).resolves.toBeUndefined();
			expect(activeDocument.querySelector('.modal-container')).toBeNull();
		});
	});
});
