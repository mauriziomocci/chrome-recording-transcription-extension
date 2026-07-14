# Meeting Recording Extension (Chrome Extension)

Scrape live captions from a Google Meet and save them as a `.txt` transcript, or record the current Google Meet tab (video + audio) to a `.webm` file. Optionally, mix in your microphone so your own voice is included in the recording.

Everything happens locally in your browser.

If you're interested in the process, reasoning, demos, and more, [check out the blog](https://www.recall.ai/blog/how-to-build-a-chrome-recording-extension).

## Hosted Meeting Recording API
If you'd rather use a bot or desktop recording form factor, check out [Recall.ai](https://www.recall.ai/?utm_source=github&utm_medium=sampleapp&utm_campaign=chrome-recording-extension)

## Features

**Transcript saver** – parses Google Meet’s live captions and downloads a timestamped Markdown transcript.

**Auto-save transcript** – while a meeting is running, the transcript is saved automatically every 60 seconds to `Downloads/meet-transcripts/meet-<meeting-id>-<date>-<start-time>.md` (same file overwritten, no duplicates). A final save happens when the call ends. Toggle in the popup.

**Screen-share screenshots** – when a participant shares their screen, the extension detects scene changes on the presentation tile and saves WebP snapshots next to the transcript (`...-shot-<time>.webp`). Min 5s between shots, max 200 per session. Toggle in the popup.

**Manual screenshot** – a "Screenshot Now" button in the popup captures the presentation tile (or the largest video) on demand, bypassing the scene-change detection and rate limits.

**Tab recorder** – captures Google Meet tab video + audio into a .webm via MediaRecorder.

**Optional mic mix** – include your microphone in the recording (once you grant permission).

**MV3/Offscreen architecture** – recording runs in a hidden offscreen document.

## How it works (high level)

1. Content script watches the Google Meet caption DOM and buffers text with timestamps.

2. Popup lets you download the transcript or control recording.

3. Background service worker creates/coordinates an offscreen document and requests the correct capture streamId for the active tab.

4. Offscreen page captures the tab, optionally mixes microphone audio, records, and hands the blob back for download.

## Requirements

**Google Chrome** (or Chromium-based browser) with `Manifest V3` support and the `Offscreen API`.

**Node.js 18+** and **npm** (or **pnpm/yarn**) to build the extension.

The extension uses the following Chrome permissions:
`activeTab`, `downloads`, `tabCapture`, `offscreen`, `storage`, `tabs`, `desktopCapture`
and is scoped to `https://meet.google.com/*`.

## Quick start
1) Clone and install
```
git clone https://github.com/recallai/chrome-recording-transcription-extension.git
cd chrome-recording-transcription-extension
npm install
```

2) Build
```
npm run build   # outputs to `./dist`
```

3) Load into Chrome
- Open `chrome://extensions`
- Toggle "Developer mode" (top right)
- Click "Load unpacked"
- Select the `./dist` folder


Open a Google Meet, click the extension icon:
 - **Download Transcript** – saves a `.txt` of the live captions (turn captions ON in Google Meet).
 - **Enable Microphone** – grants mic permission so your voice can be mixed into recordings.
 - **Start Recording (tab) / Stop & Download** – creates a `.webm` file via the Downloads API.

## Install & build (detailed)

**1. Install Node**
  - macOS: `brew install node`

  - Ubuntu/Debian: `sudo apt-get install -y nodejs npm`

  - Verify: `node -v && npm -v`

**2. Install dependencies**

```
npm install
```


**3. Build once (production)**

```
npm run build
```

This compiles TypeScript via `ts-loader` and copies the HTML/manifest to `dist/`.

**4. Load the extension**

  - Visit `chrome://extensions`
  - Turn on `Developer mode`
  - Click `Load unpacked` → select the `dist` directory that was created inside your repo when you ran `npm run build`

> During development you can also run:
> `npm run watch` which will force a rebuild on file changes (when you save a file)
> After each rebuild, click Reload on the extension (in `chrome://extensions`) to pick up changes. If you changed the service worker or manifest, you must reload the extension; for content script-only changes, a page refresh of the Google Meet tab may be enough.

## Using the extension

1. Open a Google Meet at https://meet.google.com/...

2. (For transcripts) turn on Captions in Google Meet.

3. Click the extension icon (puzzle → pin it for quick access).

4. In the popup:
 
  - **Download Transcript**: Turn closed captions on then hit Download Transcript after the meeting. This saves **google-meet-transcript-<meeting-id>-<timestamp>.txt**
  - ** Recording **
      - **Enable Microphone** - Turn on before you hit "Start Recording" to capture your audio in addition to the audio of the other participants
        - The mic prompt may not appear reliably in a popup. If so, the button opens a dedicated `Enable Microphone` page (`micsetup.html`) where you can click `Enable` and allow mic access.
        - Once granted, the label changes to `Microphone Enabled`.
      - **Start Recording**: Starts a recording of the current tab (video + system audio). If mic is enabled and mixing is on (default), your mic is mixed in.
      - **Stop & Download**: Finalizes and downloads `google-meet-recording-<meeting-id>-<timestamp>.webm.`

> The extension shows a “REC” badge while recording. All files are saved locally via Chrome’s Downloads API.

