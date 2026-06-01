/**
 * Reusable yes/no modal.
 *
 * Used wherever the plugin needs explicit user confirmation before a
 * destructive or visible action (Drive folder change, plugin reset, sync
 * conflict notice). Always invoked via the static {@link ConfirmationModal.prompt}
 * which returns a Promise resolving to the user's choice.
 *
 * @packageDocumentation
 */
import { App, Modal, sanitizeHTMLToDom } from 'obsidian';

/**
 * Generic two-button confirmation modal used throughout the plugin.
 * Resolves true when the user clicks the confirm button, false on dismiss.
 *
 * Button labels default to "Continue" / "Quit" but can be overridden via
 * the optional {@link prompt} parameters for context-specific copy.
 */
export class ConfirmationModal extends Modal {
	private resolve!: (value: boolean) => void;

	private constructor(
		app: App,
		private readonly title: string,
		private readonly bodyHtml: string,
		private readonly confirmLabel: string = 'Continue',
		private readonly cancelLabel: string = 'Quit',
	) {
		super(app);
	}

	/**
	 * Show the modal and wait for user input.
	 * @param confirmLabel - Label for the confirm (CTA) button. Defaults to "Continue".
	 * @param cancelLabel  - Label for the cancel button. Defaults to "Quit".
	 */
	static prompt(
		app: App,
		title: string,
		bodyHtml: string,
		confirmLabel = 'Continue',
		cancelLabel = 'Quit',
	): Promise<boolean> {
		return new Promise(resolve => {
			const modal = new ConfirmationModal(app, title, bodyHtml, confirmLabel, cancelLabel);
			modal.resolve = resolve;
			modal.open();
		});
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', { text: this.title });

		const body = contentEl.createDiv();
		body.appendChild(sanitizeHTMLToDom(this.bodyHtml));

		const buttonRow = contentEl.createDiv({ cls: 'modal-button-container' });

		const continueBtn = buttonRow.createEl('button', { text: this.confirmLabel, cls: 'mod-cta' });
		continueBtn.addEventListener('click', () => {
			this.resolve(true);
			this.close();
		});

		const quitBtn = buttonRow.createEl('button', { text: this.cancelLabel });
		quitBtn.addEventListener('click', () => {
			this.resolve(false);
			this.close();
		});
	}

	onClose(): void {
		// If closed without clicking a button (e.g. Escape key), treat as Quit.
		this.resolve?.(false);
		this.contentEl.empty();
	}
}
