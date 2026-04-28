export type BookType = "epub" | "txt";

export interface ReaderSettings {
  theme: "mist" | "paper" | "sepia" | "night";
  fontSize: number;
  lineHeight: number;
  maxWidth: number;
  flow: "scrolled-doc" | "paginated";
  speechRate: number;
  speechVoiceURI: string;
  speechAutoContinue: boolean;
}

export interface TextSentence {
  id: string;
  text: string;
}

export interface TextBlock {
  id: string;
  text: string;
  sentences: TextSentence[];
}

export interface TxtSection {
  id: string;
  label: string;
  blocks: TextBlock[];
  plainText: string;
}

export interface BookStats {
  wordCount: number;
  imageCount: number;
  chapterCount: number;
  estimatedPages: number;
  estimatedMinutes: number;
}

export interface LibraryBookBase {
  id: string;
  type: BookType;
  title: string;
  author: string;
  fileName: string;
  sourceLabel: string;
  size: number;
  importedAt: string;
  lastOpenedAt: string;
  coverDataUrl?: string | null;
  stats?: BookStats;
}

export interface TxtBook extends LibraryBookBase {
  type: "txt";
  sections: TxtSection[];
  reading: {
    sectionIndex: number;
    progress: number;
  };
}

export interface EpubBook extends LibraryBookBase {
  type: "epub";
  /** Map of normalized file href → image count for the file. Used to flag chapters with images. */
  chapterImagesByHref?: Record<string, number>;
  reading: {
    cfi: string | null;
    href: string | null;
    chapterIndex: number;
    progress: number;
  };
}

export type LibraryBook = TxtBook | EpubBook;

export interface LibraryState {
  books: LibraryBook[];
  settings: ReaderSettings;
}

export interface ChapterEntry {
  key: string;
  label: string;
  href?: string;
  spineIndex?: number;
  level?: number;
  hasImages?: boolean;
  imageCount?: number;
}

export interface SpeechSegment {
  id: string;
  text: string;
  scrollIntoView: () => void;
  highlight: () => void;
}

export interface SpeechSource {
  chapterKey: string;
  title: string;
  lang?: string;
  segments: SpeechSegment[];
  clearHighlights: () => void;
}

export interface SearchResult {
  id: string;
  sectionIndex: number;
  sectionLabel: string;
  excerpt: string;
  matchText: string;
  source?: string;
}

export interface ReaderHandle {
  getSections: () => ChapterEntry[];
  getCurrentSectionIndex: () => number;
  goToSection: (index: number) => Promise<boolean>;
  goToNextSection: () => Promise<boolean>;
  goToPrevSection: () => Promise<boolean>;
  searchBook: (query: string) => Promise<SearchResult[]>;
  goToSearchResult: (result: SearchResult) => Promise<boolean>;
  clearSearchHighlights?: () => void;
  getSpeechSource: () => Promise<SpeechSource | null>;
  getProgressLabel: () => string;
}
