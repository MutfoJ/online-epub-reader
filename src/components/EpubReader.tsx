import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { BlobReader, TextWriter, ZipReader } from "@zip.js/zip.js";

import {
  buildChaptersFromSpine,
  flattenToc,
  formatProgressFromLocations,
  getChapterIndexForLocation,
  getFragment,
  hrefsMatchFile,
  loadEpubFactory,
  normalizeFileHref,
} from "../lib/epub";
import { normalizeSpeechText, splitParagraphIntoSentences, stripHtml } from "../lib/helpers";
import { getAnalysisConcurrency, getDevicePerformanceProfile } from "../lib/performance";
import { loadEpubLocations, saveEpubLocations } from "../lib/storage";
import type { ChapterEntry, EpubBook, ReaderHandle, ReaderSettings, SearchResult, SpeechSource } from "../types";

interface EpubReaderProps {
  book: EpubBook;
  fileBlob: Blob;
  settings: ReaderSettings;
  onUpdate: (book: EpubBook) => void;
  onReaderStateChange: (payload: {
    sections: ChapterEntry[];
    currentIndex: number;
    progressLabel: string;
    ready?: boolean;
    error?: string | null;
  }) => void;
}

interface EpubSpeechCandidate {
  id: string;
  text: string;
  block: HTMLElement;
}

interface PendingNavigation {
  index: number;
  href: string;
  startedAt: number;
  expiresAt: number;
}

const PENDING_NAV_TIMEOUT_MS = 2500;
const RELOCATED_DEBOUNCE_PERSIST_MS = 650;
const USER_SCROLL_GRACE_MS = 1500;

