import {
	App,
	DataWriteOptions,
	Editor,
	MarkdownView,
	Menu,
	MenuItem,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	SecretComponent,
	Setting,
	TFile,
	normalizePath,
	parseYaml,
	requestUrl,
	setIcon,
} from "obsidian";
import { marked, Renderer } from "marked";

/* ------------------------------------------------------------------ */
/* Types & constants                                                   */
/* ------------------------------------------------------------------ */

interface CachedMedia {
	mtime: number;
	id: number;
	url: string;
}

interface WPSettings {
	siteUrl: string;
	username: string;
	secretId: string;
	defaultStatus: "draft" | "publish";
	autoAddProperties: boolean;
	postsFolder: string;
	centerImages: boolean;
	externalLinksNewTab: boolean;
	hideFolder: string;
	hideImages: boolean;
	reuseImages: boolean;
	captionsFromAlt: boolean;
	lightbox: boolean;
	sortNotesFirst: boolean;
	sizeSmall: number;
	sizeMedium: number;
	alignMenu: boolean;
	perPostFolders: boolean;
	syncNameToTitle: boolean;
	tagsProperty: string;
	mediaCache: Record<string, CachedMedia>;
	hashCache: Record<string, { id: number; url: string }>;
}

const DEFAULT_SETTINGS: WPSettings = {
	siteUrl: "",
	username: "",
	secretId: "",
	defaultStatus: "draft",
	autoAddProperties: true,
	postsFolder: "",
	centerImages: true,
	externalLinksNewTab: true,
	hideFolder: "",
	hideImages: true,
	reuseImages: true,
	captionsFromAlt: true,
	lightbox: true,
	sortNotesFirst: true,
	sizeSmall: 300,
	sizeMedium: 500,
	alignMenu: true,
	perPostFolders: true,
	syncNameToTitle: true,
	tagsProperty: "tags",
	mediaCache: {},
	hashCache: {},
};

// Properties inserted into new notes (order matters)
function templateProps(tagsProp: string): Record<string, unknown> {
	return {
		title: "",
		excerpt: "",
		slug: "",
		[tagsProp]: [],
		categories: [],
		featured_image: "",
	};
}

const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"];
const MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	avif: "image/avif",
};

interface PublishState {
	title: string;
	status: "draft" | "publish";
	categories: string[];
	tags: string[];
	featuredRaw: string; // current featured_image property (display only)
	featuredFile: File | null; // newly picked from the computer
	removeFeatured: boolean;
}

interface ImgUnit {
	id: number;
	url: string;
	alt: string;
	caption: string;
	width: string;
	expand: boolean;
}

interface TermInfo {
	name: string;
	count: number;
}

interface PublishResult {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	post: any;
	warnings: string[];
	updated: boolean;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function toList(v: unknown): string[] {
	let arr: unknown[] = [];
	if (Array.isArray(v)) arr = v;
	else if (typeof v === "string") arr = v.split(",");
	return arr
		.map((s) => String(s).replace(/^#/, "").trim())
		.filter(Boolean);
}

interface EmbedParts {
	target: string;
	caption: string;
	width: string; // raw, e.g. "300" or "300x200"
	expand: boolean | null; // null = follow the default
}

/**
 * ![[target|expand|caption|300]] -> parts.
 * Obsidian only reads the size from the LAST part, so the width always goes last.
 */
function parseEmbed(inner: string): EmbedParts {
	const [target, ...restRaw] = inner.split("|");
	const rest = restRaw.map((x) => x.trim());
	const out: EmbedParts = { target: target.trim(), caption: "", width: "", expand: null };

	let widthIdx = -1;
	rest.forEach((p, i) => {
		if (/^\d+(x\d+)?$/.test(p)) widthIdx = i;
	});
	const text: string[] = [];
	rest.forEach((p, i) => {
		if (i === widthIdx) out.width = p;
		else if (/^expand$/i.test(p)) out.expand = true;
		else if (/^noexpand$/i.test(p)) out.expand = false;
		else if (p) text.push(p);
	});
	out.caption = text.join("|");
	return out;
}

function buildEmbed(p: EmbedParts): string {
	const bits = [p.target];
	if (p.expand !== null) bits.push(p.expand ? "expand" : "noexpand");
	if (p.caption) bits.push(p.caption);
	if (p.width) bits.push(p.width); // keep last
	return `![[${bits.join("|")}]]`;
}

function sanitizeName(s: string): string {
	return s
		.replace(/[\\/:*?"<>|#^\[\]]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\.+$/, "")
		.slice(0, 100)
		.trim();
}

function joinPath(a: string, b: string): string {
	const base = a === "/" ? "" : a;
	return normalizePath(base ? `${base}/${b}` : b);
}

function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function decodeEntities(s: string): string {
	const doc = new DOMParser().parseFromString(s, "text/html");
	return doc.body.textContent ?? s;
}

async function replaceAsync(
	str: string,
	re: RegExp,
	fn: (...groups: string[]) => Promise<string>
): Promise<string> {
	let out = "";
	let last = 0;
	for (const m of str.matchAll(re)) {
		out += str.slice(last, m.index);
		out += await fn(...(m as unknown as string[]));
		last = (m.index ?? 0) + m[0].length;
	}
	return out + str.slice(last);
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

export default class WPPublisherPlugin extends Plugin {
	settings!: WPSettings;
	private warnings: string[] = [];
	private hideStyleEl: HTMLStyleElement | null = null;
	private renameTimers = new Map<string, number>();
	private restoreFns: (() => void)[] = [];
	private imgUnits: ImgUnit[] = [];
	private previewActions = new WeakMap<MarkdownView, HTMLElement>();
	private pendingImg: { el: HTMLElement; x: number; y: number; consumed: boolean } | null = null;
	private decorateQueued = false;
	private reusePaths = new Set<string>();

	async onload() {
		await this.loadSettings();
		this.applyHideCss();

		this.addRibbonIcon("list-plus", "Add WordPress properties", () =>
			this.cmdAddProperties()
		);
		this.addRibbonIcon("send", "Publish to WordPress", () =>
			this.cmdPublish()
		);

		this.addCommand({
			id: "add-wp-properties",
			name: "Add WordPress properties to this note",
			callback: () => this.cmdAddProperties(),
		});
		this.addCommand({
			id: "publish-to-wp",
			name: "Publish / update this note on WordPress",
			callback: () => this.cmdPublish(),
		});

		for (const [id, name, align] of [
			["align-left", "Align text left (reset)", "left"],
			["align-center", "Align text center", "center"],
			["align-right", "Align text right", "right"],
		] as const) {
			this.addCommand({
				id,
				name,
				editorCallback: (editor) => this.alignSelection(editor, align),
			});
		}
		this.addCommand({
			id: "organize-note",
			name: "Move this note into its own post folder",
			callback: async () => {
				const f = this.activeMd();
				if (!f) return;
				const moved = await this.organizeNote(f);
				new Notice(moved ? "Moved into its own folder." : "Already in its own folder.");
			},
		});
		this.addCommand({
			id: "organize-all",
			name: "Move all notes (in posts folder) into their own post folders",
			callback: async () => {
				let n = 0;
				for (const f of this.app.vault.getMarkdownFiles()) {
					if (!this.inScope(f)) continue;
					try {
						if (await this.organizeNote(f)) n++;
					} catch (e) {
						console.error("Wordpresser organize failed", f.path, e);
					}
				}
				new Notice(`Moved ${n} note${n === 1 ? "" : "s"} into their own folders.`);
			},
		});

		this.addSettingTab(new WPSettingTab(this.app, this));

		// Right-click alignment menu
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor) => {
				this.consumeImageMenu(menu);
				const pf = this.app.workspace.getActiveFile();
				const pinfo = pf ? this.previewInfo(pf) : null;
				if (pinfo) {
					menu.addItem((i) =>
						i
							.setTitle(pinfo.published ? "View post on WordPress" : "Preview draft on WordPress")
							.setIcon("eye")
							.onClick(() => window.open(pinfo.url))
					);
				}
				if (!this.settings.alignMenu) return;
				const opts = [
					["Align left (reset)", "align-left", "left"],
					["Align center", "align-center", "center"],
					["Align right", "align-right", "right"],
				] as const;
				const hasSub =
					typeof (MenuItem.prototype as unknown as { setSubmenu?: unknown })
						.setSubmenu === "function";
				if (hasSub) {
					menu.addItem((item) => {
						item.setTitle("Align text").setIcon("align-center");
						const sub = (item as unknown as { setSubmenu: () => Menu }).setSubmenu();
						for (const [title, icon, align] of opts) {
							sub.addItem((i) =>
								i
									.setTitle(title)
									.setIcon(icon)
									.onClick(() => this.alignSelection(editor, align))
							);
						}
					});
				} else {
					for (const [title, icon, align] of opts) {
						menu.addItem((i) =>
							i
								.setTitle(title)
								.setIcon(icon)
								.onClick(() => this.alignSelection(editor, align))
						);
					}
				}
			})
		);

		this.app.workspace.onLayoutReady(() => {
			// New, empty notes: add properties and move into their own folder
			this.registerEvent(
				this.app.vault.on("create", (f) => {
					if (!(f instanceof TFile) || f.extension !== "md") return;
					if (!this.inScope(f)) return;
					setTimeout(async () => {
						try {
							const content = await this.app.vault.read(f);
							if (content.trim() !== "") return;
							if (this.settings.autoAddProperties)
								await this.addProperties(f);
							if (this.settings.perPostFolders)
								await this.organizeNote(f);
						} catch (e) {
							console.error("Wordpresser auto-setup failed", e);
						}
					}, 200);
				})
			);

			// Note renamed -> rename its post folder to match
			this.registerEvent(
				this.app.vault.on("rename", async (f, oldPath) => {
					if (!this.settings.perPostFolders) return;
					if (!(f instanceof TFile) || f.extension !== "md") return;
					const oldName = oldPath
						.split("/")
						.pop()!
						.replace(/\.md$/, "");
					if (oldName === f.basename) return;
					const folder = f.parent;
					if (!folder || folder.isRoot() || folder.name !== oldName) return;
					const parentPath = folder.parent?.path ?? "";
					const target = joinPath(parentPath, f.basename);
					if (this.app.vault.getAbstractFileByPath(target)) return;
					try {
						await this.app.fileManager.renameFile(folder, target);
					} catch (e) {
						console.error("Wordpresser folder rename failed", e);
					}
				})
			);

			// Title property changed -> rename note (folder follows)
			this.registerEvent(
				this.app.metadataCache.on("changed", (f, _data, cache) => {
					if (!this.settings.syncNameToTitle) return;
					if (f.extension !== "md" || !this.inScope(f)) return;
					const t = cache.frontmatter?.title;
					if (typeof t !== "string" || !sanitizeName(t)) return;
					if (sanitizeName(t) === f.basename) return;
					window.clearTimeout(this.renameTimers.get(f.path));
					this.renameTimers.set(
						f.path,
						window.setTimeout(() => {
							const latest =
								this.app.metadataCache.getFileCache(f)?.frontmatter?.title;
							if (typeof latest === "string")
								this.syncNameToTitle(f, latest);
						}, 2000)
					);
				})
			);
		});

		// Preview in browser
		this.addCommand({
			id: "preview-post",
			name: "Preview post / draft in browser",
			callback: () => {
				const f = this.activeMd();
				if (f) this.openPreview(f);
			},
		});

		// Image caption / expand commands (work without right-click)
		this.addCommand({
			id: "image-caption",
			name: "Edit caption of image at cursor",
			editorCallback: (editor) => {
				const loc = this.locateEmbed(editor, null);
				if (!loc) return void new Notice("Put the cursor on a line with an image.");
				this.editCaption(editor, loc);
			},
		});
		this.addCommand({
			id: "image-expand",
			name: "Toggle click-to-expand for image at cursor",
			editorCallback: (editor) => {
				const loc = this.locateEmbed(editor, null);
				if (!loc) return void new Notice("Put the cursor on a line with an image.");
				const on = this.toggleExpand(editor, loc);
				new Notice(on ? "Image will expand on click." : "Image won't expand on click.");
			},
		});

		for (const [id, name, key] of [
			["image-small", "Image at cursor: small size", "small"],
			["image-medium", "Image at cursor: medium size", "medium"],
			["image-original", "Image at cursor: original size", "original"],
		] as const) {
			this.addCommand({
				id,
				name,
				editorCallback: (editor) => {
					const loc = this.locateEmbed(editor, null);
					if (!loc) return void new Notice("Put the cursor on a line with an image.");
					const px =
						key === "small"
							? this.settings.sizeSmall
							: key === "medium"
							? this.settings.sizeMedium
							: 0;
					this.applyEmbed(editor, loc, { ...loc.parts, width: px ? String(px) : "" });
				},
			});
		}

		// Right-clicking an image: remember it so the menu can offer caption / expand
		this.registerDomEvent(
			document,
			"contextmenu",
			(evt: MouseEvent) => {
				const t = evt.target as HTMLElement | null;
				const embed = t?.closest?.(".cm-content .internal-embed.image-embed") as HTMLElement | null;
				if (!embed) {
					this.pendingImg = null;
					return;
				}
				const pending = { el: embed, x: evt.clientX, y: evt.clientY, consumed: false };
				this.pendingImg = pending;
				// If Obsidian's own menu doesn't pick it up, show a small menu of our own
				window.setTimeout(() => {
					if (this.pendingImg !== pending || pending.consumed) return;
					pending.consumed = true;
					const menu = new Menu();
					this.addImageMenuItems(menu, pending.el);
					menu.showAtPosition({ x: pending.x, y: pending.y });
				}, 80);
			},
			true
		);
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu) => this.consumeImageMenu(menu))
		);

		this.app.workspace.onLayoutReady(() => {
			this.refreshPreviewButtons();
			this.queueDecorate();
			this.registerEvent(
				this.app.workspace.on("layout-change", () => {
					this.refreshPreviewButtons();
					this.queueDecorate();
				})
			);
			this.registerEvent(
				this.app.workspace.on("file-open", () => this.refreshPreviewButtons())
			);
			this.registerEvent(
				this.app.metadataCache.on("changed", () => this.refreshPreviewButtons())
			);
			const obs = new MutationObserver(() => this.queueDecorate());
			obs.observe(this.app.workspace.containerEl, { childList: true, subtree: true });
			this.register(() => obs.disconnect());
		});

		this.patchAttachments();
	}

