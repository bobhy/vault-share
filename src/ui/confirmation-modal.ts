import { App, Modal, sanitizeHTMLToDom } from 'obsidian';

export interface ConfirmationModalOptions {
	/** Label for the primary (OK) button. Defaults to 'Continue'. */
	ok?: string;
	/** Label for the secondary (cancel) button. Defaults to 'Quit'. */
	cancel?: string;
}

/**
 * Generic two-button confirmation modal used throughout the plugin.
 * Resolves true when the user clicks the primary button, false on the
 * secondary button or dismiss (Escape / click-outside).
 */
export class ConfirmationModal extends Modal {
	private resolve!: (value: boolean) => void;

	private constructor(
		app: App,
		private readonly title: string,
		private readonly bodyHtml: string,
		private readonly options: Required<ConfirmationModalOptions>,
	) {
		super(app);
	}

	/** Show the modal and wait for user input. */
	static prompt(
		app: App,
		title: string,
		bodyHtml: string,
		options?: ConfirmationModalOptions,
	): Promise<boolean> {
		return new Promise(resolve => {
			const modal = new ConfirmationModal(app, title, bodyHtml, {
				ok: options?.ok ?? 'Continue',
				cancel: options?.cancel ?? 'Quit',
			});
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

		const continueBtn = buttonRow.createEl('button', { text: this.options.ok, cls: 'mod-cta' });
		continueBtn.addEventListener('click', () => {
			this.resolve(true);
			this.close();
		});

		const quitBtn = buttonRow.createEl('button', { text: this.options.cancel });
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