export const EpubReader = forwardRef<ReaderHandle, EpubReaderProps>(function EpubReader(
  { book, fileBlob, settings, onUpdate, onReaderStateChange },
  ref,
) {
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const renditionRef = useRef<any>(null);
  const epubRef = useRef<any>(null);
  const latestBookRef = useRef(book);
  const settingsRef = useRef(settings);
  const currentIndexRef = useRef(book.reading.chapterIndex || 0);
  const chaptersRef = useRef<ChapterEntry[]>([]);
  const readyRef = useRef(false);
  const displayLockRef = useRef<Promise<boolean> | null>(null);
  const pendingDisplayIndexRef = useRef<number | null>(null);
  const pendingRelocationResolveRef = useRef<(() => void) | null>(null);
  const pendingNavigationRef = useRef<PendingNavigation | null>(null);
  const activeSearchQueryRef = useRef("");
  const persistTimerRef = useRef<number | null>(null);
  const lastSavedReadingRef = useRef<string>("");
  const lastRelocatedCfiRef = useRef<string | null>(book.reading.cfi || null);
  const contentTeardownsRef = useRef<Array<() => void>>([]);
  const lastUserScrollAtRef = useRef<number>(0);
  const handleInternalLinkClickRef = useRef<((href: string) => void) | null>(null);
  const [chapters, setChapters] = useState<ChapterEntry[]>([]);
  const [currentIndex, setCurrentIndex] = useState(book.reading.chapterIndex || 0);
  const [progressLabel, setProgressLabel] = useState(
    book.reading.progress ? `${book.reading.progress}% read` : "Not started",
  );
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const performanceProfile = useMemo(() => getDevicePerformanceProfile(), []);

  const themeStyles = useMemo(() => getEpubThemeStyles(settings), [settings]);

  // Keep refs in sync with the latest props/state without re-running mount.
  useEffect(() => {
    latestBookRef.current = book;
  }, [book]);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  useEffect(() => {
    currentIndexRef.current = currentIndex;
  }, [currentIndex]);
  useEffect(() => {
    chaptersRef.current = chapters;
  }, [chapters]);

  useEffect(() => {
    onReaderStateChange({
      sections: chapters,
      currentIndex,
      progressLabel,
      ready,
      error,
    });
  }, [chapters, currentIndex, error, onReaderStateChange, progressLabel, ready]);

  const flushPersistTimer = useCallback(() => {
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
  }, []);

  const queuePersistReading = useCallback(
    (
      reading: { href: string | null; cfi: string | null; chapterIndex: number; progress: number },
      options: { immediate?: boolean } = {},
    ) => {
      const readingKey = JSON.stringify(reading);
      if (readingKey === lastSavedReadingRef.current) return;

      flushPersistTimer();

      const commit = () => {
        const latestBook = latestBookRef.current;
        lastSavedReadingRef.current = readingKey;
        persistTimerRef.current = null;
        void onUpdate({
          ...latestBook,
          lastOpenedAt: new Date().toISOString(),
          reading: { ...latestBook.reading, ...reading },
        });
      };

      if (options.immediate) {
        commit();
      } else {
        persistTimerRef.current = window.setTimeout(commit, RELOCATED_DEBOUNCE_PERSIST_MS);
      }
    },
    [flushPersistTimer, onUpdate],
  );

  // Mount the EPUB only when the book identity, blob, or flow changes — never on theme.
  useEffect(() => {
    let cancelled = false;
    const teardownContent = () => {
      while (contentTeardownsRef.current.length) {
        const fn = contentTeardownsRef.current.pop();
        try {
          fn?.();
        } catch {
          /* ignore */
        }
      }
    };

    const mount = async () => {
      setReady(false);
      setError(null);
      readyRef.current = false;
      setChapters([]);
      lastRelocatedCfiRef.current = latestBookRef.current.reading.cfi || null;

      if (!viewerRef.current) return;
      viewerRef.current.replaceChildren();

      let ePub: any;
      try {
        ePub = await loadEpubFactory();
      } catch (err) {
        if (!cancelled) setError("Failed to load the EPUB engine.");
        return;
      }

      let epub: any;
      try {
        epub = ePub(fileBlob, { openAs: "binary", replacements: "blobUrl" });
        epubRef.current = epub;
        await epub.ready;
      } catch (err) {
        console.error(err);
        if (!cancelled) setError("This EPUB could not be opened. The file may be corrupted or DRM-protected.");
        return;
      }
      if (cancelled) return;

      const navigation = await epub.loaded.navigation.catch(() => ({ toc: [] }));
      const flatToc = flattenToc(navigation?.toc || []);
      const nextChapters = buildChaptersFromSpine(
        epub.spine,
        flatToc,
        latestBookRef.current.chapterImagesByHref || null,
      );
      if (cancelled) return;
      setChapters(nextChapters);
      chaptersRef.current = nextChapters;

      let rendition: any;
      try {
        rendition = epub.renderTo(viewerRef.current, {
          width: "100%",
          height: "100%",
          flow: settingsRef.current.flow,
          manager: "default",
          spread: "none",
          allowScriptedContent: false,
        });
        renditionRef.current = rendition;
      } catch (err) {
        console.error(err);
        if (!cancelled) setError("Could not render this EPUB in the browser.");
        return;
      }

      rendition.hooks.content.register((contents: any) => {
        applyReaderStyles(contents, settingsRef.current, getEpubThemeStyles(settingsRef.current));
        const scrollTeardown = bridgeContentScroll(contents, () => {
          lastUserScrollAtRef.current = performance.now();
        });
        if (scrollTeardown) contentTeardownsRef.current.push(scrollTeardown);
        const linkTeardown = configureLinkHandling(contents, (href: string) => {
          handleInternalLinkClickRef.current?.(href);
        });
        if (linkTeardown) contentTeardownsRef.current.push(linkTeardown);
      });

      rendition.on("relocated", (location: any) => {
        pendingRelocationResolveRef.current?.();
        pendingRelocationResolveRef.current = null;

        const href = location?.start?.href || null;
        const cfi = location?.start?.cfi || null;
        const pendingNavigation = pendingNavigationRef.current;

        if (cfi && cfi === lastRelocatedCfiRef.current) return;
        lastRelocatedCfiRef.current = cfi;

        // If a navigation is in flight, trust its target while it's valid.
        if (pendingNavigation && href) {
          const fileMatches = hrefsMatchFile(href, pendingNavigation.href);
          const stillValid = performance.now() < pendingNavigation.expiresAt;

          if (!fileMatches && stillValid) return; // stale relocation from earlier display
          if (fileMatches) {
            // We landed in the requested file. Trust pendingNavigation.index — CFI-based
            // resolution can drift to the wrong TOC entry when several entries share a file.
            const targetIndex = pendingNavigation.index;
            const progress = formatProgressFromLocations(
              targetIndex,
              nextChapters.length,
              epub.locations,
              cfi,
            );
            if (targetIndex !== currentIndexRef.current) {
              setCurrentIndex(targetIndex);
              currentIndexRef.current = targetIndex;
            }
            setProgressLabel(progress ? `${progress}% read` : "Not started");
            pendingNavigationRef.current = null;
            queuePersistReading({ href, cfi, chapterIndex: targetIndex, progress });
            return;
          }
          // expired and mismatched — fall through and treat as organic relocation
          pendingNavigationRef.current = null;
        }

        // Organic relocation (user scrolled within the rendition, or external nav).
        const resolvedIndex = getChapterIndexForLocation(nextChapters, epub.spine, href, cfi);
        const currentEntry = nextChapters[currentIndexRef.current];
        const stayedInsideCurrentEntry =
          currentEntry && href && hrefsMatchFile(currentEntry.key, href);

        const chapterIndex =
          resolvedIndex >= 0
            ? resolvedIndex
            : stayedInsideCurrentEntry
              ? currentIndexRef.current
              : currentIndexRef.current;

        const progress = formatProgressFromLocations(
          chapterIndex,
          nextChapters.length,
          epub.locations,
          cfi,
        );

        if (chapterIndex !== currentIndexRef.current) {
          setCurrentIndex(chapterIndex);
          currentIndexRef.current = chapterIndex;
        }
        setProgressLabel(progress ? `${progress}% read` : "Not started");

        queuePersistReading({ href, cfi, chapterIndex, progress });
      });

      // Restore or generate the locations index.
      void hydrateLocations(epub, latestBookRef.current.id, fileBlob.size, performanceProfile).catch(() => {});

      const startBook = latestBookRef.current;
      const startIndex = Math.max(0, Math.min(nextChapters.length - 1, startBook.reading.chapterIndex || 0));
      setCurrentIndex(startIndex);
      currentIndexRef.current = startIndex;

      const initialRendered = await ensureRenditionDisplay(
        rendition,
        getInitialDisplayTarget(startBook, nextChapters, startIndex),
        () => {
          pendingRelocationResolveRef.current = null;
        },
      );
      if (cancelled) return;
      if (!initialRendered) {
        setError("EPUB rendered, but no content was returned. Try a different reader flow.");
        return;
      }

      setReady(true);
      readyRef.current = true;
    };

    mount().catch((err) => {
      console.error(err);
      if (!cancelled) setError("Unexpected error opening this book.");
    });

    return () => {
      cancelled = true;
      teardownContent();
      try {
        renditionRef.current?.destroy?.();
      } catch {
        /* ignore */
      }
      try {
        epubRef.current?.destroy?.();
      } catch {
        /* ignore */
      }
      renditionRef.current = null;
      epubRef.current = null;
      readyRef.current = false;
      displayLockRef.current = null;
      pendingDisplayIndexRef.current = null;
      pendingRelocationResolveRef.current = null;
      pendingNavigationRef.current = null;
      flushPersistTimer();
    };
    // Intentionally narrow: theme/style changes do NOT remount the rendition.
  }, [book.id, fileBlob, settings.flow, flushPersistTimer, performanceProfile, queuePersistReading]);

  // Re-apply styles in place whenever theme/typography changes, without rebuilding the rendition.
  // Snapshot iframe scroll position before the style mutation so reflow doesn't visibly jump.
  useEffect(() => {
    const contentsList = renditionRef.current?.getContents?.() || [];
    const snapshots = contentsList.map((contents: any) => ({
      contents,
      scrollY: Math.max(
        0,
        contents?.window?.scrollY ||
          contents?.document?.documentElement?.scrollTop ||
          0,
      ),
    }));
    for (const contents of contentsList) {
      applyReaderStyles(contents, settings, themeStyles);
    }
    // Restore on the next two frames — first frame applies layout, second frame is when
    // the new line metrics are settled enough to land within a pixel.
    const restore = () => {
      for (const snap of snapshots) {
        if (!snap.scrollY) continue;
        try {
          snap.contents?.window?.scrollTo?.(0, snap.scrollY);
        } catch {
          /* ignore */
        }
      }
    };
    const raf1 = window.requestAnimationFrame(() => {
      restore();
      window.requestAnimationFrame(restore);
    });
    return () => window.cancelAnimationFrame(raf1);
  }, [settings, themeStyles, ready]);

  // Cleanup persist timer on unmount.
  useEffect(() => () => flushPersistTimer(), [flushPersistTimer]);

  const clearHighlights = useCallback(() => {
    const contentsList = renditionRef.current?.getContents?.() || [];
    for (const contents of contentsList) {
      unwrapHighlights(contents.document);
    }
  }, []);

  const displayAt = useCallback(
    async (index: number) => {
      const availableChapters = chaptersRef.current;
      if (!availableChapters.length) return false;
      const boundedIndex = Math.max(0, Math.min(availableChapters.length - 1, index));

      if (displayLockRef.current) {
        pendingDisplayIndexRef.current = boundedIndex;
        return displayLockRef.current;
      }

      const target = availableChapters[boundedIndex];
      if (!readyRef.current || !target || !renditionRef.current) return false;

      const displayPromise = (async () => {
        clearHighlights();
        currentIndexRef.current = boundedIndex;
        setCurrentIndex(boundedIndex);
        lastRelocatedCfiRef.current = null;

        const targetHref = target.href || target.key;
        const startedAt = performance.now();
        pendingNavigationRef.current = {
          index: boundedIndex,
          href: targetHref,
          startedAt,
          expiresAt: startedAt + PENDING_NAV_TIMEOUT_MS,
        };

        const relocated = new Promise<void>((resolve) => {
          pendingRelocationResolveRef.current = resolve;
          window.setTimeout(resolve, PENDING_NAV_TIMEOUT_MS);
        });

        const rendered = await ensureRenditionDisplay(
          renditionRef.current,
          targetHref,
          () => {
            pendingRelocationResolveRef.current = null;
          },
          relocated,
        );

        if (!rendered) {
          pendingNavigationRef.current = null;
          return false;
        }
        scrollRenditionToTop(renditionRef.current);
        if (activeSearchQueryRef.current) {
          highlightSearchInRendition(renditionRef.current, activeSearchQueryRef.current);
        }

        const progress = formatProgressFromLocations(
          boundedIndex,
          availableChapters.length,
          epubRef.current?.locations,
          null,
        );
        setProgressLabel(progress ? `${progress}% read` : "Not started");

        // Chapter-level navigation: persist immediately so a stale debounced write can't echo back.
        queuePersistReading(
          { href: targetHref, cfi: null, chapterIndex: boundedIndex, progress },
          { immediate: true },
        );

        // Belt-and-suspenders: clear any lingering pending nav after the timeout window.
        window.setTimeout(() => {
          const pending = pendingNavigationRef.current;
          if (pending && performance.now() >= pending.expiresAt) {
            pendingNavigationRef.current = null;
          }
        }, PENDING_NAV_TIMEOUT_MS + 100);

        return true;
      })();

      displayLockRef.current = displayPromise;
      try {
        return await displayPromise;
      } finally {
        displayLockRef.current = null;
        const pendingIndex = pendingDisplayIndexRef.current;
        pendingDisplayIndexRef.current = null;
        if (pendingIndex !== null && pendingIndex !== currentIndexRef.current) {
          void displayAt(pendingIndex);
        }
      }
    },
    [clearHighlights, queuePersistReading],
  );

  // Internal-link handler: click <a href="..."> inside the iframe → navigate within the rendition.
  // Cross-file links resolve to a chapter index when possible (so progress + index update cleanly);
  // anchor-bearing links go through rendition.display so the iframe scrolls to the fragment.
  const handleInternalLinkClick = useCallback(
    (href: string) => {
      const rendition = renditionRef.current;
      const epub = epubRef.current;
      if (!rendition) return;

      const chapters = chaptersRef.current;
      const fragment = getFragment(href);

      if (!fragment && chapters.length && epub?.spine) {
        const idx = getChapterIndexForLocation(chapters, epub.spine, href, null);
        if (idx >= 0) {
          void displayAt(idx);
          return;
        }
      }

      // Fragment-bearing or unmapped href: defer to rendition.display so the iframe
      // scrolls to the anchor. The relocated handler then resolves the chapter index.
      pendingNavigationRef.current = null;
      activeSearchQueryRef.current = "";
      try {
        Promise.resolve(rendition.display(href)).catch(() => {});
      } catch {
        /* ignore */
      }
    },
    [displayAt],
  );

  useEffect(() => {
    handleInternalLinkClickRef.current = handleInternalLinkClick;
  }, [handleInternalLinkClick]);

  useImperativeHandle(
    ref,
    () => ({
      getSections: () => chaptersRef.current,
      getCurrentSectionIndex: () => currentIndexRef.current,
      goToSection: displayAt,
      goToNextSection: () => displayAt(currentIndexRef.current + 1),
      goToPrevSection: () => displayAt(currentIndexRef.current - 1),
      searchBook: async (query: string) => {
        const needle = query.trim();
        if (needle.length < 2) return [];
        return searchEpubBlob(fileBlob, chaptersRef.current, needle, book.id);
      },
      goToSearchResult: async (result: SearchResult) => {
        activeSearchQueryRef.current = result.matchText || "";
        const moved = await displayAt(result.sectionIndex);
        if (!moved) return false;
        window.setTimeout(() => {
          highlightSearchInRendition(renditionRef.current, result.matchText);
        }, 180);
        return true;
      },
      clearSearchHighlights: () => {
        activeSearchQueryRef.current = "";
        const contentsList = renditionRef.current?.getContents?.() || [];
        for (const contents of contentsList) {
          const doc = contents?.document as Document | undefined;
          if (doc) clearSearchHighlights(doc);
        }
      },
      getProgressLabel: () => progressLabel,
      getSpeechSource: async (): Promise<SpeechSource | null> => {
        if (!readyRef.current) return null;

        const contents = renditionRef.current?.getContents?.()?.[0];
        const doc = contents?.document as Document | undefined;
        if (!doc?.body) return null;

        const segments = buildSpeechCandidates(doc.body).map((candidate) => ({
          id: candidate.id,
          text: candidate.text,
          highlight: () => {
            unwrapHighlights(doc);
            highlightSentenceWithinBlock(candidate.block, candidate.text, doc);
          },
          scrollIntoView: () => {
            if (performance.now() - lastUserScrollAtRef.current < USER_SCROLL_GRACE_MS) return;
            candidate.block.scrollIntoView({ block: "center", behavior: "smooth" });
          },
        }));

        const activeChapter = chaptersRef.current[currentIndexRef.current];
        return {
          chapterKey: `${book.id}:${activeChapter?.key || currentIndexRef.current}`,
          title: activeChapter?.label || `Chapter ${currentIndexRef.current + 1}`,
          lang: doc.documentElement.lang || navigator.language,
          segments,
          clearHighlights: () => unwrapHighlights(doc),
        };
      },
    }),
    [book.id, displayAt, progressLabel],
  );

  return (
    <div className="reader-surface epub-reader-surface" data-error={error ? "true" : undefined}>
      {error ? (
        <div className="reader-error">
          <h3>Something went wrong</h3>
          <p>{error}</p>
        </div>
      ) : null}
      <div ref={viewerRef} className="epub-canvas" aria-busy={!ready} />
    </div>
  );
});

