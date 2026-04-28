import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import { sectionEntriesFromTxt, splitParagraphIntoSentences } from "../lib/helpers";
import type { ReaderHandle, SearchResult, SpeechSource, TxtBook } from "../types";

interface RenderedSentence {
  id: string;
  text: string;
}

interface RenderedBlock {
  id: string;
  text: string;
  sentences: RenderedSentence[];
}

interface TextReaderProps {
  book: TxtBook;
  onUpdate: (book: TxtBook) => void;
  onReaderStateChange: (payload: { sections: { key: string; label: string }[]; currentIndex: number; progressLabel: string; ready?: boolean }) => void;
}

export const TextReader = forwardRef<ReaderHandle, TextReaderProps>(function TextReader(
  { book, onUpdate, onReaderStateChange },
  ref,
) {
  const [sectionIndex, setSectionIndex] = useState(book.reading.sectionIndex || 0);
  const sentenceRefs = useRef(new Map<string, HTMLSpanElement>());
  const paragraphRefs = useRef(new Map<string, HTMLParagraphElement>());
  const sectionIndexRef = useRef(sectionIndex);
  const bookIdRef = useRef(book.id);

  // Reset only when the book identity actually changes — *not* on every persisted reading echo.
  // (Listening to book.reading.sectionIndex caused a race where a stale onUpdate could clobber
  //  a more recent local navigation.)
  useEffect(() => {
    if (bookIdRef.current === book.id) return;
    bookIdRef.current = book.id;
    const nextIndex = Math.max(0, Math.min(book.sections.length - 1, book.reading.sectionIndex || 0));
    setSectionIndex(nextIndex);
    sectionIndexRef.current = nextIndex;
  }, [book.id, book.reading.sectionIndex, book.sections.length]);

  useEffect(() => {
    sectionIndexRef.current = sectionIndex;
  }, [sectionIndex]);

  const sections = book.sections;
  const safeSectionIndex = Math.max(0, Math.min(sections.length - 1, sectionIndex));
  const currentSection = sections[safeSectionIndex];
  const entries = useMemo(() => sectionEntriesFromTxt(sections), [sections]);

  const renderedBlocks = useMemo<RenderedBlock[]>(() => {
    if (!currentSection) return [];
    return currentSection.blocks.map((block) => {
      const pieces = splitParagraphIntoSentences(block.text);
      return {
        id: block.id,
        text: block.text,
        sentences: pieces.map((text, index) => ({
          id: `${block.id}-s${index}`,
          text,
        })),
      };
    });
  }, [currentSection]);

  useEffect(() => {
    onReaderStateChange({
      sections: entries,
      currentIndex: safeSectionIndex,
      progressLabel: `${safeSectionIndex + 1} / ${sections.length} sections`,
      ready: true,
    });
  }, [entries, onReaderStateChange, safeSectionIndex, sections.length]);

  const clearHighlights = () => {
    sentenceRefs.current.forEach((element) => element.classList.remove("sentence-active"));
    paragraphRefs.current.forEach((element) => element.classList.remove("search-active-block"));
  };

  const updateReading = (nextIndex: number) => {
    const progress = Math.round(((nextIndex + 1) / Math.max(1, sections.length)) * 100);
    onUpdate({
      ...book,
      lastOpenedAt: new Date().toISOString(),
      reading: {
        sectionIndex: nextIndex,
        progress,
      },
    });
  };

  const goToSection = async (nextIndex: number) => {
    if (nextIndex < 0 || nextIndex >= sections.length) {
      return false;
    }
    clearHighlights();
    setSectionIndex(nextIndex);
    sectionIndexRef.current = nextIndex;
    updateReading(nextIndex);
    window.scrollTo({ top: 0, behavior: "smooth" });
    return true;
  };

  const searchBook = async (query: string): Promise<SearchResult[]> => {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) {
      return [];
    }

    const results: SearchResult[] = [];
    for (const [index, section] of sections.entries()) {
      for (const block of section.blocks) {
        const haystack = block.text.toLowerCase();
        let fromIndex = 0;
        while (results.length < 120) {
          const matchIndex = haystack.indexOf(needle, fromIndex);
          if (matchIndex < 0) {
            break;
          }

          const start = Math.max(0, matchIndex - 70);
          const end = Math.min(block.text.length, matchIndex + needle.length + 90);
          results.push({
            id: `${section.id}:${block.id}:${matchIndex}`,
            sectionIndex: index,
            sectionLabel: section.label,
            excerpt: `${start > 0 ? "..." : ""}${block.text.slice(start, end).trim()}${end < block.text.length ? "..." : ""}`,
            matchText: block.text.slice(matchIndex, matchIndex + needle.length),
            source: block.id,
          });
          fromIndex = matchIndex + Math.max(1, needle.length);
        }
        if (results.length >= 120) {
          return results;
        }
      }
    }
    return results;
  };

  const goToSearchResult = async (result: SearchResult) => {
    const moved = await goToSection(result.sectionIndex);
    if (!moved) {
      return false;
    }
    window.setTimeout(() => {
      const block = result.source ? paragraphRefs.current.get(result.source) : null;
      if (block) {
        paragraphRefs.current.forEach((element) => element.classList.remove("search-active-block"));
        block.classList.add("search-active-block");
        block.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }, 120);
    return true;
  };

  useImperativeHandle(ref, () => ({
    getSections: () => entries,
    getCurrentSectionIndex: () => sectionIndexRef.current,
    goToSection,
    goToNextSection: () => goToSection(sectionIndexRef.current + 1),
    goToPrevSection: () => goToSection(sectionIndexRef.current - 1),
    searchBook,
    goToSearchResult,
    clearSearchHighlights: () => {
      paragraphRefs.current.forEach((element) => element.classList.remove("search-active-block"));
    },
    getProgressLabel: () => `${sectionIndexRef.current + 1} / ${sections.length} sections`,
    getSpeechSource: async (): Promise<SpeechSource | null> => {
      const section = sections[sectionIndexRef.current];
      if (!section) {
        return null;
      }

      const speechBlocks: RenderedBlock[] = section.blocks.map((block) => {
        const pieces = splitParagraphIntoSentences(block.text);
        return {
          id: block.id,
          text: block.text,
          sentences: pieces.map((text, index) => ({
            id: `${block.id}-s${index}`,
            text,
          })),
        };
      });

      return {
        chapterKey: `${book.id}:${section.id}`,
        title: section.label,
        segments: speechBlocks.flatMap((block) =>
          block.sentences.map((sentence) => ({
            id: sentence.id,
            text: sentence.text,
            highlight: () => {
              clearHighlights();
              const element = sentenceRefs.current.get(sentence.id);
              element?.classList.add("sentence-active");
            },
            scrollIntoView: () => {
              sentenceRefs.current.get(sentence.id)?.scrollIntoView({
                block: "center",
                behavior: "smooth",
              });
            },
          })),
        ),
        clearHighlights,
      };
    },
  }), [book, entries, sections]);

  if (!currentSection) {
    return <div className="reader-surface">No section available.</div>;
  }

  return (
    <article className="reader-surface text-reader-surface">
      <header className="section-banner">
        <p className="eyebrow">Section</p>
        <h2>{currentSection.label}</h2>
      </header>

      <div className="reader-copy">
        {renderedBlocks.map((block) => (
          <p
            key={block.id}
            ref={(node) => {
              if (node) {
                paragraphRefs.current.set(block.id, node);
              } else {
                paragraphRefs.current.delete(block.id);
              }
            }}
            className="reader-paragraph"
          >
            {block.sentences.map((sentence) => (
              <span
                key={sentence.id}
                ref={(node) => {
                  if (node) {
                    sentenceRefs.current.set(sentence.id, node);
                  } else {
                    sentenceRefs.current.delete(sentence.id);
                  }
                }}
                className="reader-sentence"
              >
                {sentence.text}{" "}
              </span>
            ))}
          </p>
        ))}
      </div>
    </article>
  );
});
