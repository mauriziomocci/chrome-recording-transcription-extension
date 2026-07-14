import { describe, it, expect } from 'vitest'
import {
  meetIdFromUrl,
  formatDateStamp,
  formatTimeStamp,
  formatClock,
  transcriptFilename,
  screenshotFilename,
  transcriptToMarkdown,
  frameDiff,
  type TranscriptChunk
} from '../src/lib/session'

// Fixed instant: 2026-07-13 14:30:05 local time
const T0 = new Date(2026, 6, 13, 14, 30, 5).getTime()

describe('meetIdFromUrl', () => {
  it('extracts the meeting code from a standard Meet URL', () => {
    expect(meetIdFromUrl('https://meet.google.com/abc-defg-hij')).toBe('abc-defg-hij')
  })

  it('ignores query string and trailing slash', () => {
    expect(meetIdFromUrl('https://meet.google.com/abc-defg-hij/?authuser=0')).toBe('abc-defg-hij')
  })

  it('falls back to google-meet for non-Meet or invalid URLs', () => {
    expect(meetIdFromUrl('https://example.com/foo')).toBe('google-meet')
    expect(meetIdFromUrl('not a url')).toBe('google-meet')
    expect(meetIdFromUrl('https://meet.google.com/')).toBe('google-meet')
  })
})

describe('timestamp formatting', () => {
  it('formats date as YYYY-MM-DD', () => {
    expect(formatDateStamp(T0)).toBe('2026-07-13')
  })

  it('formats time as HHMM with zero padding', () => {
    expect(formatTimeStamp(T0)).toBe('1430')
    expect(formatTimeStamp(new Date(2026, 6, 13, 9, 5, 0).getTime())).toBe('0905')
  })

  it('formats clock as HH:MM:SS', () => {
    expect(formatClock(T0)).toBe('14:30:05')
  })
})

describe('filenames', () => {
  it('builds the transcript filename inside meet-transcripts/', () => {
    expect(transcriptFilename('abc-defg-hij', T0)).toBe(
      'meet-transcripts/meet-abc-defg-hij-2026-07-13-1430.md'
    )
  })

  it('builds the screenshot filename with the shot clock time', () => {
    const shotAt = new Date(2026, 6, 13, 14, 41, 9).getTime()
    expect(screenshotFilename('abc-defg-hij', T0, shotAt)).toBe(
      'meet-transcripts/meet-abc-defg-hij-2026-07-13-1430-shot-144109.png'
    )
  })
})

describe('transcriptToMarkdown', () => {
  const chunks: TranscriptChunk[] = [
    { startTime: T0, endTime: T0 + 4000, speaker: 'Alice', text: 'Ciao a tutti' },
    { startTime: T0 + 10_000, endTime: T0 + 12_000, speaker: 'Bob', text: 'Iniziamo' }
  ]

  it('renders header with meet id, date and session start', () => {
    const md = transcriptToMarkdown('abc-defg-hij', T0, chunks, T0 + 60_000)
    expect(md).toContain('# Google Meet abc-defg-hij')
    expect(md).toContain('Data: 2026-07-13')
    expect(md).toContain('Inizio: 14:30:05')
    expect(md).toContain('Ultimo aggiornamento: 14:31:05')
  })

  it('renders one line per chunk with local clock range and speaker', () => {
    const md = transcriptToMarkdown('abc-defg-hij', T0, chunks, T0 + 60_000)
    expect(md).toContain('[14:30:05 - 14:30:09] Alice: Ciao a tutti')
    expect(md).toContain('[14:30:15 - 14:30:17] Bob: Iniziamo')
  })

  it('renders an empty transcript as header only', () => {
    const md = transcriptToMarkdown('abc-defg-hij', T0, [], T0)
    expect(md).toContain('# Google Meet abc-defg-hij')
    expect(md).not.toContain('] ')
  })
})

describe('frameDiff', () => {
  it('returns 0 for identical frames', () => {
    const a = new Uint8ClampedArray([10, 20, 30, 40])
    expect(frameDiff(a, new Uint8ClampedArray([10, 20, 30, 40]))).toBe(0)
  })

  it('returns 1 for maximally different frames', () => {
    const a = new Uint8ClampedArray([0, 0, 0, 0])
    const b = new Uint8ClampedArray([255, 255, 255, 255])
    expect(frameDiff(a, b)).toBe(1)
  })

  it('returns the normalized mean absolute difference', () => {
    const a = new Uint8ClampedArray([0, 0])
    const b = new Uint8ClampedArray([51, 51])
    expect(frameDiff(a, b)).toBeCloseTo(0.2, 5)
  })

  it('returns 1 for mismatched or empty buffers (forces a capture)', () => {
    expect(frameDiff(new Uint8ClampedArray([1, 2]), new Uint8ClampedArray([1]))).toBe(1)
    expect(frameDiff(new Uint8ClampedArray([]), new Uint8ClampedArray([]))).toBe(1)
  })
})