function getInitialDisplayTarget(book: EpubBook, chapters: ChapterEntry[], startIndex: number): string {
  const target = chapters[startIndex];
  if (!target) return book.reading.cfi || "";

  const savedHref = book.reading.href;
  if (savedHref && hrefsMatchFile(savedHref, target.href || target.key)) {
    return book.reading.cfi || savedHref;
  }
  return target.href || target.key;
}

async function ensureRenditionDisplay(
  rendition: any,
  target: string,
  cleanup: () => void,
  relocated?: Promise<void>,
): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await displayRenditionTarget(rendition, target, cleanup, attempt === 0 ? relocated : undefined);
    if (await waitForRenditionContents(rendition)) return true;
    await new Promise((resolve) => window.setTimeout(resolve, 120));
  }
  return false;
}

async function displayRenditionTarget(
  rendition: any,
  target: string,
  cleanup: () => void,
  relocated?: Promise<void>,
): Promise<void> {
  const displayed = Promise.resolve(rendition.display(target))
    .then(() => undefined)
    .catch(() => undefined);
  const timeout = new Promise<void>((resolve) => window.setTimeout(resolve, 1200));
  await Promise.race([displayed, relocated || timeout, timeout]);
  cleanup();
}

async function waitForRenditionContents(rendition: any): Promise<boolean> {
  const startedAt = performance.now();
  while (performance.now() - startedAt < 800) {
    const contents = rendition?.getContents?.() || [];
    const hasReadableBody = contents.some((content: any) => {
      const body = content?.document?.body;
      return Boolean(body && (body.textContent || "").trim());
    });
    if (hasReadableBody) return true;
    await new Promise((resolve) => window.setTimeout(resolve, 80));
  }
  return false;
}

