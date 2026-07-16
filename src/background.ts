// src/background.ts

let offscreenPort: chrome.runtime.Port | null = null
let offscreenReady = false
let lastKnownRecording = false

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
function bglog(...a: any[]) { console.log('[background]', ...a) }
function setBadge(recording: boolean) {
  chrome.action.setBadgeText({ text: recording ? 'REC' : '' }).catch?.(() => {})
}

async function hasOffscreenContext(): Promise<boolean> {
  try {
    const getContexts = (chrome.runtime as any).getContexts as
      | ((q: { contextTypes: ('OFFSCREEN_DOCUMENT' | string)[] }) => Promise<any[]>)
      | undefined
    if (getContexts) {
      const ctx = await getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).catch(() => [])
      return Array.isArray(ctx) && ctx.length > 0
    }
  } catch {}
  try { return !!(await (chrome.offscreen as any).hasDocument?.()) } catch { return false }
}

async function ensureOffscreen(): Promise<void> {
  const have = await hasOffscreenContext()
  if (!have) {
    bglog('Creating offscreen document…')
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen.html'),
      reasons: ['BLOBS', 'AUDIO_PLAYBACK', 'USER_MEDIA'],
      justification: 'Record tab audio+video in offscreen using MediaRecorder'
    })
  }

  for (let i = 0; i < 10 && !(offscreenPort && offscreenReady); i++) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_PING' })
      if (res?.ok) { bglog('Offscreen responded to PING'); break }
    } catch {}
    await wait(100)
  }

  if (!(offscreenPort && offscreenReady)) {
    try { await chrome.runtime.sendMessage({ type: 'OFFSCREEN_CONNECT' }) } catch {}
  }

  for (let i = 0; i < 50; i++) {
    if (offscreenPort && offscreenReady) return
    await wait(100)
  }
  throw new Error('Offscreen did not become ready')
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'offscreen') return
  bglog('Offscreen connected')
  offscreenPort = port
  offscreenReady = false

  port.onMessage.addListener((msg: any) => {
    if (msg?.type === 'OFFSCREEN_READY') {
      offscreenReady = true
      bglog('Offscreen is READY (Port)')
    }

    if (msg?.type === 'RECORDING_STATE') {
      lastKnownRecording = !!msg.recording
      setBadge(lastKnownRecording)
      chrome.runtime.sendMessage({ type: 'RECORDING_STATE', recording: lastKnownRecording }).catch(() => {})
    }

    if (msg?.type === 'OFFSCREEN_SAVE') {
      const filename =
        (typeof msg.filename === 'string' && msg.filename.trim())
          ? msg.filename
          : `google-meet-recording-${Date.now()}.webm`

      if (msg.blobUrl) {
        bglog('Saving OFFSCREEN_SAVE via blobUrl', filename)
        chrome.downloads.download({ url: msg.blobUrl, filename, saveAs: true }, () => {
          if (chrome.runtime.lastError) {
            bglog('downloads.download error:', chrome.runtime.lastError.message)
          } else {
            chrome.runtime.sendMessage({ type: 'RECORDING_SAVED', filename }).catch(() => {})
          }
          setTimeout(() => {
            try { offscreenPort?.postMessage({ type: 'REVOKE_BLOB_URL', blobUrl: msg.blobUrl }) } catch {}
          }, 10_000)
        })
        return
      }
    }
  })

  port.onDisconnect.addListener(() => {
    bglog('Offscreen disconnected')
    offscreenPort = null
    offscreenReady = false
    setBadge(false)
  })
})

function postToOffscreen(msg: any, timeoutMs = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!offscreenPort) return reject(new Error('Offscreen port not connected'))
    const id = Math.random().toString(36).slice(2)
    msg.__id = id

    const listener = (m: any) => {
      if (m && m.__respFor === id) {
        offscreenPort!.onMessage.removeListener(listener)
        resolve(m.payload)
      }
    }

    offscreenPort.onMessage.addListener(listener)
    offscreenPort.postMessage(msg)

    setTimeout(() => {
      try { offscreenPort!.onMessage.removeListener(listener) } catch {}
      reject(new Error('Offscreen response timeout'))
    }, timeoutMs)
  })
}

// periodic autosaves overwrite the same file but chrome.downloads records one
// history entry per save; erase those entries once complete (the file on disk
// is untouched) so the download history is not flooded every minute
const autosaveDownloadIds = new Set<number>()

chrome.downloads.onChanged.addListener((delta) => {
  if (!autosaveDownloadIds.has(delta.id)) return
  const state = delta.state?.current
  if (state === 'complete' || state === 'interrupted') {
    autosaveDownloadIds.delete(delta.id)
    chrome.downloads.erase({ id: delta.id }, () => void chrome.runtime.lastError)
  }
})

// chunked conversion: a single String.fromCharCode(...bytes) overflows the
// call stack on long transcripts, so encode 32 KB at a time
function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

