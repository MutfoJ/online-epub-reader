import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useBooks } from "../app/AppStore";
import { analyzeEpub } from "../lib/epubAnalysis";
import {
  buildBookStats,
  colorTokenFromString,
  formatBookType,
  formatBytes,
  formatNumberCompact,
  formatReadingTime,
  getBookProgressPercent,
  getInitials,
  getProgressLabel,
  statsForTxt,
  truncateText,
} from "../lib/helpers";
import type { EpubBook, LibraryBook } from "../types";

type SortMode = "recent" | "title" | "progress" | "size";

export function LibraryPage() {
  const navigate = useNavigate();
  const {
    books,
    importFiles,
    refreshLibrary,
    deleteBook,
    updateBook,
    getBookBlob,
    importStatus,
    importError,
  } = useBooks();
  const [password, setPassword] = useState("");
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("recent");
  const [filterType, setFilterType] = useState<"all" | "epub" | "txt">("all");
  const [infoBookId, setInfoBookId] = useState<string | null>(null);
  const dragCounter = useRef(0);
  const [dragActive, setDragActive] = useState(false);

  const fileInputId = "library-file-input";

  const openFilePicker = () => {
    document.querySelector<HTMLInputElement>(`#${fileInputId}`)?.click();
  };

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      const importedIds = await importFiles(files, password.trim() || undefined);
      if (importedIds[0]) navigate(`/reader/${importedIds[0]}`);
    },
    [importFiles, navigate, password],
  );

  const onDragEnter = (event: React.DragEvent) => {
    if (!event.dataTransfer.types?.includes("Files")) return;
    event.preventDefault();
    dragCounter.current += 1;
    setDragActive(true);
  };
  const onDragOver = (event: React.DragEvent) => {
    if (event.dataTransfer.types?.includes("Files")) event.preventDefault();
  };
  const onDragLeave = (event: React.DragEvent) => {
    event.preventDefault();
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) setDragActive(false);
  };
  const onDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    dragCounter.current = 0;
    setDragActive(false);
    const files = [...(event.dataTransfer?.files || [])];
    await handleFiles(files);
  };

  const visibleBooks = useMemo(() => {
    const needle = search.trim().toLowerCase();
    let filtered = books.filter((book) => filterType === "all" || book.type === filterType);
    if (needle) {
      filtered = filtered.filter(
        (book) =>
          book.title.toLowerCase().includes(needle) ||
          book.author?.toLowerCase().includes(needle) ||
          book.fileName?.toLowerCase().includes(needle),
      );
    }
    const copy = [...filtered];
    if (sortMode === "title") {
      copy.sort((a, b) => a.title.localeCompare(b.title));
    } else if (sortMode === "progress") {
      copy.sort((a, b) => getBookProgressPercent(b) - getBookProgressPercent(a));
    } else if (sortMode === "size") {
      copy.sort((a, b) => b.size - a.size);
    } else {
      copy.sort(
        (a, b) =>
          new Date(b.lastOpenedAt || b.importedAt).getTime() -
          new Date(a.lastOpenedAt || a.importedAt).getTime(),
      );
    }
    return copy;
  }, [books, search, sortMode, filterType]);

  const totals = useMemo(() => {
    let words = 0;
    let images = 0;
    let bytes = 0;
    for (const book of books) {
      bytes += book.size;
      if (book.stats) {
        words += book.stats.wordCount;
        images += book.stats.imageCount;
      }
    }
    return { words, images, bytes };
  }, [books]);

  const infoBook = infoBookId ? books.find((entry) => entry.id === infoBookId) || null : null;

  const ensureStats = useCallback(
    async (book: LibraryBook): Promise<LibraryBook> => {
      if (book.stats && (book.type !== "epub" || book.coverDataUrl !== undefined)) return book;
      if (book.type === "txt") {
        const next = { ...book, stats: statsForTxt(book) };
        await updateBook(next);
        return next;
      }
      try {
        const blob = await getBookBlob(book.id);
        if (!blob) return book;
        const analysis = await analyzeEpub(blob);
        const next: EpubBook = {
          ...(book as EpubBook),
          coverDataUrl: book.coverDataUrl ?? analysis.coverDataUrl,
          stats: analysis.stats,
          chapterImagesByHref:
            (book as EpubBook).chapterImagesByHref ||
            (Object.keys(analysis.chapterImagesByHref).length ? analysis.chapterImagesByHref : undefined),
        };
        await updateBook(next);
        return next;
      } catch {
        const fallback: LibraryBook = { ...book, stats: book.stats || buildBookStats(0, 0, 0) };
        await updateBook(fallback);
        return fallback;
      }
    },
    [getBookBlob, updateBook],
  );

  const onShowInfo = async (book: LibraryBook) => {
    setInfoBookId(book.id);
    if (!book.stats || (book.type === "epub" && book.coverDataUrl === undefined)) {
      await ensureStats(book);
    }
  };

  return (
    <section className="library-view">
      <header className="library-hero">
        <div className="hero-copy">
          <p className="eyebrow">Browser-only EPUB reader</p>
          <h1>Your reading library</h1>
          <p className="hero-text">
            Import EPUB, TXT, or ZIP archives and read them privately in this browser. Listen with the
            built-in voice, search across chapters, and pick up exactly where you left off — nothing
            ever leaves your device.
          </p>
          <div className="hero-stat-strip">
            <HeroStat label="Books" value={String(books.length)} />
            <HeroStat label="Words" value={formatNumberCompact(totals.words)} />
            <HeroStat label="Images" value={formatNumberCompact(totals.images)} />
            <HeroStat label="On disk" value={formatBytes(totals.bytes)} />
          </div>
        </div>
        <div className="hero-actions">
          <button className="soft-button" onClick={() => void refreshLibrary()}>Refresh</button>
          <button className="primary-button" onClick={openFilePicker}>Import books</button>
        </div>
      </header>

      <section className="library-panel import-panel">
        <div className="section-head">
          <div>
            <p className="eyebrow">Import</p>
            <h2>Add books</h2>
          </div>
        </div>

        <label
          className={`dropzone ${dragActive ? "is-drag" : ""}`}
          htmlFor={fileInputId}
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          <input
            id={fileInputId}
            type="file"
            accept=".epub,.txt,.zip"
            multiple
            onChange={async (event) => {
              const files = [...(event.target.files || [])];
              event.target.value = "";
              await handleFiles(files);
            }}
          />
          <span className="dropzone-icon" aria-hidden="true">📚</span>
          <span className="dropzone-title">Drop files here or tap to browse</span>
          <small>EPUB · TXT · ZIP — covers and stats are extracted automatically.</small>
        </label>

        <div className="import-grid">
          <label className="field">
            <span>ZIP password (optional)</span>
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              placeholder="Only for encrypted ZIPs"
            />
          </label>
          <button className="soft-button" onClick={() => setPassword("")} disabled={!password}>
            Clear password
          </button>
        </div>

        <p className={`status ${importError ? "error" : ""}`}>{importStatus}</p>
      </section>

      <section className="library-panel library-shelf">
        <div className="section-head">
          <div>
            <p className="eyebrow">Library</p>
            <h2>Your books</h2>
          </div>
          <span className="count-pill">{books.length} {books.length === 1 ? "book" : "books"}</span>
        </div>

        <div className="library-toolbar">
          <input
            className="library-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search title, author, or filename"
          />
          <div className="library-filters">
            <FilterChip active={filterType === "all"} onClick={() => setFilterType("all")}>All</FilterChip>
            <FilterChip active={filterType === "epub"} onClick={() => setFilterType("epub")}>EPUB</FilterChip>
            <FilterChip active={filterType === "txt"} onClick={() => setFilterType("txt")}>TXT</FilterChip>
          </div>
          <label className="library-sort">
            <span>Sort</span>
            <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
              <option value="recent">Recent</option>
              <option value="title">Title</option>
              <option value="progress">Progress</option>
              <option value="size">File size</option>
            </select>
          </label>
        </div>

        {!books.length ? (
          <div className="library-empty">
            <h3>No books imported yet</h3>
            <p>Drop an EPUB or TXT file above to start reading. Everything stays in your browser.</p>
          </div>
        ) : !visibleBooks.length ? (
          <div className="library-empty">
            <h3>No matches</h3>
            <p>Try a different search or change the type filter.</p>
          </div>
        ) : (
          <div className="library-grid">
            {visibleBooks.map((book) => (
              <BookCard
                key={book.id}
                book={book}
                onOpen={() => navigate(`/reader/${book.id}`)}
                onInfo={() => void onShowInfo(book)}
                onDelete={async () => {
                  if (!window.confirm(`Remove "${book.title}" from this library?`)) return;
                  await deleteBook(book.id);
                }}
              />
            ))}
          </div>
        )}
      </section>

      {infoBook ? (
        <BookInfoModal
          book={infoBook}
          onClose={() => setInfoBookId(null)}
          onOpenReader={() => navigate(`/reader/${infoBook.id}`)}
        />
      ) : null}
    </section>
  );
}

function HeroStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="hero-stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button className={`filter-chip ${active ? "is-active" : ""}`} onClick={onClick}>
      {children}
    </button>
  );
}

function BookCard({
  book,
  onOpen,
  onInfo,
  onDelete,
}: {
  book: LibraryBook;
  onOpen: () => void;
  onInfo: () => void;
  onDelete: () => void;
}) {
  const progress = getBookProgressPercent(book);
  const hasCover = Boolean(book.coverDataUrl);
  const stats = book.stats;
  const minutesLeft =
    stats && progress < 100 ? Math.round(stats.estimatedMinutes * (1 - progress / 100)) : 0;
  const accent = colorTokenFromString(book.title || book.id);

  return (
    <article className="book-card-v2">
      <button
        className={`book-cover ${hasCover ? "has-cover" : "is-placeholder"}`}
        onClick={onOpen}
        aria-label={`Open ${book.title}`}
        style={!hasCover ? { background: `linear-gradient(160deg, ${accent}, color-mix(in srgb, ${accent} 60%, #1a1a1a))` } : undefined}
      >
        {hasCover ? (
          <img src={book.coverDataUrl || ""} alt="" loading="lazy" />
        ) : (
          <span className="book-cover-initials" aria-hidden="true">{getInitials(book.title)}</span>
        )}
        <span className="book-cover-tag">{formatBookType(book.type)}</span>
        {progress > 0 ? (
          <span
            className="book-cover-progress"
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span style={{ width: `${progress}%` }} />
          </span>
        ) : null}
      </button>

      <div className="book-meta">
        <button className="book-title-button" onClick={onOpen} title={book.title}>
          <strong>{truncateText(book.title, 80)}</strong>
        </button>
        <p className="book-author">{book.author || "Unknown author"}</p>
        <p className="book-progress">{getProgressLabel(book)}</p>
        {stats ? (
          <p className="book-mini-stats">
            {stats.wordCount ? `${formatNumberCompact(stats.wordCount)} words` : null}
            {stats.wordCount && minutesLeft ? " · " : null}
            {minutesLeft ? `${formatReadingTime(minutesLeft)} left` : null}
          </p>
        ) : null}
        <div className="book-actions">
          <button className="soft-button book-action" onClick={onOpen}>Read</button>
          <button className="soft-button book-action" onClick={onInfo} aria-label="Show book info">Info</button>
          <button className="book-delete book-action" onClick={onDelete} aria-label="Remove book">
            Remove
          </button>
        </div>
      </div>
    </article>
  );
}

