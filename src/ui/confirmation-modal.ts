/**
 * Reusable confirmation / acknowledgement modal.
 *
 * Two-button form ({@link ConfirmationModal.prompt}) is used wherever the
 * plugin needs explicit user confirmation before a destructive or visible
 * action (Drive folder change, plugin reset, sync conflict notice) and resolves
 * to the user's choice. Single-button form ({@link ConfirmationModal.alert})
 * is used to report a non-recoverable condition the user can only acknowledge
 * (e.g. the shared Drive folder was written by a newer plugin version).
 *
 * @packageDocumentation
 */
import { App, Modal, sanitizeHTMLToDom } from 'obsidian';

/**
 * Generic confirmation / acknowledgement modal used throughout the plugin.
 *
 * In two-button mode it resolves `true` when the user clicks the confirm button
 * and `false` on dismiss. In single-button mode (see {@link alert}) the cancel
 * button is suppressed and the modal resolves once acknowledged or dismissed.
 *
 * Button labels default to "Continue" / "Quit" but can be overridden via the
 * static factory parameters for context-specific copy.
 */
export class ConfirmationModal extends Modal {
	private resolve!: (value: boolean) => void;

	private constructor(
		app: App,
		private readonly title: string,
		private readonly bodyHtml: string,
		private readonly confirmLabel: string = 'Continue',
		private readonly cancelLabel: string = 'Quit',
		private readonly singleButton = false,
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

	/**
	 * Show a single-button acknowledgement modal for a non-recoverable
	 * condition. Resolves once the user clicks the button or otherwise dismisses
	 * the modal — there is no "cancel" outcome to distinguish.
	 * @param buttonLabel - Label for the sole button. Defaults to "OK".
	 */
	static alert(
		app: App,
		title: string,
		bodyHtml: string,
		buttonLabel = 'OK',
	): Promise<void> {
		return new Promise(resolve => {
			const modal = new ConfirmationModal(app, title, bodyHtml, buttonLabel, buttonLabel, true);
			modal.resolve = () => resolve();
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

		if (!this.singleButton) {
			const quitBtn = buttonRow.createEl('button', { text: this.cancelLabel });
			quitBtn.addEventListener('click', () => {
				this.resolve(false);
				this.close();
			});
		}
	}

	onClose(): void {
		// If closed without clicking a button (e.g. Escape key), treat as Quit.
		this.resolve?.(false);
		this.contentEl.empty();
	}
}