	/* ------------------------- preview in browser ------------------- */

	previewInfo(file: TFile): { url: string; published: boolean } | null {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm?.wp_id) return null;
		const published = fm.wp_status === "publish";
		const url =
			published && fm.wp_url
				? String(fm.wp_url)
				: `${this.base}/?p=${fm.wp_id}&preview=true`;
		return { url, published };
	}

	openPreview(file: TFile) {
		const info = this.previewInfo(file);
		if (!info) return void new Notice("Publish this note first, then you can preview it.");
		window.open(info.url);
	}

	/** Shows an eye button in each note's header once the note has been published. */
	refreshPreviewButtons() {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) continue;
			let el = this.previewActions.get(view);
			if (!el) {
				el = view.addAction("eye", "Preview on WordPress", () => {
					if (view.file) this.openPreview(view.file);
				});
				this.previewActions.set(view, el);
			}
			const info = view.file ? this.previewInfo(view.file) : null;
			el.style.display = info ? "" : "none";
			el.setAttr(
				"aria-label",
				info?.published ? "View post on WordPress" : "Preview draft on WordPress"
			);
		}
	}

	/* --------------------- image caption / expand ------------------- */

	private locateEmbed(
		editor: Editor,
		embedEl: HTMLElement | null
	): { line: number; from: number; to: number; text: string; parts: EmbedParts } | null {
		let line: number;
		let ch: number;
		if (embedEl) {
			const cm = (editor as unknown as { cm?: { posAtDOM(n: Node, o?: number): number } }).cm;
			if (!cm) return null;
			try {
				const pos = editor.offsetToPos(cm.posAtDOM(embedEl));
				line = pos.line;
				ch = pos.ch;
			} catch {
				return null;
			}
		} else {
			const c = editor.getCursor();
			line = c.line;
			ch = c.ch;
		}
		const text = editor.getLine(line);
		const src = (embedEl?.getAttribute("src") ?? "").split("#")[0].trim();
		const hits: { line: number; from: number; to: number; text: string; parts: EmbedParts }[] = [];
		for (const m of text.matchAll(/!\[\[([^\]]+)\]\]/g)) {
			const parts = parseEmbed(m[1]);
			const ext = (parts.target.split("#")[0].split(".").pop() ?? "").toLowerCase();
			if (!IMAGE_EXT.includes(ext)) continue;
			const from = m.index ?? 0;
			hits.push({ line, from, to: from + m[0].length, text: m[0], parts });
		}
		if (!hits.length) return null;
		return (
			hits.find((h) => ch >= h.from && ch <= h.to) ??
			hits.find((h) => src && h.parts.target.split("#")[0].trim() === src) ??
			hits[0]
		);
	}

	private applyEmbed(editor: Editor, loc: { line: number; from: number; to: number; text: string }, parts: EmbedParts) {
		if (editor.getLine(loc.line).slice(loc.from, loc.to) !== loc.text) {
			new Notice("The note changed in the meantime. Try again.");
			return;
		}
		editor.replaceRange(
			buildEmbed(parts),
			{ line: loc.line, ch: loc.from },
			{ line: loc.line, ch: loc.to }
		);
	}

	/** Flips click-to-expand for one image. Returns the new state. */
	toggleExpand(
		editor: Editor,
		loc: { line: number; from: number; to: number; text: string; parts: EmbedParts }
	): boolean {
		const def = this.settings.lightbox;
		const want = !(loc.parts.expand ?? def);
		this.applyEmbed(editor, loc, { ...loc.parts, expand: want === def ? null : want });
		return want;
	}

	editCaption(
		editor: Editor,
		loc: { line: number; from: number; to: number; text: string; parts: EmbedParts }
	) {
		new CaptionModal(this.app, loc.parts.caption, (caption) => {
			this.applyEmbed(editor, loc, { ...loc.parts, caption });
		}).open();
	}

	private viewForEl(el: HTMLElement): MarkdownView | null {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			if (leaf.view instanceof MarkdownView && leaf.view.containerEl.contains(el))
				return leaf.view;
		}
		return null;
	}

	private addImageMenuItems(menu: Menu, embedEl: HTMLElement) {
		const view = this.viewForEl(embedEl);
		if (!view) return;
		const editor = view.editor;
		const loc = this.locateEmbed(editor, embedEl);
		if (!loc) return;
		const on = loc.parts.expand ?? this.settings.lightbox;
		const cur = parseInt(loc.parts.width, 10) || 0;
		const sizes: [string, string, number][] = [
			["Small", "minimize-2", this.settings.sizeSmall],
			["Medium", "image", this.settings.sizeMedium],
		];
		menu.addSeparator();
		for (const [name, icon, px] of sizes) {
			menu.addItem((i) =>
				i
					.setTitle(`${name} (${px}px)`)
					.setIcon(icon)
					.setChecked(cur === px)
					.onClick(() => this.applyEmbed(editor, loc, { ...loc.parts, width: String(px) }))
			);
		}
		menu.addItem((i) =>
			i
				.setTitle("Original size")
				.setIcon("maximize")
				.setChecked(cur === 0)
				.onClick(() => this.applyEmbed(editor, loc, { ...loc.parts, width: "" }))
		);
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle(loc.parts.caption ? "Edit image caption…" : "Add image caption…")
				.setIcon("captions")
				.onClick(() => this.editCaption(editor, loc))
		);
		menu.addItem((i) =>
			i
				.setTitle("Expand on click (lightbox)")
				.setIcon("maximize-2")
				.setChecked(on)
				.onClick(() => this.toggleExpand(editor, loc))
		);
		menu.addSeparator();
	}

	private consumeImageMenu(menu: Menu) {
		const p = this.pendingImg;
		if (!p || p.consumed) return;
		p.consumed = true;
		this.addImageMenuItems(menu, p.el);
	}

	private queueDecorate() {
		if (this.decorateQueued) return;
		this.decorateQueued = true;
		requestAnimationFrame(() => {
			this.decorateQueued = false;
			try {
				this.decorateEmbeds();
			} catch (e) {
				console.error("Wordpresser: decorate failed", e);
			}
		});
	}

	/** Adds a small "Expand" checkbox and "Caption" button over images in the editor. */
	private decorateEmbeds() {
		this.app.workspace.containerEl
			.querySelectorAll<HTMLElement>(".cm-content .internal-embed.image-embed:not(.wpp-decorated)")
			.forEach((el) => {
				el.addClass("wpp-decorated");
				const bar = el.createDiv({ cls: "wpp-imgbar" });
				const label = bar.createEl("label", {
					cls: "wpp-imgchk",
					attr: { title: "Let this image expand on click when published" },
				});
				const box = label.createEl("input", { type: "checkbox" });
				label.createSpan({ text: "Expand" });
				const cap = bar.createEl("button", {
					cls: "wpp-imgcap",
					text: "Caption",
					attr: { title: "Add or edit this image's caption" },
				});

				for (const t of ["mousedown", "click", "dblclick"])
					bar.addEventListener(t, (e) => e.stopPropagation());

				const current = () => {
					const view = this.viewForEl(el);
					const loc = view ? this.locateEmbed(view.editor, el) : null;
					return { view, loc };
				};
				const refresh = () => {
					const { loc } = current();
					box.checked = loc ? (loc.parts.expand ?? this.settings.lightbox) : this.settings.lightbox;
				};
				refresh();
				el.addEventListener("mouseenter", refresh);
				el.addEventListener("touchstart", refresh, { passive: true });

				box.addEventListener("change", () => {
					const { view, loc } = current();
					if (!view || !loc) {
						box.checked = !box.checked;
						return;
					}
					this.toggleExpand(view.editor, loc);
				});
				cap.addEventListener("click", (e) => {
					e.preventDefault();
					const { view, loc } = current();
					if (view && loc) this.editCaption(view.editor, loc);
				});
			});
	}

	onunload() {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			if (leaf.view instanceof MarkdownView) this.previewActions.get(leaf.view)?.remove();
		}
		document.querySelectorAll(".wpp-imgbar").forEach((e) => e.remove());
		document
			.querySelectorAll(".wpp-decorated")
			.forEach((e) => e.classList.remove("wpp-decorated"));
		this.hideStyleEl?.remove();
		this.restoreFns.forEach((fn) => fn());
		this.restoreFns = [];
	}

	/* ------------------- post folders & attachments ----------------- */

	private inScope(f: TFile): boolean {
		const folder = this.settings.postsFolder.trim().replace(/^\/+|\/+$/g, "");
		return !folder || f.path.startsWith(folder + "/");
	}

	/** A "post note" lives in a folder with the same name as itself. */
	private isPostNote(f: TFile | null | undefined): f is TFile {
		return (
			!!f &&
			this.settings.perPostFolders &&
			f.extension === "md" &&
			this.inScope(f) &&
			!!f.parent &&
			!f.parent.isRoot() &&
			f.parent.name === f.basename
		);
	}

	/** Wrap a note in a folder of the same name. Returns true if moved. */
	async organizeNote(file: TFile): Promise<boolean> {
		const parent = file.parent;
		if (!parent) return false;
		if (!parent.isRoot() && parent.name === file.basename) return false;
		const base = parent.isRoot() ? "" : parent.path;
		let name = file.basename;
		let i = 1;
		while (this.app.vault.getAbstractFileByPath(joinPath(base, name)))
			name = `${file.basename} ${i++}`;
		const folderPath = joinPath(base, name);
		await this.app.vault.createFolder(folderPath);
		await this.app.fileManager.renameFile(file, joinPath(folderPath, name + ".md"));
		return true;
	}

	/** Rename a note (and, via the rename handler, its folder) to match a title. */
	async syncNameToTitle(file: TFile, title: string) {
		if (!this.settings.syncNameToTitle) return;
		const clean = sanitizeName(title);
		if (!clean || clean === file.basename) return;
		const dir = file.parent && !file.parent.isRoot() ? file.parent.path : "";
		const target = joinPath(dir, clean + ".md");
		if (this.app.vault.getAbstractFileByPath(target)) {
			new Notice(`Couldn't rename note: "${clean}" already exists.`);
			return;
		}
		// If the note sits in its own folder, make sure the folder name is free too
		if (this.isPostNote(file)) {
			const parentPath = file.parent!.parent?.path ?? "";
			if (this.app.vault.getAbstractFileByPath(joinPath(parentPath, clean))) {
				new Notice(`Couldn't rename folder: "${clean}" already exists.`);
				return;
			}
		}
		await this.app.fileManager.renameFile(file, target);
	}

	/** Make dropped/pasted attachments land in the note's own post folder. */
	private patchAttachments() {
		const unique = (dir: string, name: string, ext: string): string => {
			let p = joinPath(dir, ext ? `${name}.${ext}` : name);
			let i = 1;
			while (this.app.vault.getAbstractFileByPath(p))
				p = joinPath(dir, ext ? `${name} ${i++}.${ext}` : `${name} ${i++}`);
			return p;
		};
		// Same filename already in the post folder -> reuse it instead of "name 1.png"
		const reuseOrUnique = (dir: string, name: string, ext: string): string => {
			if (this.settings.reuseImages) {
				const p = joinPath(dir, ext ? `${name}.${ext}` : name);
				if (this.app.vault.getAbstractFileByPath(p) instanceof TFile) {
					this.reusePaths.add(p);
					return p;
				}
			}
			return unique(dir, name, ext);
		};
		const dirFor = (cur: TFile | null | undefined): string | null =>
			this.isPostNote(cur) ? cur.parent!.path : null;

		// Internal vault API (used by drag/drop & paste)
		const vault = this.app.vault as unknown as {
			getAvailablePathForAttachments?: (
				name: string,
				ext: string,
				cur: TFile | null
			) => Promise<string> | string;
		};
		if (typeof vault.getAvailablePathForAttachments === "function") {
			const orig = vault.getAvailablePathForAttachments.bind(vault);
			vault.getAvailablePathForAttachments = async (name, ext, cur) => {
				const dir = dirFor(cur);
				if (!dir) return await orig(name, ext, cur);
				return reuseOrUnique(dir, name, ext);
			};
			this.restoreFns.push(() => {
				vault.getAvailablePathForAttachments = orig;
			});
		}

		// If the file already exists and the bytes match, hand back the existing file
		const v = this.app.vault;
		const origCreate = v.createBinary.bind(v);
		v.createBinary = async (path: string, data: ArrayBuffer, opts?: DataWriteOptions) => {
			if (this.reusePaths.has(path)) {
				this.reusePaths.delete(path);
				const existing = v.getAbstractFileByPath(path);
				if (existing instanceof TFile) {
					const cur = new Uint8Array(await v.readBinary(existing));
					const neu = new Uint8Array(data);
					let same = cur.length === neu.length;
					for (let i = 0; same && i < cur.length; i++)
						if (cur[i] !== neu[i]) same = false;
					if (same) {
						new Notice(`Reused existing ${existing.name}`, 2500);
						return existing;
					}
					// Same name, different picture: keep both
					const slash = path.lastIndexOf("/");
					const dir = slash >= 0 ? path.slice(0, slash) : "";
					const file = path.slice(slash + 1);
					const dot = file.lastIndexOf(".");
					const name = dot > 0 ? file.slice(0, dot) : file;
					const ext = dot > 0 ? file.slice(dot + 1) : "";
					new Notice(`${existing.name} already exists with different content; saved as a new file.`, 4000);
					return origCreate(unique(dir, name, ext), data, opts);
				}
			}
			return origCreate(path, data, opts);
		};
		this.restoreFns.push(() => {
			v.createBinary = origCreate;
		});

		// Public API (newer Obsidian versions)
		const fm = this.app.fileManager as unknown as {
			getAvailablePathForAttachment?: (
				filename: string,
				sourcePath?: string
			) => Promise<string>;
		};
		if (typeof fm.getAvailablePathForAttachment === "function") {
			const orig = fm.getAvailablePathForAttachment.bind(fm);
			fm.getAvailablePathForAttachment = async (filename, sourcePath) => {
				const src = sourcePath
					? this.app.vault.getAbstractFileByPath(sourcePath)
					: null;
				const dir = src instanceof TFile ? dirFor(src) : null;
				if (!dir) return orig(filename, sourcePath);
				const dot = filename.lastIndexOf(".");
				const name = dot > 0 ? filename.slice(0, dot) : filename;
				const ext = dot > 0 ? filename.slice(dot + 1) : "";
				return reuseOrUnique(dir, name, ext);
			};
			this.restoreFns.push(() => {
				fm.getAvailablePathForAttachment = orig;
			});
		}
	}

	/* ------------------------- text alignment ----------------------- */

	private alignSelection(editor: Editor, align: "left" | "center" | "right") {
		const from = editor.getCursor("from");
		const to = editor.getCursor("to");
		let start = from.line;
		let end = to.line;
		if (end > start && to.ch === 0) end--;

		const openRe = /^<div style="text-align:(left|center|right|justify)">$/;
		const line = (n: number) => (n >= 0 && n <= editor.lastLine() ? editor.getLine(n) : "");

		let blockStart = start;
		let blockEnd = end;
		let innerStart = start;
		let innerEnd = end;
		let wrapped = false;

		if (openRe.test(line(start).trim()) && line(end).trim() === "</div>" && end - start >= 4) {
			// selection includes the wrapper itself
			innerStart = start + 2;
			innerEnd = end - 2;
			wrapped = true;
		} else if (
			openRe.test(line(start - 2).trim()) &&
			line(start - 1).trim() === "" &&
			line(end + 1).trim() === "" &&
			line(end + 2).trim() === "</div>"
		) {
			// selection is inside an existing wrapper
			blockStart = start - 2;
			blockEnd = end + 2;
			wrapped = true;
		}

		const inner: string[] = [];
		for (let n = innerStart; n <= innerEnd; n++) inner.push(line(n));
		const text = inner.join("\n");

		let replacement: string;
		if (align === "left") {
			if (!wrapped) {
				new Notice("This text isn't aligned yet.");
				return;
			}
			replacement = text;
		} else {
			replacement = `<div style="text-align:${align}">\n\n${text}\n\n</div>`;
		}
		editor.replaceRange(
			replacement,
			{ line: blockStart, ch: 0 },
			{ line: blockEnd, ch: line(blockEnd).length }
		);
	}

	/** Hides folders / images in the file explorer via CSS. */
	applyHideCss() {
		this.hideStyleEl?.remove();
		this.hideStyleEl = null;
		const q = (s: string) => s.replace(/"/g, '\\"');
		const rules: string[] = [];

		const f = this.settings.hideFolder.trim().replace(/^\/+|\/+$/g, "");
		if (f) {
			rules.push(
				`.nav-folder:has(> .nav-folder-title[data-path="${q(f)}"])`,
				`.nav-folder:has(> .nav-folder-title[data-path$="/${q(f)}"])`
			);
		}

		if (this.settings.hideImages) {
			const pf = this.settings.postsFolder.trim().replace(/^\/+|\/+$/g, "");
			const scope = pf ? `[data-path^="${q(pf)}/" i]` : "";
			for (const ext of IMAGE_EXT)
				rules.push(
					`.nav-file:has(> .nav-file-title[data-path$=".${ext}" i]${scope})`
				);
		}
		const css: string[] = [];
		if (rules.length) css.push(rules.join(",\n") + " { display: none; }");

		if (this.settings.sortNotesFirst) {
			// folders first (default), then notes, then every other file
			const md = '.nav-file:has(> .nav-file-title[data-path$=".md" i])';
			css.push(
				".nav-folder-children { display: flex; flex-direction: column; }",
				`.nav-folder-children > ${md} { order: 1; }`,
				`.nav-folder-children > .nav-file:not(:has(> .nav-file-title[data-path$=".md" i])) { order: 2; }`
			);
		}
		if (!css.length) return;

		const el = document.createElement("style");
		el.textContent = css.join("\n");
		document.head.appendChild(el);
		this.hideStyleEl = el;
	}

	async loadSettings() {
		const data = (await this.loadData()) as
			| (Partial<WPSettings> & { appPassword?: string })
			| null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

		// Move a plaintext password from an older data.json into secure storage
		const legacy = data?.appPassword;
		delete (this.settings as unknown as { appPassword?: string }).appPassword;
		if (legacy) {
			try {
				const id = this.settings.secretId || "wordpresser-app-password";
				this.app.secretStorage.setSecret(id, legacy);
				this.settings.secretId = id;
				await this.saveSettings(); // plaintext is no longer written
				new Notice(
					"Wordpresser: your application password was moved out of data.json into Obsidian's secure storage.",
					8000
				);
			} catch (e) {
				console.error("Wordpresser: couldn't migrate password", e);
			}
		}
	}

	getPassword(): string | null {
		return this.settings.secretId
			? this.app.secretStorage.getSecret(this.settings.secretId)
			: null;
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/* -------------------------- commands --------------------------- */

	private activeMd(): TFile | null {
		const f = this.app.workspace.getActiveFile();
		if (!f || f.extension !== "md") {
			new Notice("Open a markdown note first.");
			return null;
		}
		return f;
	}

	private async cmdAddProperties() {
		const f = this.activeMd();
		if (!f) return;
		await this.addProperties(f, true);
		new Notice("WordPress properties added.");
	}

	async addProperties(file: TFile, fillTitle = false) {
		await this.app.fileManager.processFrontMatter(file, (fm) => {
			for (const [k, v] of Object.entries(templateProps(this.settings.tagsProperty))) {
				if (!(k in fm)) fm[k] = Array.isArray(v) ? [] : v;
			}
			if (fillTitle && !fm.title) fm.title = file.basename;
		});
	}

	/** Reads the note's properties from the file itself (the metadata cache can lag behind edits). */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private async readFrontmatter(file: TFile): Promise<Record<string, any>> {
		try {
			const raw = await this.app.vault.read(file);
			const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
			if (m) {
				const parsed = parseYaml(m[1]);
				if (parsed && typeof parsed === "object") return parsed;
			}
		} catch (e) {
			console.error("Wordpresser: couldn't read properties from file", e);
		}
		return { ...(this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) };
	}

	private async cmdPublish() {
		const f = this.activeMd();
		if (!f) return;
		const s = this.settings;
		if (!s.siteUrl || !s.username || !this.getPassword()) {
			new Notice(
				"Wordpresser: fill in site URL, username and application password in settings first."
			);
			return;
		}
		// Make sure anything just typed (e.g. in the Properties panel) is saved first
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view?.file === f) {
			try {
				await view.save();
			} catch {
				/* ignore */
			}
		}
		const fm = await this.readFrontmatter(f);
		const existingId = fm.wp_id ? Number(fm.wp_id) : null;
		const title = typeof fm.title === "string" || typeof fm.title === "number" ? String(fm.title).trim() : "";
		const initial: PublishState = {
			title: title || f.basename,
			status:
				fm.wp_status === "publish" || fm.wp_status === "draft"
					? fm.wp_status
					: s.defaultStatus,
			categories: toList(fm.categories),
			tags: toList(fm[s.tagsProperty]),
			featuredRaw: String(fm.featured_image ?? "").trim(),
			featuredFile: null,
			removeFeatured: false,
		};
		new PublishModal(this.app, this, f, initial, existingId).open();
	}

	/* ------------------------- WordPress API ----------------------- */

	get base(): string {
		return this.settings.siteUrl.trim().replace(/\/+$/, "");
	}

	private authHeader(): string {
		const pw = (this.getPassword() ?? "").replace(/\s+/g, "");
		if (!pw)
			throw new Error(
				"No application password selected. Open Wordpresser settings and choose or create one."
			);
		return "Basic " + btoa(`${this.settings.username.trim()}:${pw}`);
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async wp(method: string, path: string, body?: unknown): Promise<any> {
		const res = await requestUrl({
			url: `${this.base}/wp-json/wp/v2/${path}`,
			method,
			headers: {
				Authorization: this.authHeader(),
				...(body ? { "Content-Type": "application/json" } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
			throw: false,
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		let data: any = null;
		try {
			data = res.json;
		} catch {
			/* not json */
		}
		if (res.status >= 400) {
			throw new Error(
				`WordPress ${res.status}: ${
					data?.message ?? res.text.slice(0, 200)
				}`
			);
		}
		return data;
	}

	/** All existing categories or tags on the site, for the suggestion dropdowns. */
	async listTerms(taxonomy: "categories" | "tags"): Promise<TermInfo[]> {
		const names: TermInfo[] = [];
		try {
			for (let page = 1; page <= 10; page++) {
				const batch = (await this.wp(
					"GET",
					`${taxonomy}?per_page=100&page=${page}&orderby=name&order=asc&_fields=id,name,count`
				)) as { name: string; count: number }[];
				names.push(
					...batch.map((t) => ({
						name: decodeEntities(t.name),
						count: t.count ?? 0,
					}))
				);
				if (batch.length < 100) break;
			}
		} catch (e) {
			console.error("Wordpresser: couldn't load " + taxonomy, e);
		}
		return names;
	}

	private async resolveTerms(
		taxonomy: "categories" | "tags",
		names: string[]
	): Promise<number[]> {
		const ids: number[] = [];
		for (const name of names) {
			const found = await this.wp(
				"GET",
				`${taxonomy}?search=${encodeURIComponent(name)}&per_page=100`
			);
			const match = (found as { id: number; name: string }[]).find(
				(t) =>
					decodeEntities(t.name).toLowerCase() === name.toLowerCase()
			);
			if (match) {
				ids.push(match.id);
			} else {
				const created = await this.wp("POST", taxonomy, { name });
				ids.push(created.id);
			}
		}
		return ids;
	}

	private async uploadBinary(
		data: ArrayBuffer,
		filename: string,
		mime: string
	): Promise<{ id: number; url: string }> {
		const safe = filename.replace(/[^\w.\-]/g, "_");
		const res = await requestUrl({
			url: `${this.base}/wp-json/wp/v2/media`,
			method: "POST",
			headers: {
				Authorization: this.authHeader(),
				"Content-Type": mime,
				"Content-Disposition": `attachment; filename="${safe}"`,
			},
			body: data,
			throw: false,
		});
		if (res.status >= 400) {
			let msg = res.text.slice(0, 200);
			try {
				msg = res.json?.message ?? msg;
			} catch {
				/* ignore */
			}
			throw new Error(`Upload of ${filename} failed (${res.status}): ${msg}`);
		}
		return { id: res.json.id, url: res.json.source_url };
	}

	private async sha256(data: ArrayBuffer): Promise<string> {
		const buf = await crypto.subtle.digest("SHA-256", data);
		return Array.from(new Uint8Array(buf))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
	}

	/** Look for media already on the site with this filename (and size, when known). */
	private async findExistingMedia(
		filename: string,
		size: number
	): Promise<{ id: number; url: string } | null> {
		try {
			const safe = filename.replace(/[^\w.\-]/g, "_").toLowerCase();
			const stem = filename
				.replace(/\.[^.]+$/, "")
				.replace(/[_\-.]+/g, " ")
				.trim();
			if (!stem) return null;
			const res = (await this.wp(
				"GET",
				`media?search=${encodeURIComponent(stem)}&per_page=100&media_type=image&_fields=id,source_url,media_details`
			)) as {
				id: number;
				source_url: string;
				media_details?: { filesize?: number };
			}[];
			for (const m of res) {
				let name = (m.source_url || "").split("/").pop() ?? "";
				try {
					name = decodeURIComponent(name);
				} catch {
					/* keep raw */
				}
				if (name.toLowerCase() !== safe) continue;
				const remoteSize = m.media_details?.filesize;
				if (typeof remoteSize === "number" && remoteSize !== size) continue;
				return { id: m.id, url: m.source_url };
			}
		} catch (e) {
			console.error("Wordpresser: media lookup failed", e);
		}
		return null;
	}

	/** Upload an image, unless an identical one is already in the media library. */
	private async ensureMedia(
		data: ArrayBuffer,
		filename: string,
		mime: string
	): Promise<{ id: number; url: string }> {
		if (!this.settings.reuseImages)
			return this.uploadBinary(data, filename, mime);

		const hkey = `${this.base}|${await this.sha256(data)}`;
		const hit = this.settings.hashCache[hkey];
		if (hit) {
			try {
				// make sure it still exists on the site
				const m = await this.wp("GET", `media/${hit.id}?_fields=id,source_url`);
				return { id: m.id, url: m.source_url };
			} catch {
				delete this.settings.hashCache[hkey];
			}
		}

		const found = await this.findExistingMedia(filename, data.byteLength);
		const media = found ?? (await this.uploadBinary(data, filename, mime));
		this.settings.hashCache[hkey] = media;
		await this.saveSettings();
		return media;
	}

	private async uploadVaultFile(
		file: TFile
	): Promise<{ id: number; url: string }> {
		const key = `${this.base}|${file.path}`;
		const cached = this.settings.mediaCache[key];
		if (cached && cached.mtime === file.stat.mtime) return cached;

		const data = await this.app.vault.readBinary(file);
		const mime = MIME[file.extension.toLowerCase()] ?? "application/octet-stream";
		const media = await this.ensureMedia(data, file.name, mime);
		this.settings.mediaCache[key] = { mtime: file.stat.mtime, ...media };
		await this.saveSettings();
		return media;
	}

	/* ------------------------ content pipeline --------------------- */

	/** Classic HTML for one image (with caption if it has one). Single line. */
	private unitHtml(u: ImgUnit): string {
		const img = `<img src="${u.url}" alt="${esc(u.alt)}"${
			u.width ? ` width="${u.width}"` : ""
		} style="max-width:100%;height:auto;min-width:0">`;
		if (!u.caption) return img;
		return (
			`<figure class="wp-block-image" style="margin:0;min-width:0;max-width:100%;display:inline-block;text-align:center">` +
			img +
			`<figcaption class="wp-element-caption" style="margin-top:.5em;font-size:.875em;opacity:.75">${esc(u.caption)}</figcaption>` +
			`</figure>`
		);
	}

	/** WordPress image block (supports "expand on click" lightbox, WP 6.4+). */
	private unitBlock(u: ImgUnit, align: string | null, inRow = false): string {
		const attrs: Record<string, unknown> = {};
		if (align === "center" || align === "right") attrs.align = align;
		if (u.id) attrs.id = u.id;
		if (u.width) attrs.width = `${u.width}px`;
		attrs.sizeSlug = "full";
		attrs.linkDestination = "none";
		attrs.lightbox = { enabled: true };

		const cls = ["wp-block-image"];
		if (align === "center") cls.push("aligncenter");
		if (align === "right") cls.push("alignright");
		cls.push("size-full");
		if (u.width) cls.push("is-resized");

		const img = `<img src="${u.url}" alt="${esc(u.alt)}" class="${
			u.id ? `wp-image-${u.id}` : ""
		}"${u.width ? ` style="width:${u.width}px"` : ""}/>`;
		const cap = u.caption
			? `<figcaption class="wp-element-caption">${esc(u.caption)}</figcaption>`
			: "";
		return (
			`<!-- wp:image ${JSON.stringify(attrs)} -->\n` +
			`<figure class="${cls.join(" ")}"${
				inRow ? ' style="margin:0;min-width:0"' : ""
			}>${img}${cap}</figure>\n` +
			`<!-- /wp:image -->`
		);
	}

	/**
	 * Turns image placeholders into final HTML. A line containing only images
	 * becomes one row (several images sit side by side). Alignment follows an
	 * enclosing alignment <div>, else the "center images" setting.
	 */
	private finalizeImages(md: string): string {
		const tokenRe = /@@WPPIMG:(\d+)@@/g;
		const onlyTokens = /^\s*(?:@@WPPIMG:\d+@@\s*)+$/;
		const unitOf = (i: string) => this.imgUnits[Number(i)];

		let align: string | null = null;
		const out: string[] = [];
		for (const line of md.split("\n")) {
			const open = line.match(/^<div style="text-align:(left|center|right|justify)">\s*$/);
			if (open) align = open[1];
			else if (/^<\/div>\s*$/.test(line)) align = null;

			if (onlyTokens.test(line)) {
				const units = [...line.matchAll(tokenRe)].map((m) => unitOf(m[1]));
				const a = align ?? (this.settings.centerImages ? "center" : "left");

				const j = a === "right" ? "flex-end" : a === "center" ? "center" : "flex-start";
				const row = (inner: string) =>
					`\n<div style="display:flex;justify-content:${j};align-items:flex-start;gap:8px;margin:1em 0">\n${inner}\n</div>\n`;

				if (units.length === 1 && units[0].expand) {
					out.push("\n" + this.unitBlock(units[0], a) + "\n");
				} else {
					out.push(
						row(
							units
								.map((u) => (u.expand ? this.unitBlock(u, null, true) : this.unitHtml(u)))
								.join("\n")
						)
					);
				}
			} else {
				out.push(line.replace(tokenRe, (_m, i: string) => this.unitHtml(unitOf(i))));
			}
		}
		return out.join("\n");
	}

	private isExternal(href: string): boolean {
		try {
			const u = new URL(href);
			if (!/^https?:$/.test(u.protocol)) return false;
			return u.host !== new URL(this.base).host;
		} catch {
			return false;
		}
	}

	private addUnit(u: ImgUnit): string {
		this.imgUnits.push(u);
		return `@@WPPIMG:${this.imgUnits.length - 1}@@`;
	}

	private async processImages(md: string, sourcePath: string): Promise<string> {
		// ![[image.png]] / ![[image.png|caption]] / ![[image.png|300]] / ![[image.png|caption|300]]
		md = await replaceAsync(
			md,
			/!\[\[([^\]]+)\]\]/g,
			async (_m, inner) => {
				const parts = parseEmbed(inner);
				const link = parts.target.split("#")[0].trim();
				const file = this.app.metadataCache.getFirstLinkpathDest(
					link,
					sourcePath
				);
				if (!file || !IMAGE_EXT.includes(file.extension.toLowerCase())) {
					if (!file) this.warnings.push(`Embed not found: ${link}`);
					return ""; // non-image embeds (notes, pdfs) are dropped
				}
				const media = await this.uploadVaultFile(file);
				return this.addUnit({
					id: media.id,
					url: media.url,
					alt: parts.caption || file.basename,
					caption: this.settings.captionsFromAlt ? parts.caption : "",
					width: parts.width.split("x")[0],
					expand: parts.expand ?? this.settings.lightbox,
				});
			}
		);

		// ![caption](local/path.png)
		md = await replaceAsync(
			md,
			/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
			async (m, alt, src) => {
				if (/^(https?:|data:)/i.test(src)) return m;
				let p = src;
				try {
					p = decodeURIComponent(src);
				} catch {
					/* keep raw */
				}
				const file = this.app.metadataCache.getFirstLinkpathDest(
					p,
					sourcePath
				);
				if (!file) {
					this.warnings.push(`Image not found: ${p}`);
					return m;
				}
				const media = await this.uploadVaultFile(file);
				return this.addUnit({
					id: media.id,
					url: media.url,
					alt: alt || file.basename,
					caption: this.settings.captionsFromAlt ? alt : "",
					width: "",
					expand: this.settings.lightbox,
				});
			}
		);
		return md;
	}

	private obsidianToMarkdown(md: string): string {
		return (
			md
				// comments
				.replace(/%%[\s\S]*?%%/g, "")
				// callouts -> blockquote with bold title
				.replace(
					/^>\s*\[!(\w+)\][+-]?[ \t]*(.*)$/gm,
					(_m, type: string, title: string) =>
						`> **${
							title.trim() ||
							type.charAt(0).toUpperCase() + type.slice(1)
						}**\n>`
				)
				// wikilinks -> plain text (alias if present)
				.replace(/\[\[([^\]]+)\]\]/g, (_m, inner: string) => {
					const [target, alias] = inner.split("|");
					return alias ?? target.split("#")[0].split("/").pop() ?? target;
				})
				// highlights
				.replace(/==([^=\n]+)==/g, "<mark>$1</mark>")
		);
	}

	private async resolveFeatured(
		value: unknown,
		sourcePath: string
	): Promise<number | null> {
		const str = String(value ?? "").trim();
		if (!str) return null;
		if (/^\d+$/.test(str)) return Number(str);

		if (/^https?:\/\//i.test(str)) {
			const res = await requestUrl({ url: str, throw: false });
			if (res.status >= 400)
				throw new Error(`Couldn't download featured image (${res.status})`);
			const name = decodeURIComponent(
				str.split("?")[0].split("/").pop() || "featured.jpg"
			);
			const ext = name.split(".").pop()?.toLowerCase() ?? "jpg";
			const media = await this.ensureMedia(
				res.arrayBuffer,
				name,
				MIME[ext] ?? "image/jpeg"
			);
			return media.id;
		}

		const wiki = str.match(/^!?\[\[([^\]|#]+)/);
		const link = (wiki ? wiki[1] : str).trim();
		const file = this.app.metadataCache.getFirstLinkpathDest(link, sourcePath);
		if (!file) {
			this.warnings.push(`Featured image not found: ${link}`);
			return null;
		}
		return (await this.uploadVaultFile(file)).id;
	}

	/* --------------------------- publish --------------------------- */

	async publish(file: TFile, state: PublishState): Promise<PublishResult> {
		this.warnings = [];
		this.imgUnits = [];
		const progress = new Notice("Publishing to WordPress…", 0);
		try {
			const fm = await this.readFrontmatter(file);

			// Save the modal values back into the note
			await this.app.fileManager.processFrontMatter(file, (f) => {
				f.title = state.title;
				f.categories = state.categories;
				f[this.settings.tagsProperty] = state.tags;
			});

			const raw = await this.app.vault.read(file);
			let body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

			progress.setMessage("Uploading images…");
			body = await this.processImages(body, file.path);
			body = this.obsidianToMarkdown(body);
			body = this.finalizeImages(body);

			const renderer = new Renderer();
			const baseLink = renderer.link.bind(renderer);
			renderer.link = (href: string, title: string | null, text: string) => {
				const html = baseLink(href, title, text);
				if (this.settings.externalLinksNewTab && this.isExternal(href)) {
					return html.replace(
						/^<a /,
						'<a target="_blank" rel="noopener noreferrer" '
					);
				}
				return html;
			};
			const html = marked.parse(body, {
				gfm: true,
				async: false,
				renderer,
			}) as string;

			progress.setMessage("Syncing categories & tags…");
			const categories = await this.resolveTerms("categories", state.categories);
			const tags = await this.resolveTerms("tags", state.tags);

			// Featured image
			let featuredId: number | null = null;
			let featuredUrl: string | null = null;
			let clearFeatured = false;
			if (state.featuredFile) {
				progress.setMessage("Uploading featured image…");
				const f = state.featuredFile;
				const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
				const media = await this.ensureMedia(
					await f.arrayBuffer(),
					f.name,
					f.type || MIME[ext] || "image/jpeg"
				);
				featuredId = media.id;
				featuredUrl = media.url;
			} else if (state.removeFeatured) {
				clearFeatured = true;
			} else {
				const rawFeat = String(fm.featured_image ?? "").trim();
				if (rawFeat && fm.wp_featured_id && rawFeat.startsWith(this.base)) {
					featuredId = Number(fm.wp_featured_id);
				} else if (rawFeat) {
					featuredId = await this.resolveFeatured(rawFeat, file.path);
				}
			}

			const payload: Record<string, unknown> = {
				title: state.title,
				content: html,
				status: state.status,
				categories,
				tags,
			};
			if (fm.excerpt) payload.excerpt = String(fm.excerpt);
			if (fm.slug) payload.slug = String(fm.slug);
			if (featuredId) payload.featured_media = featuredId;
			else if (clearFeatured) payload.featured_media = 0;

			progress.setMessage("Sending post…");
			const existingId = fm.wp_id ? Number(fm.wp_id) : null;
			const post = existingId
				? await this.wp("POST", `posts/${existingId}`, payload)
				: await this.wp("POST", "posts", payload);

			await this.app.fileManager.processFrontMatter(file, (f) => {
				f.wp_id = post.id;
				f.wp_url = post.link;
				f.wp_status = post.status;
				if (!f.slug && post.slug) f.slug = post.slug;
				if (featuredUrl) {
					f.featured_image = featuredUrl;
					f.wp_featured_id = featuredId;
				} else if (clearFeatured) {
					f.featured_image = "";
					delete f.wp_featured_id;
				} else if (featuredId !== null) {
					f.wp_featured_id = featuredId;
				}
			});

			// Keep the note (and its folder) named after the title
			try {
				await this.syncNameToTitle(file, state.title);
			} catch (e) {
				console.error("Wordpresser rename failed", e);
			}

			progress.hide();
			return {
				post,
				warnings: [...this.warnings],
				updated: existingId !== null,
			};
		} catch (e) {
			progress.hide();
			console.error(e);
			new Notice(`Wordpresser error: ${(e as Error).message}`, 10000);
			throw e;
		}
	}
}

/* ------------------------------------------------------------------ */
/* Chip input with suggestions (categories / tags)                     */
/* ------------------------------------------------------------------ */

class ChipInput {
	private chips: string[];
	private options: string[] = [];
	private counts = new Map<string, number>();
	private wrap: HTMLElement;
	private input: HTMLInputElement;
	private listEl: HTMLElement;
	private items: { value: string; isNew: boolean; count?: number }[] = [];
	private active = -1;

	constructor(parent: HTMLElement, initial: string[], placeholder: string) {
		this.chips = [...initial];
		this.wrap = parent.createDiv({ cls: "wpp-chipbox" });
		this.input = this.wrap.createEl("input", {
			type: "text",
			cls: "wpp-chip-input",
			placeholder,
		});
		this.listEl = parent.createDiv({ cls: "wpp-suggest" });
		this.listEl.hide();

		this.wrap.addEventListener("click", () => {
			this.input.focus();
			this.refresh();
		});
		this.input.addEventListener("input", () => this.refresh());
		this.input.addEventListener("focus", () => this.refresh());
		this.input.addEventListener("blur", () =>
			setTimeout(() => this.listEl.hide(), 120)
		);
		this.input.addEventListener("keydown", (e) => this.onKey(e));
		this.listEl.addEventListener("mousedown", (e) => e.preventDefault());

		this.renderChips();
	}

	setOptions(terms: TermInfo[]) {
		this.options = terms.map((t) => t.name);
		this.counts = new Map(terms.map((t) => [t.name.toLowerCase(), t.count]));
		this.renderChips();
		if (document.activeElement === this.input) this.refresh();
	}

	getValues(): string[] {
		const out = [...this.chips];
		const pending = this.canon(this.input.value);
		if (pending && !out.some((c) => c.toLowerCase() === pending.toLowerCase()))
			out.push(pending);
		return out;
	}

	private canon(raw: string): string {
		const v = raw.trim().replace(/^#/, "");
		const hit = this.options.find((o) => o.toLowerCase() === v.toLowerCase());
		return hit ?? v;
	}

	private add(raw: string) {
		const v = this.canon(raw);
		if (!v) return;
		if (!this.chips.some((c) => c.toLowerCase() === v.toLowerCase()))
			this.chips.push(v);
		this.input.value = "";
		this.active = -1;
		this.renderChips();
		this.listEl.hide(); // collapse; reopens on click or typing
	}

	private remove(i: number) {
		this.chips.splice(i, 1);
		this.renderChips();
		this.listEl.hide();
	}

	private renderChips() {
		this.wrap.querySelectorAll(".wpp-chip").forEach((el) => el.remove());
		this.chips.forEach((name, i) => {
			const isNew = !this.options.some(
				(o) => o.toLowerCase() === name.toLowerCase()
			);
			const chip = this.wrap.createSpan({
				cls: "wpp-chip" + (isNew && this.options.length ? " wpp-chip-new" : ""),
			});
			if (isNew && this.options.length) chip.createSpan({ text: "+ " });
			chip.createSpan({ text: name });
			const x = chip.createSpan({ cls: "wpp-chip-x", text: "×" });
			x.addEventListener("mousedown", (e) => {
				e.preventDefault();
				this.remove(i);
			});
			this.wrap.insertBefore(chip, this.input);
		});
	}

	private refresh() {
		const raw = this.input.value.trim();
		const q = raw.toLowerCase();
		const chosen = new Set(this.chips.map((c) => c.toLowerCase()));

		const matches = this.options
			.filter(
				(o) =>
					!chosen.has(o.toLowerCase()) &&
					(!q || o.toLowerCase().includes(q))
			)
			.sort(
				(a, b) =>
					Number(b.toLowerCase().startsWith(q)) -
						Number(a.toLowerCase().startsWith(q)) || a.localeCompare(b)
			);
		this.items = matches.map((value) => ({
			value,
			isNew: false,
			count: this.counts.get(value.toLowerCase()) ?? 0,
		}));

		const exists =
			this.options.some((o) => o.toLowerCase() === q) || chosen.has(q);
		if (q && !exists) this.items.push({ value: raw, isNew: true });

		this.active = -1;
		this.listEl.empty();
		this.items.forEach((it, i) => {
			const row = this.listEl.createDiv({ cls: "wpp-opt" });
			if (it.isNew) {
				row.createSpan({ cls: "wpp-plus", text: "+" });
				row.createSpan({ text: ` Create "${it.value}"` });
			} else {
				row.createSpan({ text: it.value });
				row.createSpan({ cls: "wpp-count", text: `(${it.count ?? 0})` });
			}
			row.addEventListener("mousedown", (e) => {
				e.preventDefault();
				this.add(it.value);
				this.input.focus();
			});
			row.addEventListener("mouseenter", () => {
				this.active = i;
				this.highlight();
			});
		});
		if (this.items.length) this.listEl.show();
		else this.listEl.hide();
	}

	private highlight() {
		Array.from(this.listEl.children).forEach((el, i) => {
			el.toggleClass("is-active", i === this.active);
			if (i === this.active) (el as HTMLElement).scrollIntoView({ block: "nearest" });
		});
	}

	private move(d: number) {
		if (!this.items.length) return;
		if (this.active === -1) this.active = d > 0 ? 0 : this.items.length - 1;
		else this.active = (this.active + d + this.items.length) % this.items.length;
		this.highlight();
	}

	private onKey(e: KeyboardEvent) {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			this.listEl.show();
			this.move(1);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			this.move(-1);
		} else if (e.key === "Enter") {
			e.preventDefault();
			if (this.active >= 0 && this.items[this.active])
				this.add(this.items[this.active].value);
			else if (this.input.value.trim()) this.add(this.input.value);
		} else if (e.key === ",") {
			e.preventDefault();
			if (this.input.value.trim()) this.add(this.input.value);
		} else if (e.key === "Backspace" && !this.input.value && this.chips.length) {
			this.remove(this.chips.length - 1);
		}
	}
}

/* ------------------------------------------------------------------ */
/* Caption modal                                                       */
/* ------------------------------------------------------------------ */

class CaptionModal extends Modal {
	private value: string;

	constructor(
		app: App,
		initial: string,
		private onSave: (caption: string) => void
	) {
		super(app);
		this.value = initial;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("wpp-modal");
		this.titleEl.setText("Image caption");
		contentEl.createDiv({
			cls: "wpp-status-note",
			text: "Shown under the image on WordPress. Leave empty for no caption.",
		});

		let input: HTMLInputElement | null = null;
		new Setting(contentEl)
			.addText((t) => {
				input = t.inputEl;
				t.setPlaceholder("Caption").setValue(this.value).onChange((v) => (this.value = v));
				t.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						this.save();
					}
				});
			})
			.settingEl.addClass("wpp-wide");

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("Save").setCta().onClick(() => this.save()));

		window.setTimeout(() => (input as HTMLInputElement | null)?.focus(), 30);
	}

	private save() {
		// keep the caption safe inside ![[file|caption]]
		const clean = this.value.replace(/\|/g, "/").replace(/[\[\]]/g, "").trim();
		this.onSave(clean);
		this.close();
	}

	onClose() {
		this.contentEl.empty();
	}
}

/* ------------------------------------------------------------------ */
/* Publish modal                                                       */
/* ------------------------------------------------------------------ */

class PublishModal extends Modal {
	private state: PublishState;
	private busy = false;
	private actionBtn: HTMLButtonElement | null = null;
	private previewEl!: HTMLElement;
	private objUrl: string | null = null;
	private catInput!: ChipInput;
	private tagInput!: ChipInput;

	constructor(
		app: App,
		private plugin: WPPublisherPlugin,
		private file: TFile,
		initial: PublishState,
		private existingId: number | null
	) {
		super(app);
		this.state = { ...initial };
	}

	private label(): string {
		const updating = this.existingId !== null;
		if (this.state.status === "draft")
			return updating ? "Update draft" : "Save as draft";
		return updating ? "Update post" : "Publish";
	}

	private renderPreview() {
		const el = this.previewEl;
		el.empty();
		const s = this.state;
		const src =
			this.objUrl ?? (/^https?:\/\//i.test(s.featuredRaw) ? s.featuredRaw : null);

		if (src && !s.removeFeatured) {
			const box = el.createDiv({ cls: "wpp-imgbox" });
			box.createEl("img", { attr: { src } });
			box.createDiv({ cls: "wpp-imgover", text: "Change Image…" });
			box.addEventListener("click", () => this.pickFile());
			el.createDiv({
				cls: "wpp-status-note",
				text: s.featuredFile ? `New: ${s.featuredFile.name}` : "Current featured image",
			});
		} else if (s.featuredRaw && !s.removeFeatured) {
			el.createDiv({ cls: "wpp-status-note", text: `Using: ${s.featuredRaw}` });
			const box = el.createDiv({ cls: "wpp-imgbox wpp-imgempty" });
			box.createDiv({ cls: "wpp-imgover wpp-always", text: "Change Image…" });
			box.addEventListener("click", () => this.pickFile());
		} else {
			const box = el.createDiv({ cls: "wpp-imgbox wpp-imgempty" });
			box.createDiv({
				cls: "wpp-imgover wpp-always",
				text: s.removeFeatured ? "Removed — click to choose one…" : "Choose image…",
			});
			box.addEventListener("click", () => this.pickFile());
		}
	}

	private pickFile() {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "image/*";
		input.onchange = () => {
			const f = input.files?.[0];
			if (!f) return;
			if (this.objUrl) URL.revokeObjectURL(this.objUrl);
			this.objUrl = URL.createObjectURL(f);
			this.state.featuredFile = f;
			this.state.removeFeatured = false;
			this.renderPreview();
		};
		input.click();
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("wpp-modal");
		this.titleEl.setText(
			this.existingId ? "Update on WordPress" : "Publish to WordPress"
		);

		if (this.existingId) {
			contentEl.createDiv({
				cls: "wpp-status-note",
				text: `Linked to WordPress post #${this.existingId}. Publishing will update it.`,
			});
		}

		new Setting(contentEl)
			.setName("Title")
			.addText((t) => {
				t.setValue(this.state.title).onChange(
					(v) => (this.state.title = v)
				);
			})
			.settingEl.addClass("wpp-wide");

		new Setting(contentEl)
			.setName("Featured image")
			.setDesc("Pick a file from your computer. It's uploaded to your WordPress media library.")
			.addButton((b) =>
				b.setButtonText("Browse…").onClick(() => this.pickFile())
			)
			.addButton((b) =>
				b.setButtonText("Remove").onClick(() => {
					if (this.objUrl) URL.revokeObjectURL(this.objUrl);
					this.objUrl = null;
					this.state.featuredFile = null;
					this.state.removeFeatured = true;
					this.renderPreview();
				})
			);
		this.previewEl = contentEl.createDiv({ cls: "wpp-preview" });
		this.renderPreview();

		const catSetting = new Setting(contentEl)
			.setName("Categories")
			.setDesc("Pick existing ones or type a new one and press Enter.");
		catSetting.settingEl.addClass("wpp-wide");
		catSetting.controlEl.addClass("wpp-rel");
		this.catInput = new ChipInput(
			catSetting.controlEl,
			this.state.categories,
			"Add category…"
		);

		const tagSetting = new Setting(contentEl)
			.setName("Tags")
			.setDesc("Pick existing ones or type a new one and press Enter.");
		tagSetting.settingEl.addClass("wpp-wide");
		tagSetting.controlEl.addClass("wpp-rel");
		this.tagInput = new ChipInput(
			tagSetting.controlEl,
			this.state.tags,
			"Add tag…"
		);

		// Load existing terms in the background
		this.plugin.listTerms("categories").then((o) => this.catInput?.setOptions(o));
		this.plugin.listTerms("tags").then((o) => this.tagInput?.setOptions(o));

		new Setting(contentEl).setName("Status").addDropdown((d) => {
			d.addOption("draft", "Draft")
				.addOption("publish", "Publish")
				.setValue(this.state.status)
				.onChange((v) => {
					this.state.status = v as "draft" | "publish";
					this.actionBtn?.setText(this.label());
				});
		});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				b.setButtonText(this.label())
					.setCta()
					.onClick(async () => {
						if (this.busy) return;
						if (!this.state.title.trim()) {
							new Notice("Title can't be empty.");
							return;
						}
						this.state.categories = this.catInput.getValues();
						this.state.tags = this.tagInput.getValues();
						this.busy = true;
						b.setDisabled(true);
						b.setButtonText("Working…");
						try {
							const res = await this.plugin.publish(this.file, this.state);
							this.showResult(res);
						} catch {
							this.busy = false;
							b.setDisabled(false);
							b.setButtonText(this.label());
						}
					});
				this.actionBtn = b.buttonEl;
			});
	}

	private showResult(res: PublishResult) {
		const { contentEl } = this;
		const published = res.post.status === "publish";
		contentEl.empty();
		this.actionBtn = null;
		this.titleEl.setText(
			published
				? res.updated ? "Post updated ✓" : "Post published ✓"
				: res.updated ? "Draft updated ✓" : "Draft saved ✓"
		);

		const url = published
			? res.post.link
			: `${this.plugin.base}/?p=${res.post.id}&preview=true`;

		contentEl.createDiv({ cls: "wpp-result-title", text: this.state.title });
		const row = contentEl.createDiv({ cls: "wpp-result" });
		const a = row.createEl("a", {
			text: published ? "View post →" : "Preview draft →",
			href: url,
		});
		a.setAttr("target", "_blank");
		a.setAttr("rel", "noopener");
		if (!published) {
			contentEl.createDiv({
				cls: "wpp-status-note",
				text: "Draft previews require being logged in to WordPress in your browser.",
			});
		}
		if (res.warnings.length) {
			const w = contentEl.createDiv({ cls: "wpp-warnings" });
			w.createDiv({ text: "Heads up:" });
			res.warnings.forEach((t) => w.createDiv({ text: "• " + t }));
		}

		new Setting(contentEl).addButton((b) =>
			b.setButtonText("Close").onClick(() => this.close())
		);
	}

	onClose() {
		if (this.objUrl) URL.revokeObjectURL(this.objUrl);
		this.contentEl.empty();
	}
}

/* ------------------------------------------------------------------ */
/* Settings tab                                                        */
/* ------------------------------------------------------------------ */

class WPSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: WPPublisherPlugin) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		new Setting(containerEl)
			.setName("Site URL")
			.setDesc("e.g. https://example.com (no trailing slash)")
			.addText((t) =>
				t
					.setPlaceholder("https://example.com")
					.setValue(s.siteUrl)
					.onChange(async (v) => {
						s.siteUrl = v.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Username")
			.setDesc("Your WordPress username")
			.addText((t) =>
				t.setValue(s.username).onChange(async (v) => {
					s.username = v.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Application password")
			.setDesc(
				"Kept in Obsidian's secure keychain instead of data.json, so it stays out of vault backups. Pick an existing secret or create a new one. It's stored on this device only, so enter it once on each device. Create the password in WordPress under Users → Profile → Application Passwords."
			)
			.addComponent((el) =>
				new SecretComponent(this.app, el)
					.setValue(s.secretId)
					.onChange(async (v) => {
						s.secretId = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Test connection")
			.addButton((b) =>
				b.setButtonText("Test").onClick(async () => {
					try {
						const me = await this.plugin.wp("GET", "users/me?context=edit");
						new Notice(`Connected as ${me.name} ✓`);
					} catch (e) {
						new Notice(`Connection failed: ${(e as Error).message}`, 8000);
					}
				})
			);

		new Setting(containerEl).setName("Publishing").setHeading();

		new Setting(containerEl)
			.setName("Default status")
			.setDesc("Used for new posts. Existing posts keep their current status.")
			.addDropdown((d) =>
				d
					.addOption("draft", "Draft")
					.addOption("publish", "Publish")
					.setValue(s.defaultStatus)
					.onChange(async (v) => {
						s.defaultStatus = v as "draft" | "publish";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Center images")
			.setDesc("Images in the post are centered and capped to the content width.")
			.addToggle((t) =>
				t.setValue(s.centerImages).onChange(async (v) => {
					s.centerImages = v;
					await this.plugin.saveSettings();
				})
			);

		for (const [label, key, def] of [
			["Small image width (px)", "sizeSmall", 300],
			["Medium image width (px)", "sizeMedium", 500],
		] as const) {
			new Setting(containerEl)
				.setName(label)
				.setDesc("Used by the right-click size options on images. \"Original\" always means no width.")
				.addText((t) => {
					t.inputEl.type = "number";
					t.inputEl.min = "50";
					t.setPlaceholder(String(def))
						.setValue(String(s[key]))
						.onChange(async (v) => {
							const n = parseInt(v, 10);
							s[key] = Number.isFinite(n) && n > 0 ? n : def;
							await this.plugin.saveSettings();
						});
				});
		}

		new Setting(containerEl)
			.setName("Reuse existing images")
			.setDesc(
				"Dropping the same image again (same filename and contents) reuses the file already in the post folder instead of making \"logo 1.png\". When publishing, images already in your WordPress media library (same file contents, or same filename and size) are reused instead of uploaded again."
			)
			.addToggle((t) =>
				t.setValue(s.reuseImages).onChange(async (v) => {
					s.reuseImages = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Captions from image text")
			.setDesc(
				"Text after the pipe becomes the caption: ![[photo.png|My caption]] or ![[photo.png|My caption|300]] (300 = width). Markdown images use their alt text: ![My caption](photo.png)."
			)
			.addToggle((t) =>
				t.setValue(s.captionsFromAlt).onChange(async (v) => {
					s.captionsFromAlt = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Click to expand images (lightbox)")
			.setDesc(
				"The default for all images. Override it per image with the Expand checkbox that appears when you hover an image in the editor, or right-click the image. Published as WordPress Image blocks, which needs WordPress 6.4 or newer."
			)
			.addToggle((t) =>
				t.setValue(s.lightbox).onChange(async (v) => {
					s.lightbox = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Open external links in a new tab")
			.setDesc("Links to other sites get target=\"_blank\". Links to your own site stay in the same tab.")
			.addToggle((t) =>
				t.setValue(s.externalLinksNewTab).onChange(async (v) => {
					s.externalLinksNewTab = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Tags property name")
			.setDesc(
				"Obsidian's built-in 'tags' property doesn't allow spaces, so a tag like 'home server' shows as invalid there. WordPress itself is fine with spaces. Set this to something like wp_tags to avoid the clash (existing notes aren't migrated)."
			)
			.addText((t) =>
				t
					.setPlaceholder("tags")
					.setValue(s.tagsProperty)
					.onChange(async (v) => {
						s.tagsProperty = v.trim() || "tags";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("Editor").setHeading();

		new Setting(containerEl)
			.setName("Show \"Align text\" in right-click menu")
			.setDesc(
				"Turn off if it clashes with another plugin. The align commands stay available in the command palette."
			)
			.addToggle((t) =>
				t.setValue(s.alignMenu).onChange(async (v) => {
					s.alignMenu = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl).setName("Vault").setHeading();

		new Setting(containerEl)
			.setName("Auto-add properties to new notes")
			.setDesc(
				"Fills title, excerpt, slug, tags, categories and featured image into every new empty note."
			)
			.addToggle((t) =>
				t.setValue(s.autoAddProperties).onChange(async (v) => {
					s.autoAddProperties = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Posts folder")
			.setDesc(
				"Optional, e.g. Blog posts. Limits auto-add, post folders and image hiding to this folder. Leave blank for the whole vault."
			)
			.addText((t) =>
				t
					.setPlaceholder("Blog posts")
					.setValue(s.postsFolder)
					.onChange(async (v) => {
						s.postsFolder = v;
						await this.plugin.saveSettings();
						this.plugin.applyHideCss();
					})
			);

		new Setting(containerEl)
			.setName("Give every post its own folder")
			.setDesc(
				"New notes are moved into a folder with the same name, and images you drop or paste into a post are saved in that folder."
			)
			.addToggle((t) =>
				t.setValue(s.perPostFolders).onChange(async (v) => {
					s.perPostFolders = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Keep note & folder name in sync with title")
			.setDesc(
				"When the title property changes (or on publish), the note and its folder are renamed to match."
			)
			.addToggle((t) =>
				t.setValue(s.syncNameToTitle).onChange(async (v) => {
					s.syncNameToTitle = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Sort notes above other files")
			.setDesc(
				"In the file explorer, each folder lists its notes first and its images after. Obsidian has no built-in option for this, so it's done with styling."
			)
			.addToggle((t) =>
				t.setValue(s.sortNotesFirst).onChange(async (v) => {
					s.sortNotesFirst = v;
					await this.plugin.saveSettings();
					this.plugin.applyHideCss();
				})
			);

		new Setting(containerEl)
			.setName("Hide images in file explorer")
			.setDesc(
				"Image files inside your posts folder are hidden from the sidebar. They still show in your notes."
			)
			.addToggle((t) =>
				t.setValue(s.hideImages).onChange(async (v) => {
					s.hideImages = v;
					await this.plugin.saveSettings();
					this.plugin.applyHideCss();
				})
			);

		new Setting(containerEl)
			.setName("Hide a specific folder in file explorer")
			.setDesc(
				"Folder name to hide (e.g. attachments). Images inside still work in your notes, they just don't clutter the sidebar."
			)
			.addText((t) =>
				t
					.setPlaceholder("attachments")
					.setValue(s.hideFolder)
					.onChange(async (v) => {
						s.hideFolder = v;
						await this.plugin.saveSettings();
						this.plugin.applyHideCss();
					})
			);

		new Setting(containerEl)
			.setName("Clear uploaded-image cache")
			.setDesc(
				"Images are only re-uploaded when they change. Clear this if you deleted media from WordPress."
			)
			.addButton((b) =>
				b.setButtonText("Clear").onClick(async () => {
					s.mediaCache = {};
					s.hashCache = {};
					await this.plugin.saveSettings();
					new Notice("Image cache cleared.");
				})
			);
	}
}
