import { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { AppStoreProvider, useBooks, useSettings } from "./AppStore";
import { LibraryPage } from "../components/LibraryPage";
import { ReaderPage } from "../components/ReaderPage";

function AppRoutes() {
  const { libraryReady } = useBooks();
  const { settings } = useSettings();

  // Apply theme/typography vars as a side-effect, never during render.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    root.style.setProperty("--reader-font-size", `${settings.fontSize}px`);
    root.style.setProperty("--reader-line-height", `${settings.lineHeight}`);
    root.style.setProperty("--reader-max-width", `${settings.maxWidth}px`);
  }, [settings.theme, settings.fontSize, settings.lineHeight, settings.maxWidth]);

  if (!libraryReady) {
    return <div className="app-loading" role="status" aria-live="polite">Loading library…</div>;
  }

  return (
    <Routes>
      <Route path="/" element={<LibraryPage />} />
      <Route path="/reader/:bookId" element={<ReaderPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <AppStoreProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AppStoreProvider>
  );
}
