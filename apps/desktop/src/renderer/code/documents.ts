/**
 * The text of the files open in the Files pane. A document outlives the editor that shows it, so
 * unsaved edits (and, with Monaco, the undo history) survive switching panes or sessions.
 *
 * Until an editor binds a live model to it (`bind`), a document holds plain text; once bound, the
 * model is the text, and "dirty" compares the model's version with the one last saved, so undoing
 * back to the saved text is clean again.
 */

/** A live text model (Monaco's, in the app) that a document hands its text to. */
export interface DocumentBinding {
  getText(): string;
  /** Replaces the whole text (a reload). */
  setText(text: string): void;
  /** Changes with every edit and returns to an earlier value on undo. */
  version(): number;
  dispose(): void;
}

export class TextDocument {
  readonly key: string;
  readonly path: string;
  #plain: string;
  #saved: string;
  /** The binding's version at the last save; null when that is unknown (typed during a save). */
  #savedVersion: number | null = null;
  #binding: DocumentBinding | null = null;
  #listeners = new Set<() => void>();
  #disposed = false;

  constructor(key: string, path: string, text: string) {
    this.key = key;
    this.path = path;
    this.#plain = text;
    this.#saved = text;
  }

  get bound(): DocumentBinding | null {
    return this.#binding;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  getText(): string {
    return this.#binding ? this.#binding.getText() : this.#plain;
  }

  /** The text last loaded or saved. */
  get savedText(): string {
    return this.#saved;
  }

  get dirty(): boolean {
    const binding = this.#binding;
    if (!binding) return this.#plain !== this.#saved;
    if (this.#savedVersion !== null) return binding.version() !== this.#savedVersion;
    return binding.getText() !== this.#saved;
  }

  /**
   * Hands the text to a live model, once: later editors reuse it. `create` gets the current text.
   */
  bind(create: (text: string) => DocumentBinding): DocumentBinding {
    if (this.#binding) return this.#binding;
    const wasDirty = this.dirty;
    const binding = create(this.#plain);
    this.#binding = binding;
    this.#savedVersion = wasDirty ? null : binding.version();
    return binding;
  }

  /** For an editor without a live model (tests): the text changed. */
  setText(text: string): void {
    if (this.#binding) this.#binding.setText(text);
    else this.#plain = text;
    this.changed();
  }

  /** Call after every edit, so listeners can show the dirty marker. */
  changed(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  /** `text` is now what is on disk. The document stays dirty if it has moved on since. */
  markSaved(text: string): void {
    this.#saved = text;
    const binding = this.#binding;
    this.#savedVersion = binding && binding.getText() === text ? binding.version() : null;
    this.changed();
  }

  /** Replaces the text with what is on disk (a reload): clean afterwards. */
  reset(text: string): void {
    this.#saved = text;
    const binding = this.#binding;
    if (binding) {
      if (binding.getText() !== text) binding.setText(text);
      this.#savedVersion = binding.version();
    } else {
      this.#plain = text;
    }
    this.changed();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#binding) {
      this.#plain = this.#binding.getText();
      this.#binding.dispose();
      this.#binding = null;
    }
    this.#listeners.clear();
  }
}

const documents = new Map<string, TextDocument>();

/** The key of a file's document in one session. */
export function documentKey(sessionId: string, path: string): string {
  return `${sessionId}\u0000${path}`;
}

/** The open document for `key`, or a new one holding `text`. */
export function openDocument(key: string, path: string, text: string): TextDocument {
  const existing = documents.get(key);
  if (existing && !existing.disposed) return existing;
  const document = new TextDocument(key, path, text);
  documents.set(key, document);
  return document;
}

export function getDocument(key: string): TextDocument | null {
  return documents.get(key) ?? null;
}

/** Forgets a document and its unsaved edits. */
export function closeDocument(key: string): void {
  documents.get(key)?.dispose();
  documents.delete(key);
}

/** Tests: forgets every document. */
export function closeAllDocuments(): void {
  for (const key of [...documents.keys()]) closeDocument(key);
}
