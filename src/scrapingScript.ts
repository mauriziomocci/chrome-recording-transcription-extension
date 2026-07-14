// src/scrapingScript.ts

import {
  type TranscriptChunk,
  meetIdFromUrl,
  transcriptFilename,
  screenshotFilename,
  transcriptToMarkdown,
  frameDiff
} from './lib/session'

let transcript: TranscriptChunk[] = []

type OpenChunk = TranscriptChunk & { timer: number }

const CHUNK_GRACE_MS = 2000

const prior = new Map<string, OpenChunk>()
const lastSeen = new Map<string, string>()

const normalize = (pre: string) =>
  pre.toLowerCase().replace(/[.,?!'"’]/g, "").replace(/\s+/g, " ").trim()

function handleCaption(speakerKey: string, speakerName: string, rawText: string){
  const text = rawText.trim()
  if(!text) return

  ensureSession()

  const norm = normalize(text)
  const prev = lastSeen.get(speakerKey)
  if (prev === norm) return
  lastSeen.set(speakerKey, norm)
  transcriptGen++

  const now = Date.now()
  const existing = prior.get(speakerKey)

  if (!existing){
    const timer = window.setTimeout(() => commit(speakerKey), CHUNK_GRACE_MS)
    prior.set(speakerKey, {
      startTime: now,
      endTime: now,
      speaker: speakerName,
      text,
      timer
    })
    return
  }

  existing.endTime = now
  existing.text = text
  existing.speaker = speakerName

  clearTimeout(existing.timer)
  existing.timer = window.setTimeout(() => commit(speakerKey), CHUNK_GRACE_MS)
}

function commit(key: string){
  const entry = prior.get(key)
  if(!entry) return

  const { timer, ...chunk } = entry
  transcript.push(chunk)
  clearTimeout(timer)
  prior.delete(key)
}

function commitAll(){
  ;[...prior.keys()].forEach(commit)
}

// committed chunks plus a snapshot of the still-open ones, in caption order,
// so periodic autosaves do not force-close chunks mid-sentence
function allChunks(): TranscriptChunk[] {
  const open = [...prior.values()].map(({ timer: _timer, ...chunk }) => chunk)
  return [...transcript, ...open].sort((a, b) => a.startTime - b.startTime)
}

function buildMarkdown(): string {
  const chunks = allChunks()
  const meetId = session?.meetId ?? meetIdFromUrl(location.href)
  const start = session?.start ?? chunks[0]?.startTime ?? Date.now()
  return transcriptToMarkdown(meetId, start, chunks, Date.now())
}

function resetTranscript(){
  ;[...prior.values()].forEach(e => clearTimeout(e.timer))
  prior.clear()
  lastSeen.clear()
  transcript = []
}

let captionSelector = '.ygicle'
let speakerSelector = '.NWpY1d'
let captionParent  = '.nMcdL'

let captionObserver: MutationObserver | null = null
const nodeObservers = new Map<HTMLElement, MutationObserver>()

function scanClasses(cl: HTMLElement){
  if (nodeObservers.has(cl)) return

  const txtNode = cl.querySelector<HTMLDivElement>(captionSelector)
  if(!txtNode) return

  const speakerName = cl.querySelector<HTMLElement>(speakerSelector)?.textContent?.trim() ?? ' '
  const key = cl.getAttribute('data-participant-id') || speakerName

  const push = () => {
    const trimmed = txtNode.textContent?.trim() ?? ''
    if(trimmed) handleCaption(key, speakerName, trimmed)
  }

  push()

  const obs = new MutationObserver(push)
  obs.observe(txtNode, { childList: true, subtree: true, characterData: true })
  nodeObservers.set(cl, obs)
}

function dropNodeObserver(cl: HTMLElement){
  const obs = nodeObservers.get(cl)
  if (obs) { obs.disconnect(); nodeObservers.delete(cl) }
}

function launchAttachObserver(region: HTMLElement) {
  captionObserver?.disconnect()
  nodeObservers.forEach(obs => obs.disconnect())
  nodeObservers.clear()

  captionObserver = new MutationObserver((mutations) => {
    mutations.forEach(mutation => {
      mutation.addedNodes.forEach(node => {
        if (node instanceof HTMLElement && node.matches(captionParent)) {
          scanClasses(node)
        }
      })
      mutation.removedNodes.forEach(node => {
        if (node instanceof HTMLElement && node.matches(captionParent)) {
          dropNodeObserver(node)
        }
      })
    })
  })

  captionObserver.observe(region, { childList: true, subtree: true })
  console.log(`Caption observer attached`)
  region.querySelectorAll<HTMLElement>(captionParent).forEach(scanClasses)
}

// The captions region is discovered from the 2s watch loop below instead of a
// body-wide MutationObserver: Meet mutates the DOM constantly and a subtree
// observer on document.body would fire dozens of times per second for nothing.
let captionRegion: HTMLElement | null = null

function watchCaptionRegion(){
  const region = document.querySelector<HTMLElement>('div[role="region"][aria-label="Captions"]')
    ?? document.querySelector(captionParent)?.closest<HTMLElement>('div[role="region"]')
    ?? null
  if (region !== captionRegion) {
    captionRegion = region
    if (region) launchAttachObserver(region)
  }
}

// ---------------------------------------------------------------------------
// Auto-save session: filename fixed at session start, periodic overwrite in
// Downloads/meet-transcripts/, final save when the call ends.
// ---------------------------------------------------------------------------

const AUTOSAVE_MS = 60_000
const WATCH_MS = 2_000
const END_GRACE_CHECKS = 3           // 3 consecutive empty checks (~6s) = call ended
const SHOT_MIN_INTERVAL_MS = 5_000
const SHOT_MAX_PER_SESSION = 200
const SCENE_DIFF_THRESHOLD = 0.06
const SAMPLE_W = 64
const SAMPLE_H = 36
const MIN_PRESENTATION_AREA = 90_000 // px^2 rendered, below this no tile is a presentation
const MAX_SHOT_WIDTH = 1920

interface MeetSession {
  meetId: string
  start: number
  filename: string
  shotCount: number
}

let session: MeetSession | null = null
let noCallChecks = 0
let prevSample: Uint8ClampedArray | null = null
let lastShotAt = 0
let shotCapReported = false
// generation counter instead of a boolean dirty flag: captions arriving while
// a save is in flight must not be marked clean by that save's callback
let transcriptGen = 0
let savedGen = 0

const settings = { autoSaveTranscript: true, autoScreenshots: true }
try {
  chrome.storage.local.get(settings, (res) => Object.assign(settings, res))
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    if ('autoSaveTranscript' in changes) settings.autoSaveTranscript = !!changes.autoSaveTranscript.newValue
    if ('autoScreenshots' in changes) settings.autoScreenshots = !!changes.autoScreenshots.newValue
  })
} catch (e) {
  console.warn('[mtr] storage unavailable, using default settings', e)
}

