import { BlobReader, BlobWriter, ZipReader } from "@zip.js/zip.js";

import type { EpubBook, LibraryBook, TxtBook } from "../types";
import { analyzeEpub } from "./epubAnalysis";
import {
  buildBookStats,
  formatBytes,
  guessMimeFromName,
  isQuotaExceededError,
  prettyTitleFromName,
  splitTxtIntoSections,
  statsForTxt,
} from "./helpers";
import { getImportConcurrency, shouldDeferEpubAnalysis } from "./performance";
import { storeBookBlob } from "./storage";

export async function importBooksFromFiles(files: File[], password?: string): Promise<LibraryBook[]> {
  const importConcurrency = getImportConcurrency();
  const extracted = await mapLimit(files, importConcurrency, (file) =>
    extractBooksFromFile(file, password),
  );
  const importedBooks = dedupeLibrary(extracted.flat());

  await assertEnoughBrowserStorage(importedBooks);

  await mapLimit(importedBooks, importConcurrency, async (book) => {
    const blob = (book as LibraryBook & { fileBlob?: Blob }).fileBlob;
    if (blob) {
      await storeBookBlob(book.id, blob);
      delete (book as LibraryBook & { fileBlob?: Blob }).fileBlob;
    }
  });

  return importedBooks;
}

async function extractBooksFromFile(file: File, password?: string): Promise<LibraryBook[]> {
  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith(".epub")) {
    return [await buildBookRecord(file, "epub")];
  }
  if (lowerName.endsWith(".txt")) {
    return [await buildBookRecord(file, "txt")];
  }
  if (lowerName.endsWith(".zip")) {
    return extractBooksFromZip(file, password, file.name);
  }
  return [];
}

async function extractBooksFromZip(file: File, password: string | undefined, sourceName: string): Promise<LibraryBook[]> {
  const zipReader = new ZipReader(new BlobReader(file), { password });

  try {
    const entries = await zipReader.getEntries();
    const supportedEntries = entries.filter((entry) => {
      if (entry.directory) return false;
      const name = entry.filename.toLowerCase();
      return name.endsWith(".epub") || name.endsWith(".txt") || name.endsWith(".zip");
    });

    const books = await mapLimit(supportedEntries, getImportConcurrency(), async (entry) => {
      const name = entry.filename.toLowerCase();
      const blob = await (entry as any).getData(new BlobWriter(), password ? { password } : {});
      const nestedFile = new File([blob], entry.filename.split("/").pop() || entry.filename, {
        type: blob.type || guessMimeFromName(entry.filename),
      });

      if (name.endsWith(".zip")) {
        return extractBooksFromZip(nestedFile, password, `${sourceName} > ${entry.filename}`);
      }

      return [
        await buildBookRecord(nestedFile, name.endsWith(".epub") ? "epub" : "txt", {
          sourceLabel: `${sourceName} > ${entry.filename}`,
        }),
      ];
    });

    return books.flat();
  } catch (error) {
    if (String((error as Error)?.message || "").toLowerCase().includes("password")) {
      throw new Error(
        "ZIP extraction failed. If the archive is encrypted, enter the correct ZIP password and try again.",
      );
    }
    throw error;
  } finally {
    await zipReader.close();
  }
}

async function buildBookRecord(
  file: File,
  type: "epub" | "txt",
  options: { sourceLabel?: string } = {},
): Promise<LibraryBook> {
  const id = crypto.randomUUID();
  const importedAt = new Date().toISOString();
  // A File is already a Blob — re-type without copying the bytes via slice().
  const desiredType = file.type || guessMimeFromName(file.name);
  const blob: Blob = file.type === desiredType ? file : file.slice(0, file.size, desiredType);

  if (type === "txt") {
    const text = await blob.text();
    const sections = splitTxtIntoSections(text, prettyTitleFromName(file.name));
    const partial: TxtBook & { fileBlob?: Blob } = {
      id,
      type,
      title: prettyTitleFromName(file.name),
      author: "TXT import",
      fileName: file.name,
      sourceLabel: options.sourceLabel || "Local file",
      size: blob.size,
      importedAt,
      lastOpenedAt: importedAt,
      sections,
      reading: {
        sectionIndex: 0,
        progress: 0,
      },
      fileBlob: blob,
    };
    partial.stats = statsForTxt(partial);
    return partial;
  }

  // EPUB analysis: best-effort cover + word/image stats. Failure is non-fatal.
  let coverDataUrl: string | null = null;
  let chapterImagesByHref: Record<string, number> | undefined;
  let stats = buildBookStats(0, 0, 0);
  const deferAnalysis = shouldDeferEpubAnalysis(blob.size);
  if (!deferAnalysis) {
    try {
      const analysis = await analyzeEpub(blob);
      coverDataUrl = analysis.coverDataUrl;
      if (Object.keys(analysis.chapterImagesByHref).length) {
        chapterImagesByHref = analysis.chapterImagesByHref;
      }
      stats = analysis.stats;
    } catch {
      /* ignore analysis errors */
    }
  }

  const book: EpubBook & { fileBlob?: Blob } = {
    id,
    type,
    title: prettyTitleFromName(file.name),
    author: "Unknown author",
    fileName: file.name,
    sourceLabel: options.sourceLabel || "Local file",
    size: blob.size,
    importedAt,
    lastOpenedAt: importedAt,
    coverDataUrl,
    stats,
    chapterImagesByHref,
    analysisStatus: deferAnalysis ? "pending" : "complete",
    reading: {
      cfi: null,
      href: null,
      chapterIndex: 0,
      progress: 0,
    },
    fileBlob: blob,
  };
  return book;
}

function dedupeLibrary(books: LibraryBook[]): LibraryBook[] {
  const seen = new Set<string>();
  return books.filter((book) => {
    const fingerprint = `${book.fileName}:${book.size}:${book.type}`;
    if (seen.has(fingerprint)) {
      return false;
    }
    seen.add(fingerprint);
    return true;
  });
}

async function assertEnoughBrowserStorage(books: LibraryBook[]): Promise<void> {
  if (!navigator.storage?.estimate) {
    return;
  }

  try {
    const estimate = await navigator.storage.estimate();
    const quota = estimate?.quota ?? 0;
    const usage = estimate?.usage ?? 0;
    const remaining = quota - usage;
    const totalIncoming = books.reduce((sum, book) => sum + book.size, 0);
    if (quota > 0 && totalIncoming > remaining * 0.95) {
      throw new Error(
        `These books need about ${formatBytes(totalIncoming)} but only about ${formatBytes(Math.max(0, remaining))} of browser storage appears to be free.`,
      );
    }
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
  }
}

export async function persistBookBlob(bookId: string, blob: Blob): Promise<void> {
  try {
    await storeBookBlob(bookId, blob);
  } catch (error) {
    if (isQuotaExceededError(error)) {
      throw new Error("This browser does not have enough local storage space for that book.");
    }
    throw error;
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index], index);
        if ((index + 1) % 12 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    }),
  );

  return results;
}