function BookInfoModal({
  book,
  onClose,
  onOpenReader,
}: {
  book: LibraryBook;
  onClose: () => void;
  onOpenReader: () => void;
}) {
  const stats = book.stats;
  const progress = getBookProgressPercent(book);
  const minutesLeft =
    stats && progress < 100 ? Math.round(stats.estimatedMinutes * (1 - progress / 100)) : 0;

  return (
    <div className="book-info-backdrop" onClick={onClose}>
      <div
        className="book-info-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Information about ${book.title}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="book-info-head">
          <div>
            <p className="eyebrow">{formatBookType(book.type)}</p>
            <h2>{book.title}</h2>
            <p className="book-info-author">{book.author || "Unknown author"}</p>
          </div>
          <button className="soft-button" onClick={onClose}>Close</button>
        </header>

        <div className="book-info-body">
          <div className="book-info-cover">
            {book.coverDataUrl ? (
              <img src={book.coverDataUrl} alt="" />
            ) : (
              <div
                className="book-info-cover-placeholder"
                style={{
                  background: `linear-gradient(160deg, ${colorTokenFromString(book.title)}, #2a2a2a)`,
                }}
              >
                {getInitials(book.title)}
              </div>
            )}
          </div>

          <div className="book-info-stats">
            <StatRow label="Progress" value={`${progress}% read`} />
            <StatRow
              label={book.type === "epub" ? "Chapters" : "Sections"}
              value={String(stats?.chapterCount ?? "—")}
            />
            <StatRow
              label="Images"
              value={stats?.imageCount ? formatNumberCompact(stats.imageCount) : book.type === "txt" ? "—" : stats ? "0" : "—"}
            />
            <StatRow
              label="Words"
              value={stats?.wordCount ? formatNumberCompact(stats.wordCount) : "—"}
            />
            <StatRow
              label="Estimated pages"
              value={stats?.estimatedPages ? formatNumberCompact(stats.estimatedPages) : "—"}
            />
            <StatRow
              label="Total reading time"
              value={stats?.estimatedMinutes ? formatReadingTime(stats.estimatedMinutes) : "—"}
            />
            <StatRow
              label="Time left"
              value={minutesLeft ? formatReadingTime(minutesLeft) : progress >= 100 ? "Finished" : "—"}
            />
            <StatRow label="File size" value={formatBytes(book.size)} />
            <StatRow label="Imported" value={new Date(book.importedAt).toLocaleString()} />
            <StatRow
              label="Last opened"
              value={book.lastOpenedAt ? new Date(book.lastOpenedAt).toLocaleString() : "Never"}
            />
            <StatRow label="Source" value={book.sourceLabel || book.fileName} />
          </div>
        </div>

        <footer className="book-info-foot">
          <button className="primary-button" onClick={onOpenReader}>Open reader</button>
        </footer>
      </div>
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-row">
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
    </div>
  );
}
