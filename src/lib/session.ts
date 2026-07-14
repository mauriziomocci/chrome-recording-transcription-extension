// src/lib/session.ts
// Pure helpers for the auto-save session: naming, markdown rendering, scene diff.
// No chrome.* or DOM access here so everything stays unit-testable.

export interface TranscriptChunk {
  startTime: number
  endTime: number
  speaker: string
  text: string
}

const FALLBACK_ID = 'google-meet'

export function meetIdFromUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.hostname !== 'meet.google.com') return FALLBACK_ID
    const last = u.pathname.split('/').filter(Boolean).pop()
    return last || FALLBACK_ID
  } catch {
    return FALLBACK_ID
  }
}

const pad2 = (n: number) => String(n).padStart(2, '0')

export function formatDateStamp(epochMs: number): string {
  const d = new Date(epochMs)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export function formatTimeStamp(epochMs: number): string {
  const d = new Date(epochMs)
  return `${pad2(d.getHours())}${pad2(d.getMinutes())}`
}

export function formatClock(epochMs: number): string {
  const d = new Date(epochMs)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

function sessionBase(meetId: string, sessionStart: number): string {
  return `meet-transcripts/meet-${meetId}-${formatDateStamp(sessionStart)}-${formatTimeStamp(sessionStart)}`
}

export function transcriptFilename(meetId: string, sessionStart: number): string {
  return `${sessionBase(meetId, sessionStart)}.md`
}

export function screenshotFilename(meetId: string, sessionStart: number, shotTime: number): string {
  return `${sessionBase(meetId, sessionStart)}-shot-${formatClock(shotTime).replace(/:/g, '')}.webp`
}

export function transcriptToMarkdown(
  meetId: string,
  sessionStart: number,
  chunks: TranscriptChunk[],
  now: number
): string {
  const lines = chunks.map(
    c => `[${formatClock(c.startTime)} - ${formatClock(c.endTime)}] ${c.speaker}: ${c.text}`
  )
  return [
    `# Google Meet ${meetId}`,
    '',
    `- Data: ${formatDateStamp(sessionStart)}`,
    `- Inizio: ${formatClock(sessionStart)}`,
    `- Ultimo aggiornamento: ${formatClock(now)}`,
    '',
    ...lines,
    ''
  ].join('\n')
}

// Meet accumulates the ongoing speech inside the same caption DOM node, so a
// chunk must only keep what was not already committed. Below this overlap
// length a match is considered accidental (common short words), not a trim.
const MIN_OVERLAP = 10

export function stripCommittedPrefix(prefix: string, full: string): string {
  if (!prefix) return full
  if (full.startsWith(prefix)) return full.slice(prefix.length).trim()
  // Meet trims old text from the top of a long caption node: the committed
  // prefix no longer matches from the start, but its tail overlaps the
  // beginning of the current text
  const max = Math.min(prefix.length, full.length)
  for (let len = max; len >= MIN_OVERLAP; len--) {
    if (full.startsWith(prefix.slice(prefix.length - len))) return full.slice(len).trim()
  }
  // no meaningful overlap: the node was reset, everything is new
  return full
}

// Normalized mean absolute difference between two grayscale samples (0..1).
// Mismatched or empty buffers return 1 so the caller treats it as a scene change.
export function frameDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 1
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
  return sum / (a.length * 255)
}
