# Online EPUB Reader

Online EPUB Reader is a local-first browser app for reading EPUB and TXT novels directly in Chrome or Edge, with support for ZIP imports, password-protected ZIPs, browser translation, and browser-native read-aloud.

Live version:

- https://novel-epub-reader.vercel.app

## What it does

- Imports `.epub`, `.txt`, `.zip`, and password-protected `.zip` files
- Stores books locally in the browser with IndexedDB
- Supports multiple books in a personal local library
- Provides a mobile-friendly and desktop-adaptive reading layout
- Supports chapter navigation, themes, text sizing, and reading settings
- Uses browser translation for foreign-language reading
- Includes browser-native audiobook/read-aloud controls

## Tech stack

- React
- TypeScript
- Vite
- `epubjs`
- `@zip.js/zip.js`
- `localforage`

## Local setup

Requirements:

- Node.js 20+ recommended
- npm

Install and run:

```bash
npm install
npm run dev
```

Open the local app in your browser after Vite starts.

## Production build

```bash
npm run build
npm run preview
```

## Personal-use workflow

1. Open the live site or run the app locally.
2. Import your EPUB, TXT, or ZIP files.
3. If a ZIP is encrypted, enter the password before import.
4. Open a book from the library and read it in the browser.
5. Use Chrome or Edge translate on the reading page if the novel is in another language.

## Notes

- Books are stored locally in your browser profile, not on a backend.
- Clearing browser storage can remove the local library.
- Browser speech voices and translation quality depend on the browser and device.
- EPUB rendering can vary slightly across browsers, especially on Android.

## Project scripts

- `npm run dev` starts the Vite development server
- `npm run build` creates a production build
- `npm run preview` serves the built app locally
