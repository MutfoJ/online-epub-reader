import type { ChapterEntry } from "../types";

let epubFactoryPromise: Promise<any> | null = null;

export async function loadEpubFactory(): Promise<any> {
  if (!epubFactoryPromise) {
    epubFactoryPromise = import("epubjs").then((module) => module.default);
  }
  return epubFactoryPromise;
}

export function flattenToc(
  items: Array<{ label?: string; href?: string; subitems?: any[] }>,
  output: ChapterEntry[] = [],
  level = 0,
): ChapterEntry[] {
  for (const item of items) {
    output.push({
      key: item.href || item.label || `chapter-${output.length}`,
      label: item.label || item.href || `Chapter ${output.length + 1}`,
      href: item.href,
      level,
    });
    if (item.subitems?.length) {
      flattenToc(item.subitems, output, level + 1);
    }
  }
  return output;
}

export function stripFragment(href: string | null | undefined): string {
  return String(href || "").split("#")[0].trim();
}

export function getFragment(href: string | null | undefined): string {
  const value = String(href || "");
  const index = value.indexOf("#");
  return index >= 0 ? value.slice(index + 1).trim() : "";
}

/** Normalizes a URL for *file* equality — strips fragment, lowercases, trims path noise. */
export function normalizeFileHref(href: string | null | undefined): string {
  return String(stripFragment(href))
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/^\/+/, "")
    .trim()
    .toLowerCase();
}

/** Normalizes a URL for *chapter identity* — preserves fragment, so anchors in the same file stay distinct. */
export function normalizeChapterKey(href: string | null | undefined): string {
  const base = normalizeFileHref(href);
  const fragment = getFragment(href);
  return fragment ? `${base}#${fragment.toLowerCase()}` : base;
}

export function hrefsMatchFile(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = normalizeFileHref(left);
  const b = normalizeFileHref(right);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

// Backwards-compat aliases (kept for any imports outside this file).
export const getChapterTarget = stripFragment;
export const normalizeHref = normalizeFileHref;
export const hrefsMatch = hrefsMatchFile;

export function buildChaptersFromSpine(
  spine: any,
  flatToc: ChapterEntry[],
  imagesByHref?: Record<string, number> | null,
): ChapterEntry[] {
  const items = spine?.items || [];
  const spineByHref = buildSpineLookup(spine);
  const navEntries = buildTocNavigation(flatToc, spine, spineByHref);

  const annotate = (entry: ChapterEntry): ChapterEntry => {
    if (!imagesByHref) return entry;
    const lookupKey = normalizeFileHref(entry.href || entry.key);
    const count = imagesByHref[lookupKey];
    if (!count) return entry;
    return { ...entry, hasImages: true, imageCount: count };
  };

  if (navEntries.length) {
    return navEntries.map(annotate);
  }

  return items.map((item: any, index: number) => {
    const canonical = resolveSpineHref(spine, item.href) || stripFragment(item.href);
    return annotate({
      key: canonical,
      href: canonical,
      spineIndex: index,
      label: `${index + 1}. ${item.idref || `Chapter ${index + 1}`}`,
    });
  });
}

function buildTocNavigation(
  flatToc: ChapterEntry[],
  spine: any,
  spineByHref: Map<string, number>,
): ChapterEntry[] {
  const entries: Array<ChapterEntry & { rawLabel: string }> = [];
  const seen = new Set<string>();

  for (const item of flatToc) {
    const href = item.href || item.key;
    const baseHref = resolveSpineHref(spine, href) || stripFragment(href);
    const target = resolveDisplayTarget(spine, href) || href;
    const spineIndex = spineByHref.get(normalizeFileHref(baseHref));

    if (!target || spineIndex === undefined) {
      continue;
    }

    const dedupeKey = normalizeChapterKey(target);
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    const rawLabel = (item.label || `Chapter ${entries.length + 1}`).trim();
    entries.push({
      key: target,
      href: target,
      spineIndex,
      level: item.level || 0,
      label: rawLabel,
      rawLabel,
    });
  }

  entries.sort((left, right) => (left.spineIndex || 0) - (right.spineIndex || 0));

  // Decide whether to auto-number: only when the TOC is flat AND labels look like generic
  // "Chapter N" stubs. A hierarchical TOC (any level > 0) or self-numbered labels
  // ("Genesis 1", "John 3:16", "1.2 Foundations") get rendered as-is.
  const hasHierarchy = entries.some((entry) => (entry.level || 0) > 0);
  const labelsLookSelfNumbered = entries.some((entry) => /^[\dIVXLCDM]+[.:\s)]/i.test(entry.rawLabel));
  const shouldAutoNumber = !hasHierarchy && !labelsLookSelfNumbered;

  return entries.map((entry, index) => ({
    key: entry.key,
    href: entry.href,
    spineIndex: entry.spineIndex,
    level: entry.level,
    label: shouldAutoNumber ? `${index + 1}. ${entry.rawLabel}` : entry.rawLabel,
  }));
}