function bridgeContentScroll(contents: any, onUserScroll?: () => void): (() => void) | null {
  const contentWindow = contents.window as Window | undefined;
  const doc = contents.document as Document | undefined;
  if (!contentWindow || !doc?.documentElement) return null;

  let lastTop = Math.max(0, contentWindow.scrollY || doc.documentElement.scrollTop || 0);
  let ticking = false;

  const emitScrollDirection = () => {
    ticking = false;
    const nextTop = Math.max(0, contentWindow.scrollY || doc.documentElement.scrollTop || 0);
    const scrollHeight = Math.max(doc.documentElement.scrollHeight || 0, doc.body?.scrollHeight || 0);
    const viewportHeight = contentWindow.innerHeight || doc.documentElement.clientHeight || 0;
    const atEnd = scrollHeight > 0 && nextTop + viewportHeight >= scrollHeight - 80;
    const delta = nextTop - lastTop;
    if (Math.abs(delta) > 8) {
      window.dispatchEvent(
        new CustomEvent("reader-content-scroll", {
          detail: { direction: delta > 0 ? "down" : "up", scrollTop: nextTop, atEnd },
        }),
      );
    }
    lastTop = nextTop;
  };

  const handleScroll = () => {
    if (!ticking) {
      ticking = true;
      contentWindow.requestAnimationFrame(emitScrollDirection);
    }
  };

  // Distinguish user-initiated scrolls from programmatic ones by listening to input events.
  const noteUserInput = () => onUserScroll?.();

  contentWindow.addEventListener("scroll", handleScroll, { passive: true });
  contentWindow.addEventListener("wheel", noteUserInput, { passive: true });
  contentWindow.addEventListener("touchstart", noteUserInput, { passive: true });
  contentWindow.addEventListener("keydown", noteUserInput);

  return () => {
    try {
      contentWindow.removeEventListener("scroll", handleScroll);
      contentWindow.removeEventListener("wheel", noteUserInput);
      contentWindow.removeEventListener("touchstart", noteUserInput);
      contentWindow.removeEventListener("keydown", noteUserInput);
    } catch {
      /* ignore */
    }
  };
}

