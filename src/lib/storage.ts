import localforage from "localforage";

import type { LibraryBook, ReaderSettings } from "../types";

export const STORAGE = localforage.createInstance({
  name: "epub-reader-v2",
});

const META_KEY = "library-meta-v2";
const SETTINGS_KEY = "reader-settings-v2";

export const DEFAULT_SETTINGS: ReaderSettings = {
  theme: "mist",
  fontSize: 21,
  lineHeight: 1.85,
  maxWidth: 840,
  flow: "scrolled-doc",
  speechRate: 1,
  speechVoiceURI: "",
  speechAutoContinue: true,
};

export function getBookStorageKey(bookId: string): string {
  return `book-file-v2:${bookId}`;
}

export async function loadLibraryMeta(): Promise<LibraryBook[]> {
  const books = ((await STORAGE.getItem(META_KEY)) || []) as LibraryBook[];
  return books.sort((a, b) => {
    const left = a.lastOpenedAt || a.importedAt;
    const right = b.lastOpenedAt || b.importedAt;
    return new Date(right).getTime() - new Date(left).getTime();
  });
}

export async function saveLibraryMeta(books: LibraryBook[]): Promise<void> {
  await STORAGE.setItem(META_KEY, books);
}

export async function loadSettings(): Promise<ReaderSettings> {
  const saved = (await STORAGE.getItem(SETTINGS_KEY)) as Partial<ReaderSettings> | null;
  return { ...DEFAULT_SETTINGS, ...(saved || {}) };
}

export async function saveSettings(settings: ReaderSettings): Promise<void> {
  await STORAGE.setItem(SETTINGS_KEY, settings);
}

export async function storeBookBlob(bookId: string, blob: Blob): Promise<void> {
  await STORAGE.setItem(getBookStorageKey(bookId), blob);
}

export async function getBookBlob(bookId: string): Promise<Blob | null> {
  return (await STORAGE.getItem(getBookStorageKey(bookId))) as Blob | null;
}

export async function removeBookBlob(bookId: string): Promise<void> {
  await STORAGE.removeItem(getBookStorageKey(bookId));
}

const LOCATIONS_KEY_PREFIX = "epub-locations-v2:";

export async function loadEpubLocations(bookId: string): Promise<string | null> {
  return ((await STORAGE.getItem(`${LOCATIONS_KEY_PREFIX}${bookId}`)) as string | null) || null;
}

export async function saveEpubLocations(bookId: string, serialized: string): Promise<void> {
  await STORAGE.setItem(`${LOCATIONS_KEY_PREFIX}${bookId}`, serialized);
}

export async function removeEpubLocations(bookId: string): Promise<void> {
  await STORAGE.removeItem(`${LOCATIONS_KEY_PREFIX}${bookId}`);
}

export function ensurePersistentStorage(): void {
  if (!navigator.storage?.persist) {
    return;
  }

  navigator.storage.persist().catch(() => {
    /* ignore */
  });
}