function buildSpineLookup(spine: any): Map<string, number> {
  const lookup = new Map<string, number>();
  const items = spine?.items || [];

  items.forEach((item: any, index: number) => {
    const candidates = [item?.href, item?.url, item?.canonical, item?.idref].filter(Boolean);
    for (const candidate of candidates) {
      lookup.set(normalizeFileHref(candidate), index);
    }
  });

  return lookup;
}

function resolveDisplayTarget(spine: any, href: string | null | undefined): string | null {
  if (!href) return null;
  const fragment = getFragment(href);
  const base = resolveSpineHref(spine, href) || stripFragment(href);
  return base ? (fragment ? `${base}#${fragment}` : base) : String(href);
}

export function resolveSpineHref(spine: any, href: string | null | undefined): string | null {
  if (!spine || !href) return null;
  try {
    const item = spine.get(href);
    if (item?.href) return stripFragment(item.href);
  } catch {
    /* ignore */
  }
  return stripFragment(href);
}

/**
 * Resolves a relocation event to a chapter index.
 *
 * Strategy:
 *   1. If the relocated href carries a fragment, prefer an exact (file + fragment) match.
 *   2. Otherwise, find the chapter whose spineIndex matches the current spine item, *and*
 *      whose anchor we have already passed in the current document (using cfi ordering).
 *   3. Falls back to file-level match, then -1.
 *
 * This means: as the user scrolls past anchors inside a single XHTML file, the highlighted
 * chapter advances correctly — without ever collapsing back to chapter 0 just because the
 * relocated href had its fragment stripped.
 */
export function getChapterIndexForLocation(
  chapters: ChapterEntry[],
  spine: any,
  href: string | null | undefined,
  cfi: string | null | undefined,
): number {
  if (!href || !chapters.length) return -1;

  const fileTarget = normalizeFileHref(href);
  const fragmentTarget = getFragment(href).toLowerCase();

  if (fragmentTarget) {
    const exact = chapters.findIndex((chapter) => normalizeChapterKey(chapter.key) === `${fileTarget}#${fragmentTarget}`);
    if (exact >= 0) return exact;
  }

  let spineIndex: number | null = null;
  if (spine?.get) {
    try {
      const item = spine.get(href);
      if (item && typeof item.index === "number") spineIndex = item.index;
    } catch {
      /* ignore */
    }
  }

  // Chapters that live in this spine item, in document order.
  const chaptersInSpine = chapters
    .map((chapter, index) => ({ chapter, index }))
    .filter(({ chapter }) =>
      spineIndex !== null
        ? chapter.spineIndex === spineIndex
        : normalizeFileHref(chapter.key) === fileTarget,
    );

  if (!chaptersInSpine.length) {
    return chapters.findIndex((chapter) => normalizeFileHref(chapter.key) === fileTarget);
  }

  if (chaptersInSpine.length === 1) return chaptersInSpine[0].index;

  // Multiple anchors in same file: pick the latest one we've passed using cfi comparison if available.
  if (cfi && spine?.get) {
    try {
      const item = spine.get(href);
      const compare: ((a: string, b: string) => number) | undefined = item?.cfiBase
        ? (a: string, b: string) => compareCfi(a, b)
        : undefined;
      if (compare) {
        let best = chaptersInSpine[0];
        for (const candidate of chaptersInSpine) {
          const candidateCfi = (candidate.chapter as any).cfi as string | undefined;
          if (!candidateCfi) continue;
          if (compare(candidateCfi, cfi) <= 0) best = candidate;
        }
        return best.index;
      }
    } catch {
      /* ignore */
    }
  }

  // Fallback: fragment in the relocated href against chapter keys' fragments.
  if (fragmentTarget) {
    const byFragment = chaptersInSpine.find(({ chapter }) =>
      getFragment(chapter.key).toLowerCase() === fragmentTarget,
    );
    if (byFragment) return byFragment.index;
  }

  // Without a way to pick the latest, do not lie — return the *first* chapter in this spine
  // item only if we have no other signal. Caller's `stayedInsideCurrentEntry` guard prevents drift.
  return chaptersInSpine[0].index;
}

/** Best-effort lexical compare for two CFIs in the same spine item. */
function compareCfi(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Backwards-compat: callers used to pass only href. */
export function getChapterIndexForHref(chapters: ChapterEntry[], spine: any, href: string | null | undefined): number {
  return getChapterIndexForLocation(chapters, spine, href, null);
}

export function formatProgressFromLocations(
  chapterIndex: number,
  chapterCount: number,
  locations: any,
  cfi: string | null | undefined,
): number {
  if (locations && cfi) {
    try {
      const fraction = locations.percentageFromCfi(cfi);
      if (Number.isFinite(fraction)) {
        return Math.max(0, Math.min(100, Math.round(fraction * 100)));
      }
    } catch {
      /* fall through to chapter-based estimate */
    }
  }

  if (!chapterCount) return 0;
  return Math.round(((chapterIndex + 1) / chapterCount) * 100);
}
