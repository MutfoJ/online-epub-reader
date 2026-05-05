import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { importBooksFromFiles } from "../lib/importBooks";
import { analyzeEpub } from "../lib/epubAnalysis";
import { requestIdleWork } from "../lib/performance";
import {
  ensurePersistentStorage,
  getBookBlob,
  loadLibraryMeta,
  loadSettings,
  removeBookBlob,
  removeEpubLocations,
  saveLibraryMeta,
  saveSettings,
} from "../lib/storage";
import type { LibraryBook, ReaderSettings } from "../types";

interface BooksContextValue {
  books: LibraryBook[];
  libraryReady: boolean;
  importStatus: string;
  importError: boolean;
  importFiles: (files: File[], password?: string) => Promise<string[]>;
  refreshLibrary: () => Promise<void>;
  deleteBook: (bookId: string) => Promise<void>;
  updateBook: (book: LibraryBook) => Promise<void>;
  getBookBlob: (bookId: string) => Promise<Blob | null>;
}

interface SettingsContextValue {
  settings: ReaderSettings;
  updateSettings: (patch: Partial<ReaderSettings>) => Promise<void>;
}

const DEFAULT_SETTINGS: ReaderSettings = {
  theme: "mist",
  fontSize: 21,
  lineHeight: 1.85,
  maxWidth: 840,
  flow: "scrolled-doc",
  speechRate: 1,
  speechVoiceURI: "",
  speechAutoContinue: true,
};

const BooksContext = createContext<BooksContextValue | null>(null);
const SettingsContext = createContext<SettingsContextValue | null>(null);