function ensureSession(){
  if (session) return
  const meetId = meetIdFromUrl(location.href)
  if (meetId === 'google-meet') return // landing page, not a meeting
  const start = Date.now()
  resetTranscript()
  session = { meetId, start, filename: transcriptFilename(meetId, start), shotCount: 0 }
  noCallChecks = 0
  prevSample = null
  lastShotAt = 0
  shotCapReported = false
  console.log('[mtr] session started:', session.filename)
}

function saveTranscript(reason: string){
  if (!session || !settings.autoSaveTranscript) return
  if (transcript.length === 0 && prior.size === 0) return
  if (transcriptGen === savedGen) return // nothing new since the last save, skip the download
  const gen = transcriptGen
  const markdown = buildMarkdown()
  chrome.runtime.sendMessage(
    { type: 'AUTO_SAVE_TRANSCRIPT', filename: session.filename, markdown },
    (res) => {
      const err = chrome.runtime.lastError
      if (err) console.warn('[mtr] autosave failed:', err.message)
      else if (res?.ok === false) console.warn('[mtr] autosave rejected:', res.error)
      else {
        savedGen = gen
        console.log(`[mtr] transcript saved (${reason})`)
      }
    }
  )
}

function endSession(){
  if (!session) return
  console.log('[mtr] session ended:', session.filename)
  commitAll()
  saveTranscript('meeting ended')
  session = null
  prevSample = null
}

// videos present = in call; captions region alone also counts (audio-only call)
function inCallNow(): boolean {
  if (document.querySelectorAll('video').length > 0) return true
  return !!(captionRegion && captionRegion.isConnected)
}

setInterval(() => {
  watchCaptionRegion()

  const inCall = inCallNow()
  const videoCount = document.querySelectorAll('video').length

  // >= 2 videos means we are past the lobby self-preview
  if (!session && videoCount >= 2) ensureSession()

  if (session) {
    if (!inCall) {
      noCallChecks++
      if (noCallChecks >= END_GRACE_CHECKS) endSession()
    } else {
      noCallChecks = 0
      if (settings.autoScreenshots) sampleAndMaybeShoot()
    }
  }
}, WATCH_MS)

setInterval(() => saveTranscript('periodic'), AUTOSAVE_MS)

window.addEventListener('pagehide', () => {
  if (!session) return
  commitAll()
  // best effort: the message may not survive page teardown, periodic saves cover the rest
  try {
    chrome.runtime.sendMessage({ type: 'AUTO_SAVE_TRANSCRIPT', filename: session.filename, markdown: buildMarkdown() })
  } catch {}
})

// ---------------------------------------------------------------------------
// Screen-share screenshots: pick the dominant video tile, sample it downscaled
// and capture a full-resolution PNG when the scene actually changes.
// ---------------------------------------------------------------------------

