import { BlobReader, BlobWriter, TextWriter, ZipReader } from "@zip.js/zip.js";

import { buildBookStats, countWords, stripHtml } from "./helpers";
import { normalizeFileHref } from "./epub";
import { getAnalysisConcurrency, getDevicePerformanceProfile } from "./performance";
import type { BookStats } from "../types";

export interface EpubAnalysis {
  coverDataUrl: string | null;
  stats: BookStats;
  chapterImagesByHref: Record<string, number>;
}

const COVER_NAME_PATTERN = /(?:^|\/)(cover|titlepage|frontcover)[^/]*\.(jpe?g|png|webp|gif)$/i;
const IMAGE_PATTERN = /\.(jpe?g|png|webp|gif|bmp|svg)$/i;
const HTML_PATTERN = /\.(x?html?|htm)$/i;
const COVER_MAX_WIDTH = 360;
const MOBILE_COVER_MAX_WIDTH = 220;
const WORD_ANALYSIS_MAX_BYTES = 80 * 1024 * 1024;
const COVER_ANALYSIS_MAX_BYTES = 140 * 1024 * 1024;
const CONSTRAINED_COVER_ANALYSIS_MAX_BYTES = 35 * 1024 * 1024;
const CONSTRAINED_WORD_ANALYSIS_MAX_BYTES = 14 * 1024 * 1024;
const CHAPTER_WORD_ANALYSIS_MAX_BYTES = 3 * 1024 * 1024;

export async function analyzeEpub(blob: Blob, password?: string): Promise<EpubAnalysis> {
  const reader = new ZipReader(new BlobReader(blob), { password });
  try {
    const entries = await reader.getEntries();
    const profile = getDevicePerformanceProfile();
    const coverLimit = profile.constrained ? CONSTRAINED_COVER_ANALYSIS_MAX_BYTES : COVER_ANALYSIS_MAX_BYTES;
    const coverWidth = profile.constrained ? MOBILE_COVER_MAX_WIDTH : COVER_MAX_WIDTH;
    const wordLimit = profile.constrained ? CONSTRAINED_WORD_ANALYSIS_MAX_BYTES : WORD_ANALYSIS_MAX_BYTES;

    const coverDataUrl =
      blob.size <= coverLimit
        ? await extractCover(entries, coverWidth, password).catch(() => null)
        : null;

    const htmlEntries = entries.filter((entry) => !entry.directory && HTML_PATTERN.test(entry.filename));
    const chapterImagesByHref: Record<string, number> = {};
    let totalWords = 0;
    let totalImages = 0;
    const countWordsForBook = blob.size <= wordLimit;

    await mapLimit(htmlEntries, getAnalysisConcurrency(), async (entry) => {
      if (typeof (entry as any).getData !== "function") return;
      try {
        const raw = await (entry as any).getData(new TextWriter(), password ? { password } : {});
        const parsed = parseChapterDocument(raw, {
          countWords:
            countWordsForBook &&
            Number((entry as any).uncompressedSize || raw.length || 0) <= CHAPTER_WORD_ANALYSIS_MAX_BYTES,
        });
        if (!parsed) return;
        const { wordCount, imageCount } = parsed;
        if (imageCount) {
          chapterImagesByHref[normalizeFileHref(entry.filename)] = imageCount;
        }
        totalWords += wordCount;
        totalImages += imageCount;
      } catch {
        /* skip unreadable chapter */
      }
    });

    return {
      coverDataUrl,
      stats: buildBookStats(totalWords, totalImages, htmlEntries.length),
      chapterImagesByHref,
    };
  } finally {
    await reader.close().catch(() => {});
  }
}

async function extractCover(entries: any[], maxWidth: number, password?: string): Promise<string | null> {
  const named = entries.find(
    (entry) => !entry.directory && COVER_NAME_PATTERN.test(entry.filename),
  );
  const fallback = entries.find(
    (entry) => !entry.directory && IMAGE_PATTERN.test(entry.filename),
  );
  const target = named || fallback;
  if (!target || typeof (target as any).getData !== "function") return null;

  try {
    const imageBlob = await (target as any).getData(new BlobWriter(), password ? { password } : {});
    return await blobToCappedDataUrl(imageBlob, maxWidth);
  } catch {
    return null;
  }
}

// Cheap analysis pass: count images by tag-presence regex, count words from regex-stripped
// text. Avoids the per-chapter DOMParser allocation that dominated import time on big EPUBs.
const IMAGE_TAG_PATTERN = /<(?:img|image|svg)\b/gi;

function parseChapterDocument(
  raw: string,
  options: { countWords: boolean },
): { wordCount: number; imageCount: number } | null {
  if (!raw) return null;
  let imageCount = 0;
  for (const _ of raw.matchAll(IMAGE_TAG_PATTERN)) imageCount += 1;
  if (!options.countWords) return { wordCount: 0, imageCount };
  return { wordCount: countWords(stripHtml(raw)), imageCount };
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  let completed = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        await worker(items[index], index);
        completed += 1;
        if (completed % 16 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    }),
  );
}

async function blobToCappedDataUrl(blob: Blob, maxWidth: number): Promise<string | null> {
  if (typeof window === "undefined") return null;

  // SVGs aren't worth re-encoding — read directly and trust them, capped by raw size.
  if (blob.type.includes("svg") && blob.size < 64 * 1024) {
    return readBlobAsDataUrl(blob);
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = await loadHtmlImage(objectUrl);
    const targetWidth = Math.min(maxWidth, image.naturalWidth || maxWidth);
    const ratio = image.naturalHeight && image.naturalWidth ? image.naturalHeight / image.naturalWidth : 1.5;
    const targetHeight = Math.round(targetWidth * ratio);
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, targetWidth, targetHeight);
    return canvas.toDataURL("image/jpeg", 0.78);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image load failed"));
    image.src = src;
  });
}

function readBlobAsDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}