## Project structure
```
.
├─ manifest.json
├─ webpack.config.js
├─ tsconfig.json
├─ package.json
├─ popup.html
├─ offscreen.html
├─ micsetup.html
├─ src/
│  ├─ background.ts     # MV3 service worker (creates offscreen, coordinates streams)
│  ├─ offscreen.ts      # runs recorder; mixes mic + tab; saves blob via downloads
│  ├─ popup.ts          # popup UI handlers: transcript, mic, start/stop
│  ├─ scrapingScript.ts # parses Google Meet captions from the DOM
│  └─ micsetup.ts       # dedicated visible page to request mic permission
└─ dist/                # build output (generated)
```

## Auto-save details

- Files land in `Downloads/meet-transcripts/`. Chrome extensions cannot write outside the Downloads folder; move files elsewhere manually or with your own tooling.
- The transcript filename is fixed at session start (`meet-<meeting-id>-YYYY-MM-DD-HHMM.md`) and the same file is overwritten on every autosave (`conflictAction: overwrite`).
- The session starts when at least two video tiles are visible (past the lobby) or at the first caption; it ends when no video/caption region is present for ~6 seconds.
- Captions must be ON in Google Meet for the transcript to have content.
- If Chrome has “Ask where to save each file before downloading” enabled, silent autosave will prompt every time — disable it for a smooth experience.
- Screenshot detection is a heuristic (dominant video tile at least 2x larger than the next one): expect occasional false positives/negatives.
- Tunable constants live at the top of the auto-save section in `src/scrapingScript.ts` (`AUTOSAVE_MS`, `SCENE_DIFF_THRESHOLD`, `SHOT_MIN_INTERVAL_MS`, `SHOT_MAX_PER_SESSION`, …).

## Configuration knobs
- Mix microphone into recording: 
  - In src/offscreen.ts:
```
const WANT_MIC_MIX = true
```
  - Set to false to disable mic mixing entirely (tab audio only).

- Output filenames
  - Recordings: `google-meet-recording-<meet-suffix>-<timestamp>.webm`
  - Manual transcripts: `google-meet-transcript-<meet-suffix>-<timestamp>.md`
  - Auto-saved transcripts: `meet-transcripts/meet-<meet-suffix>-<date>-<start-time>.md`
  - Screenshots: `meet-transcripts/meet-<meet-suffix>-<date>-<start-time>-shot-<time>.webp`

## Scripts

`npm run build` – single production build to `dist/`
`npm run watch` – rebuild on change (remember to reload the extension in Chrome)

## Dependencies & toolchain

- TypeScript (target es2020)
- webpack 5 + ts-loader
- copy-webpack-plugin, clean-webpack-plugin
- @types/chrome, @types/node

These are already declared in `package.json`:
```
"devDependencies": {
  "@types/chrome": "^0.0.326",
  "@types/node": "^24.0.4",
  "clean-webpack-plugin": "^4.0.0",
  "copy-webpack-plugin": "^13.0.1",
  "ts-loader": "^9.5.0",
  "typescript": "^5.8.3",
  "webpack": "^5.99.9",
  "webpack-cli": "^6.0.1"
}
```
## Permissions explained
- `activeTab`, `tabs` – query the active tab (needed to target/label the recording).
- `downloads` – save transcript/recording files locally.
- `tabCapture` / `desktopCapture` – capture video/audio from the current tab.
- `offscreen` – create an offscreen document for safe/background recording logic.
- `storage` – store ephemeral recording-state hints (for UI sync).
- `host_permissions: ["https://meet.google.com/*"]` – limit content script to Google Meet.

## Troubleshooting / FAQ

Q: What do I do if I don’t see any transcript text?
Answer: 
 - Make sure `Captions` are enabled in the Google Meet UI.
 - The extension only scrapes from `https://meet.google.com/*`.
 - Reload the Google Meet page after (re)loading the extension.

Question: What do I do when I see: “Failed to start recording: Offscreen not ready” or similar?
Answer: 
 - Open chrome://extensions, click Reload on the extension, then try again.
 - Ensure Chrome is up to date (Manifest V3 + Offscreen API supported).
 - Some enterprise policies can block offscreen—check your admin/device policies if applicable.

No microphone audio in the recording.
- Click `Enable Microphone` in the popup. If the inline prompt fails, a Mic Setup tab opens. Click `Enable` there and allow.
- Also check the OS mic permissions for Chrome (`System Settings` → `Privacy` → `Microphone`).

Question: Why is my recording silent or very quiet?
Answer:
 - Make sure the Google Meet tab is playing audio (unmuted).
 - If you muted the site/tab or Google Meet, tab audio won’t be captured.
 - If mic mix is on, confirm the OS/input device and levels.

Question: “Stop & Download” finishes but no file appears. What do I do?
Answer:
 - Check the browser Downloads panel.
 - If you have “Ask where to save each file” enabled, a save dialog should appear.
 - Some download managers/extensions can interfere. Disable and retry.

Question: Why are the popup buttons not enabling/disabling correctly?
Answer:
 - The popup reflects state broadcast from `background`/`offscreen`. If it gets out of sync, stop the recording (if any), then click `Reload` on the extension in `chrome://extensions`.

## Development tips

 - Use `npm run watch` during iteration.
 - Background logs appear in the `service worker` console:
    - `chrome://extensions` → your extension → `service worker` → `Inspect`
 - Offscreen logs: open `chrome://extensions` → your extension → `service worker` → look for messages from `[offscreen]`.
- Content script logs: in the Google Meet tab → DevTools Console.

### Thanks to...
The Recall.ai team for letting me build fun projects like this to help people on the internet learn and build their own versions.
