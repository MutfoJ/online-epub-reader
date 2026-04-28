import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { useBooks, useSettings } from "../app/AppStore";
import { formatBookType, getProgressLabel, sectionEntriesFromTxt, truncateText } from "../lib/helpers";
import type { ChapterEntry, LibraryBook, ReaderHandle, ReaderSettings, SearchResult } from "../types";
import { EpubReader } from "./EpubReader";
import { TextReader } from "./TextReader";

type PanelName = "chapters" | "search" | "audio" | "settings" | null;
type SpeechState = "idle" | "playing" | "paused";

interface ReaderState {
  sections: ChapterEntry[];
  currentIndex: number;
  progressLabel: string;
  ready: boolean;
  error: string | null;
}

export function ReaderPage() {
  const { bookId = "" } = useParams();
  const navigate = useNavigate();
  const { books, getBookBlob, updateBook } = useBooks();
  const { settings, updateSettings } = useSettings();

  const readerRef = useRef<ReaderHandle | null>(null);
  const settingsRef = useRef(settings);
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const sectionMoveRef = useRef(false);
  const speechRef = useRef({
    token: 0,
    source: null as Awaited<ReturnType<ReaderHandle["getSpeechSource"]>> | null,
    segmentIndex: 0,
    charOffset: 0,
    utterance: null as SpeechSynthesisUtterance | null,
  });

  const book = useMemo(() => books.find((entry) => entry.id === bookId) || null, [books, bookId]);
  const initialReaderState = useCallback(
    (b: LibraryBook | null): ReaderState => ({
      sections: [],
      currentIndex: b
        ? b.type === "txt"
          ? b.reading.sectionIndex || 0
          : b.reading.chapterIndex || 0
        : 0,
      progressLabel: b ? getProgressLabel(b) : "Not started",
      ready: b?.type === "txt",
      error: null,
    }),
    [],
  );

  const [fileBlob, setFileBlob] = useState<Blob | null>(null);
  const [fileBlobError, setFileBlobError] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelName>(null);
  const [readerState, setReaderState] = useState<ReaderState>(() => initialReaderState(book));
  const [speechSupported] = useState(
    typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window,
  );
  const [speechState, setSpeechState] = useState<SpeechState>("idle");
  const [speechVoices, setSpeechVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [speechStatus, setSpeechStatus] = useState("Read aloud uses the browser voice on this device.");
  const [speechCurrentText, setSpeechCurrentText] = useState("");
  const [speechProgress, setSpeechProgress] = useState(0);
  const [speechIndex, setSpeechIndex] = useState(0);
  const [speechTotal, setSpeechTotal] = useState(0);
  const [speechSegments, setSpeechSegments] = useState<{ value: number; label: string }[]>([]);
  const [selectedSpeechSegment, setSelectedSpeechSegment] = useState(0);
  const [headerHidden, setHeaderHidden] = useState(false);
  const [isNavigatingSection, setIsNavigatingSection] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchStatus, setSearchStatus] = useState("Search the current book.");
  const [searching, setSearching] = useState(false);

  const togglePanel = useCallback((name: Exclude<PanelName, null>) => {
    setPanel((current) => (current === name ? null : name));
  }, []);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    voicesRef.current = speechVoices;
  }, [speechVoices]);

  useEffect(() => {
    if (!book) return;
    let cancelled = false;
    setFileBlobError(null);
    getBookBlob(book.id)
      .then((blob) => {
        if (cancelled) return;
        if (!blob && book.type === "epub") {
          setFileBlobError("This book's file isn't in local storage anymore. Re-import it from your device.");
        }
        setFileBlob(blob);
      })
      .catch(() => {
        if (cancelled) return;
        setFileBlob(null);
        setFileBlobError("Could not read this book from local storage.");
      });
    return () => {
      cancelled = true;
    };
  }, [book?.id, book?.type, getBookBlob]);

  // Reset reader state when navigating to a different book — but seed currentIndex from saved progress
  // so the UI never flashes "chapter 1" for a book that should resume mid-way.
  useEffect(() => {
    setReaderState(initialReaderState(book));
    setPanel(null);
  }, [book?.id, initialReaderState]);

  useEffect(() => {
    if (!speechSupported) return;
    const updateVoices = () => setSpeechVoices(window.speechSynthesis.getVoices() || []);
    updateVoices();
    window.speechSynthesis.addEventListener?.("voiceschanged", updateVoices);
    return () => {
      window.speechSynthesis.removeEventListener?.("voiceschanged", updateVoices);
    };
  }, [speechSupported]);

  // Cleanup speech on unmount.
  useEffect(() => () => stopSpeechInternal(speechRef, speechSupported), [speechSupported]);

  useEffect(() => {
    let lastY = Math.max(0, window.scrollY);
    let ticking = false;

    const updateHeaderVisibility = () => {
      ticking = false;
      const nextY = Math.max(0, window.scrollY);
      const delta = nextY - lastY;
      const doc = document.documentElement;
      const atEnd = window.innerHeight + nextY >= Math.max(doc.scrollHeight, document.body.scrollHeight) - 80;
      if (nextY < 28 || atEnd) setHeaderHidden(false);
      else if (delta > 8 && !panel) setHeaderHidden(true);
      else if (delta < -8) setHeaderHidden(false);
      lastY = nextY;
    };

    const handleScroll = () => {
      if (!ticking) {
        ticking = true;
        window.requestAnimationFrame(updateHeaderVisibility);
      }
    };

    const handleReaderContentScroll = (event: Event) => {
      const detail = (event as CustomEvent<{ direction?: "up" | "down"; scrollTop?: number; atEnd?: boolean }>).detail;
      const direction = detail?.direction;
      const scrollTop = detail?.scrollTop || 0;
      if (scrollTop < 28 || direction === "up" || detail?.atEnd || panel) setHeaderHidden(false);
      else if (direction === "down") setHeaderHidden(true);
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("reader-content-scroll", handleReaderContentScroll);
    return () => {
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("reader-content-scroll", handleReaderContentScroll);
    };
  }, [panel]);

  useEffect(() => {
    if (panel) setHeaderHidden(false);
  }, [panel]);

  // Clear lingering search highlights as soon as the search panel closes so they don't
  // re-appear when the user moves between chapters or starts audio.
  useEffect(() => {
    if (panel !== "search") {
      readerRef.current?.clearSearchHighlights?.();
    }
  }, [panel]);

  const handleReaderStateChange = useCallback(
    (payload: {
      sections: ChapterEntry[];
      currentIndex: number;
      progressLabel: string;
      ready?: boolean;
      error?: string | null;
    }) => {
      setReaderState((current) => ({
        sections: payload.sections.length ? payload.sections : current.sections,
        currentIndex: payload.currentIndex,
        progressLabel: payload.progressLabel || current.progressLabel,
        ready: payload.ready ?? current.ready,
        error: payload.error ?? current.error,
      }));
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const query = searchQuery.trim();
    if (panel !== "search") return;

    if (query.length < 2) {
      setSearchResults([]);
      setSearchStatus("Type at least 2 characters.");
      setSearching(false);
      return;
    }

    setSearching(true);
    setSearchStatus("Searching...");
    const timer = window.setTimeout(() => {
      readerRef.current
        ?.searchBook(query)
        .then((results) => {
          if (cancelled) return;
          setSearchResults(results);
          setSearchStatus(results.length ? `${results.length} result${results.length === 1 ? "" : "s"}.` : "No matches found.");
        })
        .catch(() => {
          if (cancelled) return;
          setSearchResults([]);
          setSearchStatus("Search failed for this book.");
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 220);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [panel, searchQuery, readerState.currentIndex, readerState.ready]);

  const handleBookUpdate = useCallback(
    async (nextBook: LibraryBook) => {
      await updateBook(nextBook);
    },
    [updateBook],
  );

  const stopSpeech = useCallback(
    (resetStatus = true) => {
      stopSpeechInternal(speechRef, speechSupported);
      setSpeechState("idle");
      setSpeechProgress(0);
      setSpeechIndex(0);
      setSpeechTotal(0);
      setSpeechCurrentText("");
      if (resetStatus) {
        setSpeechStatus("Read aloud uses the browser voice on this device.");
      }
    },
    [speechSupported],
  );

  const resetSpeechSourceState = useCallback(() => {
    setSpeechSegments([]);
    setSelectedSpeechSegment(0);
  }, []);

  const goToSection = useCallback(
    async (index: number, closePanel = true) => {
      const reader = readerRef.current;
      if (!reader || sectionMoveRef.current) return;
      const sections = reader.getSections();
      if (!sections.length) return;
      const nextIndex = Math.max(0, Math.min(sections.length - 1, index));
      sectionMoveRef.current = true;
      setIsNavigatingSection(true);
      try {
        const moved = await reader.goToSection(nextIndex);
        if (moved) {
          stopSpeech(true);
          resetSpeechSourceState();
          if (closePanel) setPanel(null);
          setHeaderHidden(false);
          window.scrollTo({ top: 0, behavior: "auto" });
        }
      } finally {
        sectionMoveRef.current = false;
        setIsNavigatingSection(false);
      }
    },
    [resetSpeechSourceState, stopSpeech],
  );

  const stepSection = useCallback(
    async (delta: number) => {
      const reader = readerRef.current;
      if (!reader || sectionMoveRef.current) return;
      const sections = reader.getSections();
      const currentIndex = reader.getCurrentSectionIndex();
      const nextIndex = Math.max(0, Math.min(sections.length - 1, currentIndex + delta));
      if (nextIndex === currentIndex) return;
      await goToSection(nextIndex, false);
    },
    [goToSection],
  );

  const prepareSpeechSource = useCallback(
    async (force = false) => {
      if (!speechSupported || !readerRef.current) return null;
      const source =
        speechRef.current.source && !force
          ? speechRef.current.source
          : await readerRef.current.getSpeechSource();

      if (!source || !source.segments.length) {
        setSpeechStatus("No readable chapter text was found for read aloud.");
        setSpeechSegments([]);
        setSpeechTotal(0);
        return null;
      }

      speechRef.current.source = source;
      setSpeechTotal(source.segments.length);
      setSpeechSegments(
        source.segments.map((segment, index) => ({
          value: index,
          label: `${index + 1}. ${truncateText(segment.text, 74)}`,
        })),
      );
      setSelectedSpeechSegment((current) => Math.max(0, Math.min(source.segments.length - 1, current)));
      return source;
    },
    [speechSupported],
  );

  const speakSegment = useCallback(
    async (
      token: number,
      source: NonNullable<typeof speechRef.current.source>,
      segmentIndex: number,
      charOffset: number,
      rateOverride?: number,
    ) => {
      const segment = source.segments[segmentIndex];
      if (!segment || token !== speechRef.current.token) return;

      speechRef.current.segmentIndex = segmentIndex;
      speechRef.current.charOffset = charOffset;
      setSelectedSpeechSegment(segmentIndex);

      segment.highlight();
      segment.scrollIntoView();

      setSpeechCurrentText(segment.text);
      setSpeechIndex(segmentIndex + 1);
      setSpeechTotal(source.segments.length);
      setSpeechProgress(
        (segmentIndex + charOffset / Math.max(1, segment.text.length)) /
          Math.max(1, source.segments.length),
      );
      setSpeechStatus(`Reading aloud ${segmentIndex + 1}/${source.segments.length}.`);

      const utterance = new SpeechSynthesisUtterance(segment.text.slice(charOffset));
      speechRef.current.utterance = utterance;
      const latestSettings = settingsRef.current;
      const preferredVoice = getPreferredVoice(voicesRef.current, latestSettings.speechVoiceURI);
      utterance.rate = rateOverride ?? latestSettings.speechRate;
      utterance.lang = preferredVoice?.lang || source.lang || navigator.language;
      if (preferredVoice) utterance.voice = preferredVoice;

      utterance.onboundary = (event) => {
        if (token !== speechRef.current.token) return;
        speechRef.current.charOffset = charOffset + (event.charIndex || 0);
        setSpeechProgress(
          (segmentIndex + speechRef.current.charOffset / Math.max(1, segment.text.length)) /
            Math.max(1, source.segments.length),
        );
      };

      utterance.onend = () => {
        if (token !== speechRef.current.token) return;
        const nextIndex = segmentIndex + 1;
        if (nextIndex < source.segments.length) {
          void speakSegment(token, source, nextIndex, 0);
          return;
        }
        if (settingsRef.current.speechAutoContinue) {
          const movePromise = readerRef.current?.goToNextSection();
          if (!movePromise) {
            stopSpeech(false);
            setSpeechStatus("Chapter audio finished.");
            return;
          }
          void movePromise.then((moved) => {
            if (!moved) {
              stopSpeech(false);
              setSpeechStatus("Chapter audio finished.");
              return;
            }
            speechRef.current.source = null;
            resetSpeechSourceState();
            window.setTimeout(() => {
              void startSpeechRef.current?.(false, rateOverride);
            }, 180);
          });
          return;
        }
        stopSpeech(false);
        setSpeechStatus("Chapter audio finished.");
      };

      utterance.onerror = () => {
        stopSpeech(false);
        setSpeechStatus("Read aloud failed in this browser for this chapter.");
      };

      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    },
    [resetSpeechSourceState, stopSpeech],
  );

  const startSpeechRef = useRef<((resume?: boolean, rateOverride?: number) => Promise<void>) | null>(null);
  const startSpeech = useCallback(
    async (resume = false, rateOverride?: number) => {
      if (!speechSupported || !readerRef.current) return;
      const source = await prepareSpeechSource(!resume);
      if (!source) return;
      speechRef.current.token += 1;
      const token = speechRef.current.token;
      const startIndex = resume
        ? speechRef.current.segmentIndex
        : Math.max(0, Math.min(source.segments.length - 1, selectedSpeechSegment));
      const startOffset = resume ? speechRef.current.charOffset : 0;
      setSpeechState("playing");
      void speakSegment(token, source, startIndex, startOffset, rateOverride);
    },
    [prepareSpeechSource, selectedSpeechSegment, speakSegment, speechSupported],
  );
  startSpeechRef.current = startSpeech;

  // Pause = cancel synthesis (avoiding flaky speechSynthesis.pause/resume) while preserving
  // segmentIndex + charOffset so resume continues exactly where the boundary event last reported.
  const pauseSpeech = useCallback(() => {
    if (!speechSupported) return;
    speechRef.current.token += 1; // invalidate any in-flight onend/onboundary callbacks
    speechRef.current.utterance = null;
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
    setSpeechState("paused");
    setSpeechStatus("Read aloud paused.");
  }, [speechSupported]);

  const toggleSpeech = useCallback(async () => {
    if (!speechSupported) return;
    if (speechState === "playing") {
      pauseSpeech();
      return;
    }
    // Resume from saved segment/offset if we have a source; otherwise fresh start.
    const hasSource = Boolean(speechRef.current.source);
    await startSpeech(speechState === "paused" && hasSource);
  }, [pauseSpeech, speechState, speechSupported, startSpeech]);

  const changeSpeechRate = useCallback(
    async (nextRate: number) => {
      const clamped = Math.max(0.7, Math.min(4, Number(nextRate.toFixed(2))));
      const wasPlaying = speechState === "playing";
      const wasPaused = speechState === "paused";
      await updateSettings({ speechRate: clamped });
      settingsRef.current = { ...settingsRef.current, speechRate: clamped };
      if (wasPlaying && speechRef.current.source) {
        speechRef.current.token += 1;
        window.speechSynthesis.cancel();
        setSpeechState("playing");
        void startSpeech(true, clamped);
      } else if (wasPaused && speechRef.current.source) {
        speechRef.current.token += 1;
        window.speechSynthesis.cancel();
        setSpeechState("paused");
        setSpeechStatus(`Read aloud paused at ${clamped.toFixed(2)}x.`);
      }
    },
    [speechState, startSpeech, updateSettings],
  );

  const changeSpeechVoice = useCallback(
    async (voiceURI: string) => {
      const wasPlaying = speechState === "playing";
      const wasPaused = speechState === "paused";
      await updateSettings({ speechVoiceURI: voiceURI });
      settingsRef.current = { ...settingsRef.current, speechVoiceURI: voiceURI };
      if (wasPlaying && speechRef.current.source) {
        speechRef.current.token += 1;
        window.speechSynthesis.cancel();
        setSpeechState("playing");
        void startSpeech(true);
      } else if (wasPaused && speechRef.current.source) {
        speechRef.current.token += 1;
        window.speechSynthesis.cancel();
        setSpeechState("paused");
        setSpeechStatus("Read aloud paused with the new voice ready.");
      }
    },
    [speechState, startSpeech, updateSettings],
  );

  const seekSpeechSegment = useCallback(
    async (index: number) => {
      const source = await prepareSpeechSource(false);
      if (!source) return;
      const nextIndex = Math.max(0, Math.min(source.segments.length - 1, index));
      const segment = source.segments[nextIndex];
      speechRef.current.segmentIndex = nextIndex;
      speechRef.current.charOffset = 0;
      setSelectedSpeechSegment(nextIndex);
      setSpeechIndex(nextIndex + 1);
      setSpeechTotal(source.segments.length);
      setSpeechProgress(nextIndex / Math.max(1, source.segments.length));
      setSpeechCurrentText(segment.text);
      segment.highlight();
      segment.scrollIntoView();

      if (speechState === "playing") {
        speechRef.current.token += 1;
        window.speechSynthesis.cancel();
        setSpeechState("playing");
        void speakSegment(speechRef.current.token, source, nextIndex, 0);
      } else {
        setSpeechStatus(`Ready from segment ${nextIndex + 1}/${source.segments.length}.`);
      }
    },
    [prepareSpeechSource, speakSegment, speechState],
  );

  const fallbackSections = useMemo<ChapterEntry[]>(() => {
    if (!book) return [];
    if (book.type === "txt") return sectionEntriesFromTxt(book.sections);
    return [];
  }, [book]);

  if (!book) {
    return (
      <section className="missing-view">
        <h1>Book not found</h1>
        <p>This browser library does not contain that book anymore.</p>
        <Link className="primary-button" to="/">Back to library</Link>
      </section>
    );
  }

  const sectionEntries = readerState.sections.length ? readerState.sections : fallbackSections;
  const readerReady = readerState.ready && sectionEntries.length > 0;
  const baseSectionIndex = readerState.sections.length
    ? readerState.currentIndex
    : book.type === "txt"
      ? book.reading.sectionIndex || 0
      : book.reading.chapterIndex || 0;
  const currentSectionIndex = Math.max(
    0,
    Math.min(sectionEntries.length ? sectionEntries.length - 1 : 0, baseSectionIndex),
  );
  const progressLabel = readerState.progressLabel || getProgressLabel(book);
  const headerListenLabel = speechState === "playing" ? "Pause" : "Listen";
  const chapterSummary =
    sectionEntries[currentSectionIndex]?.label ||
    (book.type === "txt"
      ? `${currentSectionIndex + 1}. ${book.sections[currentSectionIndex]?.label || "Section"}`
      : "Chapters");
  const audioPanelOpen = panel === "audio";
  const searchPanelOpen = panel === "search";
  const settingsPanelOpen = panel === "settings";
  const blockingError = fileBlobError || readerState.error;

  const goToSearchResult = async (result: SearchResult) => {
    const moved = await readerRef.current?.goToSearchResult(result);
    if (moved) {
      stopSpeech(true);
      resetSpeechSourceState();
      setHeaderHidden(false);
      setPanel(null);
      window.scrollTo({ top: 0, behavior: "auto" });
    }
  };

  const chaptersPanelContent = (
    <ReaderPanelCard eyebrow="Navigation" title="Contents" onClose={() => setPanel(null)}>
      <div className="chapter-list" role="listbox" aria-label="Chapters">
        {sectionEntries.map((entry, index) => {
          const isActive = index === currentSectionIndex;
          const imageBadge = entry.imageCount && entry.imageCount > 0 ? entry.imageCount : null;
          return (
            <button
              key={entry.key}
              className={`chapter-row ${isActive ? "is-active" : ""} ${entry.hasImages ? "has-images" : ""}`}
              disabled={!readerReady || isNavigatingSection}
              onClick={() => void goToSection(index)}
              title={
                entry.hasImages
                  ? `${entry.label}${imageBadge ? ` — ${imageBadge} image${imageBadge === 1 ? "" : "s"}` : ""}`
                  : entry.label
              }
              role="option"
              aria-selected={isActive}
              aria-current={isActive ? "true" : undefined}
              style={{ paddingLeft: `${14 + Math.min(3, entry.level || 0) * 14}px` }}
            >
              <span className="chapter-row-label">{entry.label}</span>
              {entry.hasImages ? (
                <span
                  className="chapter-image-pill"
                  aria-label={imageBadge ? `${imageBadge} image${imageBadge === 1 ? "" : "s"} in this chapter` : "Contains images"}
                >
                  <span aria-hidden="true">🖼</span>
                  {imageBadge && imageBadge > 1 ? <span className="chapter-image-count">{imageBadge}</span> : null}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </ReaderPanelCard>
  );

  const audioPanelContent = (
    <ReaderPanelCard eyebrow="Listen" title="Audio Controls" onClose={() => setPanel(null)}>
      <div className="audio-status-card">
        <p className="status-badge">
          {speechState === "playing" ? "Playing" : speechState === "paused" ? "Paused" : "Ready"}
        </p>
        <h4>{chapterSummary}</h4>
        <p>{speechStatus}</p>
      </div>

      <div className="audio-toolbar-row">
        <button
          className="primary-button audio-main-button"
          onClick={() => void toggleSpeech()}
          disabled={!speechSupported}
        >
          {headerListenLabel}
        </button>
        <button
          className="soft-button audio-stop-button"
          onClick={() => stopSpeech()}
          disabled={speechState === "idle"}
        >
          Stop
        </button>
      </div>

      <div className="progress-strip">
        <div className="progress-bar">
          <span style={{ width: `${Math.max(0, Math.min(100, speechProgress * 100))}%` }} />
        </div>
        <div className="progress-meta">
          <strong>
            Segment {speechIndex} / {speechTotal}
          </strong>
          <span>{settings.speechRate.toFixed(2)}x</span>
        </div>
      </div>

      <div className="audio-controls-grid">
        <button
          className="soft-button"
          onClick={() => void seekSpeechSegment(selectedSpeechSegment - 1)}
          disabled={!speechSupported}
        >
          Prev segment
        </button>
        <button
          className="soft-button"
          onClick={() => void seekSpeechSegment(selectedSpeechSegment + 1)}
          disabled={!speechSupported}
        >
          Next segment
        </button>
      </div>

      <label className="field">
        <span>Start from segment</span>
        <select
          value={selectedSpeechSegment}
          onFocus={() => void prepareSpeechSource(false)}
          onChange={(event) => void seekSpeechSegment(Number(event.target.value))}
          disabled={!speechSupported}
        >
          {speechSegments.length ? (
            speechSegments.map((segment) => (
              <option key={segment.value} value={segment.value}>
                {segment.label}
              </option>
            ))
          ) : (
            <option value={0}>Load audio segments</option>
          )}
        </select>
      </label>

      <div className="audio-controls-grid">
        <button className="soft-button" onClick={() => void changeSpeechRate(settings.speechRate - 0.15)}>
          Slower
        </button>
        <button className="soft-button" onClick={() => void changeSpeechRate(settings.speechRate + 0.15)}>
          Faster
        </button>
      </div>

      <label className="field">
        <span>Read speed</span>
        <input
          type="range"
          min="70"
          max="400"
          value={Math.round(settings.speechRate * 100)}
          onChange={(event) => void changeSpeechRate(Number(event.target.value) / 100)}
        />
      </label>

      <label className="field">
        <span>Voice</span>
        <select
          value={settings.speechVoiceURI}
          onChange={(event) => void changeSpeechVoice(event.target.value)}
        >
          <option value="">System default</option>
          {speechVoices.map((voice) => (
            <option key={voice.voiceURI} value={voice.voiceURI}>
              {voice.name} ({voice.lang}){voice.default ? " - default" : ""}
            </option>
          ))}
        </select>
      </label>

      <label className="toggle-row">
        <span>Continue reading till the end</span>
        <input
          type="checkbox"
          checked={settings.speechAutoContinue}
          onChange={(event) => {
            settingsRef.current = { ...settingsRef.current, speechAutoContinue: event.target.checked };
            void updateSettings({ speechAutoContinue: event.target.checked });
          }}
        />
      </label>

      <div className="excerpt-card">
        <p className="eyebrow">Current excerpt</p>
        <p>{speechCurrentText || "Start audio to see the current passage here."}</p>
      </div>
    </ReaderPanelCard>
  );

  const searchPanelContent = (
    <ReaderPanelCard eyebrow="Find" title="Search Book" onClose={() => setPanel(null)}>
      <label className="field search-field">
        <span>Search text</span>
        <input
          autoFocus={panel === "search"}
          type="search"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Find a name, phrase, or place"
        />
      </label>

      <div className="search-status-row">
        <p>{searchStatus}</p>
        {searching ? <span className="status-badge">Searching</span> : null}
      </div>

      <div className="search-results-list">
        {searchResults.map((result) => (
          <button
            key={result.id}
            className="search-result-row"
            onClick={() => void goToSearchResult(result)}
            title={result.excerpt}
          >
            <span>{result.sectionLabel}</span>
            <strong>{result.excerpt}</strong>
          </button>
        ))}
      </div>
    </ReaderPanelCard>
  );

  const settingsPanelContent = (
    <ReaderPanelCard eyebrow="Reader" title="Reading Settings" onClose={() => setPanel(null)}>
      <label className="field">
        <span>Theme</span>
        <select
          value={settings.theme}
          onChange={(event) =>
            void updateSettings({ theme: event.target.value as ReaderSettings["theme"] })
          }
        >
          <option value="mist">Mist</option>
          <option value="paper">Paper</option>
          <option value="sepia">Sepia</option>
          <option value="night">Night</option>
        </select>
      </label>

      <label className="field">
        <span>Flow</span>
        <select
          value={settings.flow}
          onChange={(event) =>
            void updateSettings({ flow: event.target.value as ReaderSettings["flow"] })
          }
        >
          <option value="scrolled-doc">Scroll</option>
          <option value="paginated">Paginated</option>
        </select>
      </label>

      <label className="field">
        <span>Font size</span>
        <input
          type="range"
          min="16"
          max="32"
          value={settings.fontSize}
          onChange={(event) => void updateSettings({ fontSize: Number(event.target.value) })}
        />
      </label>

      <label className="field">
        <span>Line height</span>
        <input
          type="range"
          min="16"
          max="24"
          value={Math.round(settings.lineHeight * 10)}
          onChange={(event) => void updateSettings({ lineHeight: Number(event.target.value) / 10 })}
        />
      </label>

      <label className="field">
        <span>Text width</span>
        <input
          type="range"
          min="320"
          max="1100"
          value={settings.maxWidth}
          onChange={(event) => void updateSettings({ maxWidth: Number(event.target.value) })}
        />
      </label>
    </ReaderPanelCard>
  );

  return (
    <section className="reader-view">
      <header className={`reader-shell-header ${headerHidden ? "is-hidden" : ""}`}>
        <div className="reader-header-inner">
          <div className="reader-topbar">
            <div className="reader-topbar-left">
              <button
                className="soft-button reader-nav-icon"
                onClick={() => navigate("/")}
                aria-label="Back to library"
              >
                <span className="button-icon" aria-hidden="true">←</span>
                <span className="button-label desktop-only">Library</span>
              </button>

              <div className="reader-title-wrap">
                <p className="reader-kicker">{progressLabel}</p>
                <h1 title={book.title}>{truncateText(book.title, 72)}</h1>
                <p className="reader-subtitle">
                  {formatBookType(book.type)} • {truncateText(book.sourceLabel, 72)}
                </p>
              </div>
            </div>

            <div className="reader-topbar-actions">
              <button
                className="primary-button compact-control-button"
                onClick={() => void toggleSpeech()}
                disabled={!speechSupported}
                aria-label={headerListenLabel}
                title={headerListenLabel}
              >
                <span className="button-icon" aria-hidden="true">
                  {speechState === "playing" ? "❚❚" : "▶"}
                </span>
                <span className="button-label desktop-only">{headerListenLabel}</span>
              </button>

              <button
                className={`soft-button compact-control-button ${audioPanelOpen ? "is-selected" : ""}`}
                onClick={() => togglePanel("audio")}
                aria-label="Audio controls"
                aria-pressed={audioPanelOpen}
                title="Audio controls"
              >
                <span className="button-icon" aria-hidden="true">♫</span>
                <span className="button-label desktop-only">Audio</span>
              </button>

              <button
                className={`soft-button compact-control-button ${searchPanelOpen ? "is-selected" : ""}`}
                onClick={() => togglePanel("search")}
                aria-label="Search book"
                aria-pressed={searchPanelOpen}
                title="Search book"
              >
                <span className="button-icon" aria-hidden="true">⌕</span>
                <span className="button-label desktop-only">Search</span>
              </button>

              <button
                className={`soft-button compact-control-button ${settingsPanelOpen ? "is-selected" : ""}`}
                onClick={() => togglePanel("settings")}
                aria-label="Reading settings"
                aria-pressed={settingsPanelOpen}
                title="Reading settings"
              >
                <span className="button-icon" aria-hidden="true">Aa</span>
                <span className="button-label desktop-only">Aa</span>
              </button>
            </div>
          </div>

          <div className="reader-chapter-strip">
            <button
              className="chip-button chapter-step-button"
              onClick={() => void stepSection(-1)}
              disabled={!readerReady || isNavigatingSection || currentSectionIndex <= 0}
              aria-label="Previous chapter"
            >
              <span className="button-icon" aria-hidden="true">‹</span>
              <span className="button-label">Prev</span>
            </button>

            <button
              className="chapter-summary-button"
              onClick={() => togglePanel("chapters")}
              aria-label="Open chapter list"
              aria-expanded={panel === "chapters"}
            >
              <strong>{truncateText(chapterSummary, 42)}</strong>
              <span>{!readerReady ? "Loading..." : isNavigatingSection ? "Moving..." : progressLabel}</span>
            </button>

            <button
              className="chip-button chapter-step-button"
              onClick={() => void stepSection(1)}
              disabled={
                !readerReady || isNavigatingSection || currentSectionIndex >= sectionEntries.length - 1
              }
              aria-label="Next chapter"
            >
              <span className="button-label">Next</span>
              <span className="button-icon" aria-hidden="true">›</span>
            </button>
          </div>
        </div>
      </header>

      <main className="reader-main">
        <aside className="reader-side-panel reader-side-panel-left">{chaptersPanelContent}</aside>

        <section className="reader-stage-shell">
          {blockingError ? (
            <div className="reader-surface reader-error" role="alert">
              <h3>Couldn't open this book</h3>
              <p>{blockingError}</p>
              <Link className="primary-button" to="/">
                Back to library
              </Link>
            </div>
          ) : book.type === "txt" ? (
            <TextReader
              ref={readerRef}
              book={book}
              onUpdate={handleBookUpdate}
              onReaderStateChange={handleReaderStateChange}
            />
          ) : fileBlob ? (
            <EpubReader
              ref={readerRef}
              book={book}
              fileBlob={fileBlob}
              settings={settings}
              onUpdate={handleBookUpdate}
              onReaderStateChange={handleReaderStateChange}
            />
          ) : (
            <div className="reader-surface" role="status" aria-live="polite">
              Loading book from local storage...
            </div>
          )}
        </section>

        <aside
          className={`reader-side-panel reader-side-panel-right ${audioPanelOpen || searchPanelOpen || settingsPanelOpen ? "is-visible" : ""}`}
        >
          {audioPanelOpen ? audioPanelContent : searchPanelOpen ? searchPanelContent : settingsPanelOpen ? settingsPanelContent : null}
        </aside>
      </main>

      <div
        className={`mobile-panel-backdrop ${panel ? "is-open" : ""}`}
        onClick={() => setPanel(null)}
      />
      <section
        className={`mobile-panel-sheet ${panel ? "is-open" : ""}`}
        aria-hidden={!panel}
        aria-label="Reader panel"
      >
        {panel === "chapters"
          ? chaptersPanelContent
          : panel === "search"
            ? searchPanelContent
          : panel === "audio"
            ? audioPanelContent
            : panel === "settings"
              ? settingsPanelContent
              : null}
      </section>
    </section>
  );
}

function ReaderPanelCard({
  eyebrow,
  title,
  onClose,
  children,
}: {
  eyebrow: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="panel-card panel-card-compact">
      <div className="panel-head">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h3>{title}</h3>
        </div>
        <button className="soft-button panel-close-button" onClick={onClose}>
          Close
        </button>
      </div>
      {children}
    </div>
  );
}

function getPreferredVoice(voices: SpeechSynthesisVoice[], voiceURI: string): SpeechSynthesisVoice | null {
  if (voiceURI) {
    const exact = voices.find((voice) => voice.voiceURI === voiceURI);
    if (exact) return exact;
  }
  return voices.find((voice) => voice.default) || voices[0] || null;
}

function stopSpeechInternal(
  speechRef: MutableRefObject<{
    token: number;
    source: any;
    segmentIndex: number;
    charOffset: number;
    utterance: SpeechSynthesisUtterance | null;
  }>,
  speechSupported: boolean,
) {
  speechRef.current.token += 1;
  speechRef.current.utterance = null;
  speechRef.current.segmentIndex = 0;
  speechRef.current.charOffset = 0;
  speechRef.current.source?.clearHighlights?.();
  speechRef.current.source = null;
  if (speechSupported) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
  }
}