function configureLinkHandling(
  contents: any,
  onInternalCrossFile: (href: string) => void,
): (() => void) | null {
  const doc = contents?.document as Document | undefined;
  if (!doc) return null;

  const handler = (event: MouseEvent) => {
    // Modifier-clicks (Ctrl/Cmd/Shift/middle-click) — let the browser decide.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const anchor = (event.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!anchor) return;

    const rawHref = anchor.getAttribute("href") || "";
    if (!rawHref) return;

    // External: open in a new tab so we never blow away the rendition.
    if (/^(?:https?:|mailto:|tel:|ftp:)/i.test(rawHref)) {
      event.preventDefault();
      event.stopPropagation();
      try {
        window.open(rawHref, "_blank", "noopener,noreferrer");
      } catch {
        /* ignore */
      }
      return;
    }

    // Pure fragment within the current chapter — let the iframe scroll natively.
    if (rawHref.startsWith("#")) return;

    // Cross-file internal navigation.
    event.preventDefault();
    event.stopPropagation();
    onInternalCrossFile(rawHref);
  };

  // Capture phase so we run before epub.js's own link handler (which would otherwise treat
  // every href as a relative spine path, including external ones).
  doc.addEventListener("click", handler, true);
  return () => {
    try {
      doc.removeEventListener("click", handler, true);
    } catch {
      /* ignore */
    }
  };
}

