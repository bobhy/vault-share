/**
 * UI e2e: the conflict-resolution panel renders within the tappable edit view
 * on mobile.
 *
 * Regression test for gh#08 follow-up: on mobile the panel must dock at the
 * BOTTOM of the editor (CM6 bottom panel). A top panel sits under the device
 * status/notification bar, overlaying the buttons and pushing them out of the
 * tappable region.
 *
 * Runs under `emulateMobile: true` (see wdio.ui.conf.mts), so Platform.isMobile
 * is true and the panel-placement branch under test (`top: !Platform.isMobile`)
 * resolves to a bottom dock. No Google Drive credentials are required — the
 * conflict navigator operates purely on local editor content.
 *
 * Caveat: Electron mobile emulation reproduces the layout mechanism (bottom
 * dock + mobile CSS) but not real-device touch-event swallowing, so this spec
 * asserts placement and that a rendered activation resolves the conflict; the
 * touchend tap fix itself is guarded by the unit test (buildConflictBanner).
 */
import { MARKER_OPEN, MARKER_CLOSE, segmentMarker } from "../../../src/sync/nway-merge";

const NOTE_PATH = `conflict-panel-ui-${Date.now()}.md`;

// A single two-segment conflict region: base + A1.
const REGION = [
	MARKER_OPEN,
	segmentMarker("base"),
	"base content",
	segmentMarker("A1"),
	"a1 content",
	MARKER_CLOSE,
].join("\n");

describe("Conflict panel placement (mobile)", () => {
	before(async () => {
		await browser.executeObsidian(async ({ app }, path, body) => {
			const existing = app.vault.getAbstractFileByPath(path as string);
			if (existing) await app.vault.delete(existing);
			const file = await app.vault.create(path as string, body as string);

			// Open in an editing (source-mode) markdown leaf so the CM6 editor —
			// and therefore the editorCallback command and CM panel — are live.
			const leaf = app.workspace.getLeaf(true);
			await leaf.openFile(file, { active: true });
			await leaf.setViewState({
				type: "markdown",
				active: true,
				state: { file: file.path, mode: "source" },
			});
			app.workspace.setActiveLeaf(leaf, { focus: true });
		}, NOTE_PATH, REGION);
	});

	it("docks the resolution panel at the bottom and renders a button per segment", async () => {
		await browser.executeObsidianCommand("vault-share:find-next-conflict");

		// Wait for the panel to mount, then read where it docked and its buttons.
		const info = await browser.waitUntil(
			async () => {
				const r = await browser.executeObsidian(() => {
					const banner = activeDocument.querySelector(".vault-share-conflict-banner");
					if (!banner) return { present: false as const };
					const panel = banner.closest(".cm-panels-bottom, .cm-panels-top");
					const dock = panel?.classList.contains("cm-panels-bottom")
						? "bottom"
						: panel?.classList.contains("cm-panels-top")
							? "top"
							: "none";
					const buttons = [...banner.querySelectorAll(".vault-share-conflict-banner-btn")]
						.map(b => b.textContent);
					return { present: true as const, dock, buttons };
				});
				return r.present ? r : false;
			},
			{ timeout: 10_000, interval: 200, timeoutMsg: "conflict banner never appeared" },
		);

		expect(info.dock).toBe("bottom");
		expect(info.buttons).toEqual(["base", "A1"]);
	});

	it("resolving via the A1 button replaces the region and dismisses the panel", async () => {
		// Click the rendered button like a user would.
		const btn = await browser.$(".vault-share-conflict-banner-btn=A1");
		await btn.click();

		await browser.waitUntil(
			async () => browser.executeObsidian(
				() => !activeDocument.querySelector(".vault-share-conflict-banner"),
			),
			{ timeout: 10_000, interval: 200, timeoutMsg: "panel was not dismissed after resolving" },
		);

		// Read the live editor buffer, not the file on disk: applyResolution mutates
		// the CM editor, and Obsidian flushes that to disk asynchronously, so a disk
		// read can race ahead of the flush.
		const content = await browser.executeObsidian(({ app, obsidian }) => {
			const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
			return view ? view.editor.getValue() : null;
		});

		expect(content?.trim()).toBe("a1 content");
	});

	after(async () => {
		await browser.executeObsidian(async ({ app }, path) => {
			const file = app.vault.getAbstractFileByPath(path as string);
			if (file) await app.vault.delete(file);
		}, NOTE_PATH);
	});
});
