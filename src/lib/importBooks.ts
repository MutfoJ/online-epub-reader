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
import { storeBookBlob } from "./storage";

export async function importBooksFromFiles(files: File[], password?: string): Promise<LibraryBook[]> {
  const importedBooks: LibraryBook[] = [];
  for (const file of files) {
    const extracted = await extractBooksFromFile(file, password);
    importedBooks.push(...extracted);
  }

  await assertEnoughBrowserStorage(importedBooks);

  for (const book of importedBooks) {
    const blob = (book as LibraryBook & { fileBlob?: Blob }).fileBlob;
    if (blob) {
      await storeBookBlob(book.id, blob);
      delete (book as LibraryBook & { fileBlob?: Blob }).fileBlob;
    }
  }

  return dedupeLibrary(importedBooks);
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
    const books: LibraryBook[] = [];

    for (const entry of entries) {
      if (entry.directory) {
        continue;
      }

      const name = entry.filename.toLowerCase();
      if (!(name.endsWith(".epub") || name.endsWith(".txt") || name.endsWith(".zip"))) {
        continue;
      }

      const blob = await entry.getData(new BlobWriter(), password ? { password } : {});
      const nestedFile = new File([blob], entry.filename.split("/").pop() || entry.filename, {
        type: blob.type || guessMimeFromName(entry.filename),
      });

      if (name.endsWith(".zip")) {
        const nested = await extractBooksFromZip(nestedFile, password, `${sourceName} > ${entry.filename}`);
        books.push(...nested);
        continue;
      }

      books.push(
        await buildBookRecord(nestedFile, name.endsWith(".epub") ? "epub" : "txt", {
          sourceLabel: `${sourceName} > ${entry.filename}`,
        }),
      );
    }

    return books;
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
  const blob = new Blob([await file.arrayBuffer()], {
    type: file.type || guessMimeFromName(file.name),
  });

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