// background side streamId helper
function getStreamIdForTab(tabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id?: string) => {
        const err = chrome.runtime.lastError
        if (err) return reject(new Error(err.message))
        if (!id) return reject(new Error('Empty streamId'))
        resolve(id)
      })
    } catch (e) {
      reject(e as any)
    }
  })
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'START_RECORDING') {
      const tabId: number | undefined = msg.tabId
      if (typeof tabId !== 'number') { sendResponse({ ok: false, error: 'Missing tabId' }); return }
      bglog('Popup requested START_RECORDING for tabId', tabId)

      try {
        await ensureOffscreen()
        bglog('ensureOffscreen() completed')
      } catch (e: any) {
        sendResponse({ ok: false, error: `Offscreen not ready: ${e?.message || e}` })
        return
      }

      const attemptStart = async (): Promise<any> => {
        const streamId = await getStreamIdForTab(tabId)
        // start can legitimately take longer than the default RPC timeout:
        // two getUserMedia attempts plus MediaRecorder spin-up
        return postToOffscreen({ type: 'OFFSCREEN_START', streamId }, 30000)
      }

      try {
        let r = await attemptStart()
        bglog('postToOffscreen(OFFSCREEN_START) response', r)

        if (!r?.ok && /active stream/i.test(String(r?.error || '')) && !lastKnownRecording) {
          // self-heal: a capture leaked somewhere inside the offscreen document
          // (or a previous session never released the tab). Tearing the document
          // down frees every stream it holds; recreate it and retry once. If the
          // retry still fails with the same error, the tab is captured by
          // something OUTSIDE this extension (another extension, tab casting).
          bglog('active-stream failure: recreating offscreen document and retrying once')
          try { await (chrome.offscreen as any).closeDocument?.() } catch {}
          offscreenPort = null
          offscreenReady = false
          await ensureOffscreen()
          r = await attemptStart()
          bglog('retry OFFSCREEN_START response', r)
        }

        if (r?.ok) {
          lastKnownRecording = true
          setBadge(true)
          chrome.runtime.sendMessage({ type: 'RECORDING_STATE', recording: true }).catch(() => {})
          sendResponse({ ok: true })
        } else {
          sendResponse({ ok: false, error: r?.error || 'Failed to start' })
        }
      } catch (e: any) {
        bglog('OFFSCREEN_START failed', e)
        sendResponse({ ok: false, error: `OFFSCREEN_START failed: ${e?.message || e}` })
      }
      return
    }

    if (msg?.type === 'STOP_RECORDING') {
      try {
        await ensureOffscreen()
        if (offscreenPort) {
          const r = await postToOffscreen({ type: 'OFFSCREEN_STOP' })
          bglog('postToOffscreen(OFFSCREEN_STOP) response', r)
        }
        sendResponse({ ok: true })
      } catch (e: any) {
        sendResponse({ ok: false, error: `STOP failed: ${e?.message || e}` })
      }
      return
    }

    if (msg?.type === 'GET_RECORDING_STATUS') {
      // lastKnownRecording lives in the service worker and resets to false on
      // every worker recycle; storage.session is written by the offscreen on
      // each state change and survives the recycle, so trust it first
      try {
        const res = await (chrome.storage as any)?.session?.get?.(['recording'])
        if (res && typeof res.recording === 'boolean') {
          lastKnownRecording = res.recording
          setBadge(lastKnownRecording)
        }
      } catch {}
      sendResponse({ recording: lastKnownRecording })
      return
    }

    if (msg?.type === 'AUTO_SAVE_TRANSCRIPT') {
      const { filename, markdown } = msg
      if (typeof filename !== 'string' || typeof markdown !== 'string') {
        sendResponse({ ok: false, error: 'Missing filename or markdown' })
        return
      }
      const url = 'data:text/markdown;charset=utf-8;base64,' + utf8ToBase64(markdown)
      chrome.downloads.download(
        { url, filename, saveAs: false, conflictAction: 'overwrite' },
        (downloadId) => {
          const err = chrome.runtime.lastError
          if (err) { bglog('AUTO_SAVE_TRANSCRIPT download error:', err.message); sendResponse({ ok: false, error: err.message }) }
          else {
            if (typeof downloadId === 'number') autosaveDownloadIds.add(downloadId)
            sendResponse({ ok: true, downloadId })
          }
        }
      )
      return
    }

    if (msg?.type === 'SAVE_SCREENSHOT') {
      const { filename, dataUrl } = msg
      if (typeof filename !== 'string' || typeof dataUrl !== 'string' || !/^data:image\/(webp|png)/.test(dataUrl)) {
        sendResponse({ ok: false, error: 'Missing filename or image dataUrl' })
        return
      }
      chrome.downloads.download(
        { url: dataUrl, filename, saveAs: false, conflictAction: 'uniquify' },
        (downloadId) => {
          const err = chrome.runtime.lastError
          if (err) { bglog('SAVE_SCREENSHOT download error:', err.message); sendResponse({ ok: false, error: err.message }) }
          else sendResponse({ ok: true, downloadId })
        }
      )
      return
    }
  })().catch((err) => {
    console.error('[background] top-level error', err)
    sendResponse({ ok: false, error: String(err) })
  })

  return true
})

// NOTE: no onSuspend auto-stop. The MV3 service worker recycles after ~30s of
// inactivity even mid-recording; the recording lives in the offscreen document
// and survives that just fine. Upstream stopped (and downloaded) the recording
// here, which killed every recording longer than the worker's idle window.
// State is resynced on reconnect: the offscreen pushes RECORDING_STATE each
// time it opens a new port.