export function AppStoreProvider({ children }: { children: ReactNode }) {
  const [books, setBooks] = useState<LibraryBook[]>([]);
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_SETTINGS);
  const booksRef = useRef<LibraryBook[]>([]);
  const settingsRef = useRef<ReaderSettings>(DEFAULT_SETTINGS);
  const [libraryReady, setLibraryReady] = useState(false);
  const [importStatus, setImportStatus] = useState("No import running.");
  const [importError, setImportError] = useState(false);

  const refreshLibrary = useCallback(async () => {
    const [library, persistedSettings] = await Promise.all([loadLibraryMeta(), loadSettings()]);
    booksRef.current = library;
    settingsRef.current = persistedSettings;
    setBooks(library);
    setSettings(persistedSettings);
    setLibraryReady(true);
  }, []);

  useEffect(() => {
    ensurePersistentStorage();
    refreshLibrary().catch((error: Error) => {
      setImportStatus(error.message || "Startup failed.");
      setImportError(true);
      setLibraryReady(true);
    });
  }, [refreshLibrary]);

  const sortBooks = useCallback(
    (entries: LibraryBook[]) =>
      [...entries].sort((a, b) => {
        const left = a.lastOpenedAt || a.importedAt;
        const right = b.lastOpenedAt || b.importedAt;
        return new Date(right).getTime() - new Date(left).getTime();
      }),
    [],
  );

  const persistBooks = useCallback(async (nextBooks: LibraryBook[]) => {
    booksRef.current = nextBooks;
    setBooks(nextBooks);
    await saveLibraryMeta(nextBooks);
  }, []);

  const enqueueDeferredEpubAnalysis = useCallback(
    (entries: LibraryBook[]) => {
      const pending = entries.filter(
        (book): book is Extract<LibraryBook, { type: "epub" }> =>
          book.type === "epub" && book.analysisStatus === "pending",
      );
      if (!pending.length) return;

      requestIdleWork(() => {
        void (async () => {
          for (const importedBook of pending) {
            const current = booksRef.current.find((book) => book.id === importedBook.id);
            if (!current || current.type !== "epub" || current.analysisStatus !== "pending") continue;

            try {
              const blob = await getBookBlob(current.id);
              if (!blob) continue;
              const analysis = await analyzeEpub(blob);
              const nextBook: LibraryBook = {
                ...current,
                coverDataUrl: current.coverDataUrl ?? analysis.coverDataUrl,
                stats: analysis.stats,
                chapterImagesByHref: Object.keys(analysis.chapterImagesByHref).length
                  ? analysis.chapterImagesByHref
                  : current.chapterImagesByHref,
                analysisStatus: "complete",
              };
              const nextBooks = sortBooks(
                booksRef.current.map((entry) => (entry.id === nextBook.id ? nextBook : entry)),
              );
              booksRef.current = nextBooks;
              setBooks(nextBooks);
              await saveLibraryMeta(nextBooks);
            } catch {
              const latest = booksRef.current.find((book) => book.id === importedBook.id);
              if (!latest || latest.type !== "epub") continue;
              const nextBooks = sortBooks(
                booksRef.current.map((entry) =>
                  entry.id === latest.id ? { ...latest, analysisStatus: "skipped" } : entry,
                ),
              );
              booksRef.current = nextBooks;
              setBooks(nextBooks);
              await saveLibraryMeta(nextBooks);
            }
          }
        })();
      });
    },
    [sortBooks],
  );

  const importFiles = useCallback(
    async (files: File[], password?: string) => {
      setImportError(false);
      setImportStatus(`Importing ${files.length} file(s)...`);
      try {
        const imported = await importBooksFromFiles(files, password);
        if (!imported.length) {
          setImportStatus("No supported books were found in the selected files.");
          setImportError(true);
          return [];
        }
        const nextBooks = sortBooks([...imported, ...booksRef.current]);
        await persistBooks(nextBooks);
        enqueueDeferredEpubAnalysis(imported);
        setImportStatus(`Imported ${imported.length} book(s).`);
        return imported.map((book) => book.id);
      } catch (error) {
        const message = (error as Error).message || "Import failed.";
        setImportStatus(message);
        setImportError(true);
        return [];
      }
    },
    [enqueueDeferredEpubAnalysis, persistBooks, sortBooks],
  );

  const deleteBook = useCallback(
    async (bookId: string) => {
      await removeBookBlob(bookId);
      await removeEpubLocations(bookId).catch(() => {});
      const nextBooks = booksRef.current.filter((book) => book.id !== bookId);
      await persistBooks(nextBooks);
    },
    [persistBooks],
  );

  // Stable: never depends on `books` directly — uses booksRef so consumers don't churn.
  const updateBook = useCallback(
    async (book: LibraryBook) => {
      const nextBook = structuredClone(book);
      const nextBooks = sortBooks(
        booksRef.current.map((entry) => (entry.id === nextBook.id ? nextBook : entry)),
      );
      booksRef.current = nextBooks;
      setBooks(nextBooks);
      await saveLibraryMeta(nextBooks);
    },
    [sortBooks],
  );

  const updateSettings = useCallback(async (patch: Partial<ReaderSettings>) => {
    const nextSettings = { ...settingsRef.current, ...patch };
    settingsRef.current = nextSettings;
    setSettings(nextSettings);
    await saveSettings(nextSettings);
  }, []);

  const booksValue = useMemo<BooksContextValue>(
    () => ({
      books,
      libraryReady,
      importStatus,
      importError,
      importFiles,
      refreshLibrary,
      deleteBook,
      updateBook,
      getBookBlob,
    }),
    [books, libraryReady, importStatus, importError, importFiles, refreshLibrary, deleteBook, updateBook],
  );

  const settingsValue = useMemo<SettingsContextValue>(
    () => ({ settings, updateSettings }),
    [settings, updateSettings],
  );

  return (
    <BooksContext.Provider value={booksValue}>
      <SettingsContext.Provider value={settingsValue}>{children}</SettingsContext.Provider>
    </BooksContext.Provider>
  );
}

export function useBooks(): BooksContextValue {
  const context = useContext(BooksContext);
  if (!context) throw new Error("useBooks must be used inside AppStoreProvider");
  return context;
}

export function useSettings(): SettingsContextValue {
  const context = useContext(SettingsContext);
  if (!context) throw new Error("useSettings must be used inside AppStoreProvider");
  return context;
}

/** Combined hook kept for backwards compatibility with existing callers. */
export function useAppStore() {
  const books = useBooks();
  const settings = useSettings();
  return { ...books, ...settings };
}