function scrollRenditionToTop(rendition: any): void {
  try {
    const contentsList = rendition?.getContents?.() || [];
    for (const contents of contentsList) {
      contents?.window?.scrollTo?.(0, 0);
      contents?.document?.documentElement?.scrollTo?.(0, 0);
    }
  } catch {
    /* ignore */
  }
  window.scrollTo({ top: 0, behavior: "auto" });
}

function highlightSearchInRendition(rendition: any, query: string): void {
  const needle = normalizeSpeechText(query).toLowerCase();
  if (!needle) return;

  try {
    const contentsList = rendition?.getContents?.() || [];
    for (const contents of contentsList) {
      const doc = contents?.document as Document | undefined;
      if (!doc?.body) continue;
      clearSearchHighlights(doc);

      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          return node.nodeValue?.toLowerCase().includes(needle)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        },
      });

      const textNode = walker.nextNode() as Text | null;
      if (!textNode?.nodeValue) continue;
      const index = textNode.nodeValue.toLowerCase().indexOf(needle);
      if (index < 0) continue;

      const range = doc.createRange();
      range.setStart(textNode, index);
      range.setEnd(textNode, index + needle.length);
      const marker = doc.createElement("mark");
      marker.className = "search-active";
      marker.appendChild(range.extractContents());
      range.insertNode(marker);
      marker.scrollIntoView({ block: "center", behavior: "smooth" });
      break;
    }
  } catch {
    /* ignore */
  }
}

function clearSearchHighlights(doc: Document): void {
  doc.querySelectorAll(".search-active").forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  });
}

async function hydrateLocations(
  epub: any,
  bookId: string,
  fileSize: number,
  profile = getDevicePerformanceProfile(),
): Promise<void> {
  if (!epub.locations || typeof epub.locations.load !== "function") return;
  const cached = await loadEpubLocations(bookId);
  if (cached) {
    try {
      epub.locations.load(cached);
      return;
    } catch {
      /* fall through and regenerate */
    }
  }
  if (profile.constrained) return;
  const maxGeneratedSize = profile.constrained ? 12 * 1024 * 1024 : 40 * 1024 * 1024;
  if (fileSize <= maxGeneratedSize && typeof epub.locations.generate === "function") {
    try {
      await epub.locations.generate(1200);
      const serialized = typeof epub.locations.save === "function" ? epub.locations.save() : null;
      if (serialized) await saveEpubLocations(bookId, serialized);
    } catch {
      /* ignore */
    }
  }
}