const sampleCanvas = document.createElement('canvas')
sampleCanvas.width = SAMPLE_W
sampleCanvas.height = SAMPLE_H
const shotCanvas = document.createElement('canvas')

function findPresentationVideo(): HTMLVideoElement | null {
  const vids = Array.from(document.querySelectorAll('video')).filter(v => v.videoWidth > 0)
  if (vids.length < 2) return null // a lone video is a camera, not a presentation

  const byArea = vids
    .map(v => { const r = v.getBoundingClientRect(); return { v, area: r.width * r.height } })
    .sort((a, b) => b.area - a.area)

  const [first, second] = byArea
  if (first.area < MIN_PRESENTATION_AREA) return null
  if (first.area < second.area * 2) return null
  return first.v
}

function grayscaleSample(video: HTMLVideoElement): Uint8ClampedArray | null {
  const ctx = sampleCanvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  try {
    ctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H)
    const { data } = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H)
    const gray = new Uint8ClampedArray(SAMPLE_W * SAMPLE_H)
    for (let i = 0; i < gray.length; i++) {
      const o = i * 4
      gray[i] = (data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114) | 0
    }
    return gray
  } catch (e) {
    console.warn('[mtr] frame sampling failed', e)
    return null
  }
}

function sampleAndMaybeShoot(){
  if (!session) return

  const video = findPresentationVideo()
  if (!video) { prevSample = null; return }

  const sample = grayscaleSample(video)
  if (!sample) return

  const changed = prevSample === null || frameDiff(prevSample, sample) > SCENE_DIFF_THRESHOLD
  prevSample = sample
  if (!changed) return

  const now = Date.now()
  if (now - lastShotAt < SHOT_MIN_INTERVAL_MS) return
  if (session.shotCount >= SHOT_MAX_PER_SESSION) {
    if (!shotCapReported) { console.warn('[mtr] screenshot cap reached for this session'); shotCapReported = true }
    return
  }

  if (captureShot(video, now)) {
    lastShotAt = now
    session.shotCount++
  }
}

// draws the video frame to canvas and ships it to the background as WebP
// (5-10x smaller than PNG for document content, faster to encode)
function captureShot(video: HTMLVideoElement, now: number): string | null {
  const meetId = session?.meetId ?? meetIdFromUrl(location.href)
  const start = session?.start ?? now

  const scale = Math.min(1, MAX_SHOT_WIDTH / video.videoWidth)
  shotCanvas.width = Math.round(video.videoWidth * scale)
  shotCanvas.height = Math.round(video.videoHeight * scale)
  const ctx = shotCanvas.getContext('2d')
  if (!ctx) return null

  try {
    ctx.drawImage(video, 0, 0, shotCanvas.width, shotCanvas.height)
    const dataUrl = shotCanvas.toDataURL('image/webp', 0.85)
    const filename = screenshotFilename(meetId, start, now)
    chrome.runtime.sendMessage({ type: 'SAVE_SCREENSHOT', filename, dataUrl }, (res) => {
      const err = chrome.runtime.lastError
      if (err) console.warn('[mtr] screenshot save failed:', err.message)
      else if (res?.ok === false) console.warn('[mtr] screenshot rejected:', res.error)
    })
    console.log('[mtr] screenshot captured:', filename)
    return filename
  } catch (e) {
    console.warn('[mtr] screenshot capture failed', e)
    return null
  }
}

// manual capture from the popup button: prefers the presentation tile, falls
// back to the largest rendered video; bypasses scene diff, interval and cap
function manualScreenshot(): { ok: boolean; filename?: string; error?: string } {
  let video = findPresentationVideo()
  if (!video) {
    const vids = Array.from(document.querySelectorAll('video')).filter(v => v.videoWidth > 0)
    video = vids
      .map(v => { const r = v.getBoundingClientRect(); return { v, area: r.width * r.height } })
      .sort((a, b) => b.area - a.area)[0]?.v ?? null
  }
  if (!video) return { ok: false, error: 'No video to capture on this page' }

  const filename = captureShot(video, Date.now())
  if (!filename) return { ok: false, error: 'Capture failed' }
  return { ok: true, filename }
}

// ---------------------------------------------------------------------------
// External API (popup + debugging)
// ---------------------------------------------------------------------------

;(window as any).getTranscript = () => {
  commitAll()
  return buildMarkdown()
}

;(window as any).resetTranscript = () => {
  resetTranscript()
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'GET_TRANSCRIPT') {
    commitAll()
    sendResponse({ transcript: transcript.length ? buildMarkdown() : '' })
    return true
  }
  if (msg?.type === 'RESET_TRANSCRIPT') {
    resetTranscript()
    sendResponse({ ok: true })
    return true
  }
  if (msg?.type === 'MANUAL_SCREENSHOT') {
    sendResponse(manualScreenshot())
    return true
  }
})

console.log('Transcript collector ready')
