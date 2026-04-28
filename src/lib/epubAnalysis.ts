import { BlobReader, BlobWriter, TextWriter, ZipReader } from "@zip.js/zip.js";

import { buildBookStats, countWords, stripHtml } from "./helpers";
import { normalizeFileHref } from "./epub";
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
const ANALYSIS_MAX_BYTES = 80 * 1024 * 1024; // skip deep analysis for very large EPUBs

export async function analyzeEpub(blob: Blob, password?: string): Promise<EpubAnalysis> {
  const empty: EpubAnalysis = {
    coverDataUrl: null,
    stats: buildBookStats(0, 0, 0),
    chapterImagesByHref: {},
  };
  if (blob.size > ANALYSIS_MAX_BYTES) return empty;

  const reader = new ZipReader(new BlobReader(blob), { password });
  try {
    const entries = await reader.getEntries();

    const coverDataUrl = await extractCover(entries, password).catch(() => null);

    const htmlEntries = entries.filter((entry) => !entry.directory && HTML_PATTERN.test(entry.filename));
    const chapterImagesByHref: Record<string, number> = {};
    let totalWords = 0;
    let totalImages = 0;

    const YIELD_EVERY = 25;
    for (let i = 0; i < htmlEntries.length; i += 1) {
      const entry = htmlEntries[i];
      const reader = (entry as any).getData;
      if (typeof reader !== "function") continue;
      try {
        const raw = await (entry as any).getData(new TextWriter(), password ? { password } : {});
        const parsed = parseChapterDocument(raw);
        if (!parsed) continue;
        const { wordCount, imageCount } = parsed;
        if (imageCount) {
          chapterImagesByHref[normalizeFileHref(entry.filename)] = imageCount;
        }
        totalWords += wordCount;
        totalImages += imageCount;
      } catch {
        /* skip unreadable chapter */
      }
      // Yield periodically so the import doesn't block the main thread on big books.
      if ((i + 1) % YIELD_EVERY === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    return {
      coverDataUrl,
      stats: buildBookStats(totalWords, totalImages, htmlEntries.length),
      chapterImagesByHref,
    };
  } finally {
    await reader.close().catch(() => {});
  }
}

async function extractCover(entries: any[], password?: string): Promise<string | null> {
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
    return await blobToCappedDataUrl(imageBlob, COVER_MAX_WIDTH);
  } catch {
    return null;
  }
}

// Cheap analysis pass: count images by tag-presence regex, count words from regex-stripped
// text. Avoids the per-chapter DOMParser allocation that dominated import time on big EPUBs.
const IMAGE_TAG_PATTERN = /<(?:img|image|svg)\b/gi;

function parseChapterDocument(raw: string): { wordCount: number; imageCount: number } | null {
  if (!raw) return null;
  let imageCount = 0;
  for (const _ of raw.matchAll(IMAGE_TAG_PATTERN)) imageCount += 1;
  const text = stripHtml(raw);
  return { wordCount: countWords(text), imageCount };
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