// Per-book search-text cache. First query for a book pays the decode + strip cost; every
// subsequent query reuses the lowercased text. Cleared when a different book is opened.
let searchCacheBookId: string | null = null;
let searchCacheChapters: Array<{ index: number; href: string; label: string; text: string; lowerText: string }> | null =
  null;

async function buildSearchCache(
  fileBlob: Blob,
  chapters: ChapterEntry[],
): Promise<NonNullable<typeof searchCacheChapters>> {
  const reader = new ZipReader(new BlobReader(fileBlob));
  try {
    const entries = await reader.getEntries();
    const lookupEntry = buildZipEntryLookup(entries);
    const uniqueChapterFiles: Array<{ chapter: ChapterEntry; index: number; href: string; entry: any }> = [];
    const seenFiles = new Set<string>();

    for (let i = 0; i < chapters.length; i += 1) {
      const chapter = chapters[i];
      const href = chapter.href || chapter.key;
      const entry = lookupEntry(href);
      if (!entry?.getData) continue;
      const fileKey = normalizeFileHref(entry.filename || href);
      if (!fileKey || seenFiles.has(fileKey)) continue;
      seenFiles.add(fileKey);
      uniqueChapterFiles.push({ chapter, index: i, href, entry });
    }

    const built = await mapLimit(uniqueChapterFiles, getAnalysisConcurrency(), async ({ chapter, index, href, entry }) => {
      try {
        const raw = await entry.getData(new TextWriter());
        const text = normalizeSpeechText(stripHtml(raw));
        if (!text) return null;
        return {
          index,
          href,
          label: chapter.label.replace(/^\d+\.\s*/, ""),
          text,
          lowerText: text.toLowerCase(),
        };
      } catch {
        return null;
      }
    });

    return built
      .filter((entry): entry is NonNullable<(typeof built)[number]> => Boolean(entry))
      .sort((left, right) => left.index - right.index);
  } finally {
    await reader.close().catch(() => {});
  }
}

function buildZipEntryLookup(entries: any[]): (href: string) => any | null {
  const suffixes = new Map<string, any | null>();

  for (const entry of entries) {
    if (entry.directory) continue;
    const normalized = normalizeFileHref(entry.filename);
    if (!normalized) continue;

    const parts = normalized.split("/").filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      const suffix = parts.slice(index).join("/");
      const previous = suffixes.get(suffix);
      if (previous === undefined) {
        suffixes.set(suffix, entry);
      } else if (previous !== entry) {
        suffixes.set(suffix, null);
      }
    }
  }

  return (href) => {
    const normalized = normalizeFileHref(href);
    const parts = normalized.split("/").filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      const match = suffixes.get(parts.slice(index).join("/"));
      if (match) return match;
    }
    return null;
  };
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let completed = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index], index);
        completed += 1;
        if (completed % 12 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    }),
  );

  return results;
}

async function searchEpubBlob(
  fileBlob: Blob,
  chapters: ChapterEntry[],
  query: string,
  bookId: string,
): Promise<SearchResult[]> {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];

  if (searchCacheBookId !== bookId || !searchCacheChapters) {
    searchCacheChapters = await buildSearchCache(fileBlob, chapters);
    searchCacheBookId = bookId;
  }

  const results: SearchResult[] = [];
  const needleLength = Math.max(1, needle.length);

  for (const cached of searchCacheChapters) {
    if (results.length >= 120) break;
    let fromIndex = 0;
    while (results.length < 120) {
      const matchIndex = cached.lowerText.indexOf(needle, fromIndex);
      if (matchIndex < 0) break;
      const start = Math.max(0, matchIndex - 80);
      const end = Math.min(cached.text.length, matchIndex + needle.length + 110);
      results.push({
        id: `${cached.index}:${matchIndex}`,
        sectionIndex: cached.index,
        sectionLabel: cached.label,
        excerpt: `${start > 0 ? "..." : ""}${cached.text.slice(start, end).trim()}${end < cached.text.length ? "..." : ""}`,
        matchText: cached.text.slice(matchIndex, matchIndex + needle.length),
        source: cached.href,
      });
      fromIndex = matchIndex + needleLength;
    }
  }
  return results;
}

function buildSpeechCandidates(root: HTMLElement): EpubSpeechCandidate[] {
  const selectors = "p, li, blockquote, h1, h2, h3, h4, h5, h6";
  return [...root.querySelectorAll<HTMLElement>(selectors)]
    .filter((block) => !block.querySelector(selectors))
    .map((block, blockIndex) => {
      const text = normalizeSpeechText(block.textContent || "");
      if (!text) return [];
      return splitParagraphIntoSentences(text).map((sentence, sentenceIndex) => ({
        id: `epub-segment-${blockIndex}-${sentenceIndex}`,
        text: sentence,
        block,
      }));
    })
    .flat();
}

