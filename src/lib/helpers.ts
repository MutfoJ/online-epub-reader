import type { BookStats, ChapterEntry, LibraryBook, TextBlock, TxtBook, TxtSection } from "../types";

const WORDS_PER_PAGE = 250;
const WORDS_PER_MINUTE = 220;

export function prettyTitleFromName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
}

export function truncateText(value: string, maxChars: number): string {
  const text = String(value || "").trim();
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unitIndex]}`;
}

export function normalizeSpeechText(value: string): string {
  return String(value || "")
    .replaceAll("\u00a0", " ")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

const SEGMENT_MIN_LEN = 32;
const SEGMENT_MAX_LEN = 600;
const SEGMENT_HARD_MAX_LEN = 900;

const ABBREVIATIONS = new Set([
  // Titles
  "mr", "mrs", "ms", "mx", "dr", "prof", "sr", "jr", "st", "fr", "rev", "hon", "gov", "sen", "rep", "pres",
  "capt", "cmdr", "lt", "sgt", "cpl", "pvt", "gen", "col", "maj", "adm",
  // Latin / academic
  "etc", "vs", "viz", "cf", "ca", "al", "ibid", "op", "ed", "eds", "vol", "no", "pp", "pg",
  // Cardinal directions / addresses
  "ave", "blvd", "rd", "ln", "ct", "dr", "pl", "sq", "ter", "hwy",
  // Months (3-letter)
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  // Days
  "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun",
  // Misc
  "inc", "ltd", "co", "corp", "llc", "plc", "dept", "univ", "est", "min", "max", "approx",
  // Initials patterns covered separately via single-letter check
]);

function isAbbreviation(token: string): boolean {
  if (!token) return false;
  const lower = token.toLowerCase().replace(/[^a-z]/g, "");
  if (!lower) return false;
  if (lower.length === 1) return true; // single-letter initials e.g. "J. R. R."
  return ABBREVIATIONS.has(lower);
}

function tailingWord(text: string): string {
  const trimmed = text.trimEnd();
  const trailing = trimmed.match(/[A-Za-z]+\.?$/);
  return trailing ? trailing[0].replace(/\.$/, "") : "";
}

function countUnescaped(text: string, char: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) if (text[i] === char) n += 1;
  return n;
}

function isQuoteUnbalanced(text: string): boolean {
  // Treat curly quote pairs and straight pairs as needing balance.
  const dq = countUnescaped(text, "\"");
  if (dq % 2 === 1) return true;
  const open = countUnescaped(text, "\u201c") + countUnescaped(text, "\u00ab");
  const close = countUnescaped(text, "\u201d") + countUnescaped(text, "\u00bb");
  return open !== close;
}

function isBracketUnbalanced(text: string): boolean {
  const pairs: [string, string][] = [["(", ")"], ["[", "]"], ["{", "}"]];
  for (const [o, c] of pairs) {
    if (countUnescaped(text, o) !== countUnescaped(text, c)) return true;
  }
  return false;
}

function endsWithTerminalPunct(text: string): boolean {
  return /[.!?。！？…]["'\u201d\u00bb)\]\}]?\s*$/.test(text.trimEnd());
}

function shouldMergeWithNext(current: string, next: string): boolean {
  const cur = current.trimEnd();
  if (!cur) return false;

  // Decimal numbers: "3." followed by digit
  if (/\d\.$/.test(cur) && /^\d/.test(next.trimStart())) return true;

  // Ellipsis without uppercase continuation
  if (/[…]\s*$/.test(cur) || /\.{3,}\s*$/.test(cur)) {
    const head = next.trimStart();
    if (head && !/^["'\u201c\u00ab(\[\{]?[A-Z\u00c0-\u017f\u0400-\u04ff]/.test(head)) return true;
  }

  // Abbreviations: trailing token before final dot is a known abbrev
  if (cur.endsWith(".")) {
    const word = tailingWord(cur);
    if (isAbbreviation(word)) return true;
  }

  // Unbalanced quotes — break is inside a quotation
  if (isQuoteUnbalanced(cur)) return true;

  // Unbalanced brackets — break is inside parens/brackets
  if (isBracketUnbalanced(cur)) return true;

  // No terminal punctuation at all and very short — likely a fragment
  if (cur.length < SEGMENT_MIN_LEN && !endsWithTerminalPunct(cur)) return true;

  return false;
}

function mergeFalseSentenceBreaks(sentences: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < sentences.length; i += 1) {
    const piece = sentences[i];
    if (!piece) continue;
    if (out.length && shouldMergeWithNext(out[out.length - 1], piece)) {
      out[out.length - 1] = `${out[out.length - 1].trimEnd()} ${piece.trimStart()}`.trim();
    } else {
      out.push(piece.trim());
    }
  }
  return out;
}

function mergeTinySegments(sentences: string[]): string[] {
  if (sentences.length <= 1) return sentences;
  const out: string[] = [];
  for (const piece of sentences) {
    if (!piece) continue;
    if (out.length && (out[out.length - 1].length < SEGMENT_MIN_LEN || piece.length < SEGMENT_MIN_LEN)) {
      const candidate = `${out[out.length - 1]} ${piece}`.trim();
      if (candidate.length <= SEGMENT_MAX_LEN) {
        out[out.length - 1] = candidate;
        continue;
      }
    }
    out.push(piece);
  }
  return out;
}

function findClauseSplit(segment: string): number {
  // Prefer sentence-internal punctuation: em dash, semicolon, colon, comma.
  const candidates: RegExp[] = [
    /[\u2014\u2013]\s/g, // — —
    /;\s/g,
    /:\s/g,
    /,\s/g,
  ];
  const minSide = Math.max(SEGMENT_MIN_LEN, Math.floor(segment.length * 0.25));
  const maxSide = segment.length - minSide;
  let bestPos = -1;
  let bestScore = Infinity;

  for (const re of candidates) {
    const positions: number[] = [];
    for (const m of segment.matchAll(re)) {
      const idx = (m.index || 0) + m[0].length;
      if (idx >= minSide && idx <= maxSide) positions.push(idx);
    }
    if (positions.length) {
      // Pick the position closest to the midpoint.
      const mid = segment.length / 2;
      for (const p of positions) {
        const score = Math.abs(p - mid);
        if (score < bestScore) {
          bestScore = score;
          bestPos = p;
        }
      }
      if (bestPos >= 0) return bestPos;
    }
  }
  return -1;
}

function hardSplitSegment(segment: string, max: number): string[] {
  const out: string[] = [];
  let remaining = segment;
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf(" ", max);
    if (cut < SEGMENT_MIN_LEN) cut = max;
    out.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) out.push(remaining);
  return out;
}

function splitLongSegment(segment: string): string[] {
  if (segment.length <= SEGMENT_MAX_LEN) return [segment];
  const cut = findClauseSplit(segment);
  if (cut > 0) {
    const left = segment.slice(0, cut).trim();
    const right = segment.slice(cut).trim();
    return [...splitLongSegment(left), ...splitLongSegment(right)];
  }
  if (segment.length > SEGMENT_HARD_MAX_LEN) return hardSplitSegment(segment, SEGMENT_HARD_MAX_LEN);
  return [segment];
}

function baseSegment(text: string): string[] {
  // Prefer Intl.Segmenter when available (Unicode-aware, ICU-backed).
  const Segmenter = (Intl as any).Segmenter as
    | (new (locale?: string, options?: { granularity?: "sentence" | "word" | "grapheme" }) => {
        segment: (input: string) => Iterable<{ segment: string; isWordLike?: boolean }>;
      })
    | undefined;
  if (typeof Segmenter === "function") {
    try {
      const seg = new Segmenter(undefined, { granularity: "sentence" });
      const out: string[] = [];
      for (const part of seg.segment(text)) {
        const piece = (part.segment || "").trim();
        if (piece) out.push(piece);
      }
      if (out.length) return out;
    } catch {
      /* fall through */
    }
  }
  // Fallback: regex split on terminal punctuation, preserving the punctuation.
  const matches = text.match(/[^.!?。！？\n]+[.!?。！？]?/g);
  return (matches || [text]).map((item) => item.trim()).filter(Boolean);
}

export function splitParagraphIntoSentences(paragraph: string): string[] {
  const normalized = normalizeSpeechText(paragraph);
  if (!normalized) return [];

  const initial = baseSegment(normalized);
  const merged = mergeFalseSentenceBreaks(initial);
  const compacted = mergeTinySegments(merged);

  const result: string[] = [];
  for (const piece of compacted) {
    for (const sub of splitLongSegment(piece)) {
      const trimmed = sub.trim();
      if (trimmed) result.push(trimmed);
    }
  }
  return result.length ? result : [normalized];
}

export function splitTxtIntoSections(text: string, fallbackTitle: string): TxtSection[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const chapterPattern =
    /(^|\n)(chapter|cap[ií]tulo|part|volume|book|arc|prologue|epilogue)\s+([^\n]{0,80})/gim;
  const matches = [...normalized.matchAll(chapterPattern)];

  if (matches.length < 2) {
    return splitTxtByLength(normalized, fallbackTitle);
  }

  const sections: TxtSection[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = (match.index || 0) + (match[1] ? match[1].length : 0);
    const end = index + 1 < matches.length ? matches[index + 1].index || normalized.length : normalized.length;
    const headingEnd = normalized.indexOf("\n", start);
    const heading = normalized.slice(start, headingEnd === -1 ? end : headingEnd).trim();
    const body = normalized.slice(start, end).trim();
    sections.push(buildTxtSection(heading || `Section ${index + 1}`, body, index));
  }

  return sections.length ? sections : splitTxtByLength(normalized, fallbackTitle);
}

function splitTxtByLength(text: string, fallbackTitle: string): TxtSection[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const sections: TxtSection[] = [];
  let current: string[] = [];
  let currentLength = 0;
  let part = 1;

  for (const paragraph of paragraphs) {
    current.push(paragraph);
    currentLength += paragraph.length;
    if (currentLength >= 9000) {
      sections.push(buildTxtSection(part === 1 ? fallbackTitle : `Part ${part}`, current.join("\n\n"), sections.length));
      current = [];
      currentLength = 0;
      part += 1;
    }
  }

  if (current.length) {
    sections.push(buildTxtSection(part === 1 ? fallbackTitle : `Part ${part}`, current.join("\n\n"), sections.length));
  }

  return sections;
}

function buildTxtSection(label: string, body: string, index: number): TxtSection {
  const blocks = body
    .split(/\n{2,}/)
    .map((part) => normalizeSpeechText(part))
    .filter(Boolean)
    .map((part, blockIndex) => buildTextBlock(part, `${index}-${blockIndex}`));

  return {
    id: `section-${index}`,
    label,
    blocks,
    plainText: blocks.map((block) => block.text).join("\n\n"),
  };
}

function buildTextBlock(text: string, key: string): TextBlock {
  const sentences = splitParagraphIntoSentences(text).map((sentence, index) => ({
    id: `${key}-sentence-${index}`,
    text: sentence,
  }));

  return {
    id: `block-${key}`,
    text,
    sentences,
  };
}

export function getProgressLabel(book: { type: "epub" | "txt"; reading: any; sections?: TxtSection[] }): string {
  if (book.type === "epub") {
    const progress = book.reading?.progress || 0;
    return progress ? `${progress}% read` : "Not started";
  }

  const index = (book.reading?.sectionIndex || 0) + 1;
  const total = book.sections?.length || 1;
  return `${Math.min(index, total)} / ${total} sections`;
}

export function sectionEntriesFromTxt(sections: TxtSection[]): ChapterEntry[] {
  return sections.map((section, index) => ({
    key: String(index),
    label: `${index + 1}. ${section.label}`,
  }));
}

export function formatBookType(type: string): string {
  return type.toUpperCase();
}

export function buildBookStats(
  wordCount: number,
  imageCount: number,
  chapterCount: number,
): BookStats {
  const safeWords = Math.max(0, Math.round(wordCount));
  return {
    wordCount: safeWords,
    imageCount: Math.max(0, Math.round(imageCount)),
    chapterCount: Math.max(0, Math.round(chapterCount)),
    estimatedPages: safeWords ? Math.max(1, Math.round(safeWords / WORDS_PER_PAGE)) : 0,
    estimatedMinutes: safeWords ? Math.max(1, Math.round(safeWords / WORDS_PER_MINUTE)) : 0,
  };
}

export function statsForTxt(book: TxtBook): BookStats {
  let words = 0;
  for (const section of book.sections) {
    const text = section.plainText || section.blocks.map((block) => block.text).join(" ");
    if (text) words += countWords(text);
  }
  return buildBookStats(words, 0, book.sections.length);
}

export function countWords(text: string): number {
  if (!text) return 0;
  const matches = text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  return matches ? matches.length : 0;
}

export function getBookProgressPercent(book: LibraryBook): number {
  if (book.type === "epub") return Math.max(0, Math.min(100, book.reading?.progress || 0));
  const total = book.sections?.length || 0;
  if (!total) return 0;
  const idx = Math.max(0, Math.min(total - 1, book.reading?.sectionIndex || 0));
  return Math.round(((idx + 1) / total) * 100);
}

export function formatReadingTime(totalMinutes: number): string {
  if (!totalMinutes || totalMinutes < 1) return "—";
  if (totalMinutes < 60) return `${Math.round(totalMinutes)} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = Math.round(totalMinutes - hours * 60);
  if (!minutes) return `${hours} h`;
  return `${hours} h ${minutes} min`;
}

export function formatNumberCompact(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1000) return String(Math.round(value));
  if (value < 10_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function getInitials(value: string, max = 2): string {
  const cleaned = String(value || "").trim();
  if (!cleaned) return "?";
  const parts = cleaned.split(/\s+/).slice(0, max);
  return parts.map((part) => part[0]?.toUpperCase() || "").join("") || cleaned[0].toUpperCase();
}

export function colorTokenFromString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) & 0xffffffff;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 58%, 56%)`;
}

export function guessMimeFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".epub")) {
    return "application/epub+zip";
  }
  if (lower.endsWith(".txt")) {
    return "text/plain";
  }
  if (lower.endsWith(".zip")) {
    return "application/zip";
  }
  return "application/octet-stream";
}

export function isQuotaExceededError(error: unknown): boolean {
  const candidate = error as { name?: string; code?: number; message?: string } | null;
  return Boolean(
    candidate &&
    (candidate.name === "QuotaExceededError" ||
      candidate.code === 22 ||
      String(candidate.message || "").toLowerCase().includes("quota")),
  );
}