function unwrapHighlights(doc: Document): void {
  doc.querySelectorAll(".speech-active").forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  });
}

function applyReaderStyles(
  contents: any,
  settings: ReaderSettings,
  themeStyles: ReturnType<typeof getEpubThemeStyles>,
): void {
  contents.addStylesheetRules({
    body: {
      margin: "0 auto",
      "max-width": `${settings.maxWidth}px`,
      padding: "1.35rem 0 6rem 0",
      background: themeStyles.page,
      color: themeStyles.text,
      "font-size": `${settings.fontSize}px`,
      "line-height": `${settings.lineHeight}`,
      "overflow-wrap": "anywhere",
    },
    img: { "max-width": "100%", height: "auto" },
    ".speech-active": {
      background: themeStyles.highlight,
      color: "inherit",
      "border-radius": "0.3em",
      "box-shadow": `0 0 0 2px ${themeStyles.ring}`,
    },
    ".search-active": {
      background: "rgba(255, 214, 102, 0.55)",
      color: "inherit",
      "border-radius": "0.3em",
      "box-shadow": "0 0 0 2px rgba(255, 184, 28, 0.25)",
    },
  });

  try {
    contents.document.documentElement.setAttribute("translate", "yes");
  } catch {
    /* ignore */
  }
}

function highlightSentenceWithinBlock(block: HTMLElement, text: string, doc: Document): void {
  const range = findRangeInElement(block, text, doc);
  if (!range) {
    block.classList.add("speech-active");
    return;
  }
  const extracted = range.extractContents();
  const marker = doc.createElement("mark");
  marker.className = "speech-active";
  marker.appendChild(extracted);
  range.insertNode(marker);
  // Wrapping the range mutates text nodes — drop the cache so the next call rebuilds.
  blockTextIndexCache.delete(block);
}

interface BlockTextIndex {
  combined: string;
  positions: Array<{ node: Text; offset: number }>;
}

// Position maps are reused across every sentence highlight within a block, so cache them
// against the element identity. WeakMap entries vanish automatically when the iframe unloads.
const blockTextIndexCache = new WeakMap<HTMLElement, BlockTextIndex>();

function buildBlockTextIndex(element: HTMLElement, doc: Document): BlockTextIndex {
  const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.nodeValue?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const positions: Array<{ node: Text; offset: number }> = [];
  let combined = "";
  let previousWasSpace = true;
  let current: Node | null;

  while ((current = walker.nextNode())) {
    const textNode = current as Text;
    const raw = textNode.nodeValue || "";
    for (let index = 0; index < raw.length; index += 1) {
      const character = raw[index];
      const isSpace = character === " " || character === "\t" || character === "\n" || character === "\r";
      if (isSpace) {
        if (!previousWasSpace) {
          combined += " ";
          positions.push({ node: textNode, offset: index });
          previousWasSpace = true;
        }
      } else {
        combined += character.toLowerCase();
        positions.push({ node: textNode, offset: index });
        previousWasSpace = false;
      }
    }
  }
  return { combined, positions };
}

function findRangeInElement(element: HTMLElement, text: string, doc: Document): Range | null {
  const normalizedTarget = normalizeSpeechText(text).toLowerCase();
  if (!normalizedTarget) return null;

  let index = blockTextIndexCache.get(element);
  if (!index) {
    index = buildBlockTextIndex(element, doc);
    blockTextIndexCache.set(element, index);
  }

  const startIndex = index.combined.indexOf(normalizedTarget);
  if (startIndex < 0) return null;

  const start = index.positions[startIndex];
  const end = index.positions[startIndex + normalizedTarget.length - 1];
  if (!start || !end) return null;

  const range = doc.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset + 1);
  return range;
}

function getEpubThemeStyles(settings: ReaderSettings) {
  const map = {
    mist: {
      page: "#eff4fb",
      text: "#233345",
      highlight: "rgba(46, 110, 164, 0.18)",
      ring: "rgba(46, 110, 164, 0.16)",
    },
    paper: {
      page: "#fbfaf4",
      text: "#252522",
      highlight: "rgba(20, 90, 88, 0.18)",
      ring: "rgba(20, 90, 88, 0.16)",
    },
    sepia: {
      page: "#ead9bf",
      text: "#2f2417",
      highlight: "rgba(166, 90, 42, 0.18)",
      ring: "rgba(166, 90, 42, 0.16)",
    },
    night: {
      page: "#171818",
      text: "#ebe3d6",
      highlight: "rgba(255, 179, 71, 0.24)",
      ring: "rgba(255, 179, 71, 0.2)",
    },
  } as const;
  return map[settings.theme];
}
