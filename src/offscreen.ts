// src/offscreen.ts

// Flip this on to include your local mic in the recording mix.
// NOTE: Offscreen cannot show the initial mic permission prompt.
// You must "prime" mic permission once from a visible page (popup/options/extension tab)
// via navigator.mediaDevices.getUserMedia({ audio: true }) before this will succeed.
const WANT_MIC_MIX = true

window.addEventListener('error', (e) => {
  console.error('[offscreen] window.onerror', e?.message, e?.error)
})
window.addEventListener('unhandledrejection', (e: any) => {
  console.error('[offscreen] unhandledrejection', e?.reason || e)
})
console.log('[offscreen] script loaded')

// port plumbing
let portRef: chrome.runtime.Port | null = null
function log(...a: any[]) { console.log('[offscreen]', ...a) }

function connectPort(): chrome.runtime.Port {
  try { portRef?.disconnect() } catch {}
  const p: chrome.runtime.Port = chrome.runtime.connect({ name: 'offscreen' })
  p.onDisconnect.addListener(() => { log('Port disconnected'); portRef = null })
  // the RPC handler must be attached to EVERY port: when the MV3 service
  // worker idles out and reconnects, a fresh port is created and a listener
  // registered only once at module load would leave it deaf (START timeouts)
  p.onMessage.addListener(handleRpcMessage)
  // tell background alive
  p.postMessage({ type: 'OFFSCREEN_READY' })
  // resync real recording state after a service worker restart: the fresh
  // worker starts with recording=false while a capture may well be running
  p.postMessage({ type: 'RECORDING_STATE', recording: capturing })
  log('READY signaled via Port')
  portRef = p
  return p
}
function getPort(): chrome.runtime.Port { return portRef ?? connectPort() }
function respond(req: any, payload: any) { getPort().postMessage({ __respFor: req?.__id, payload }) }

// popup uses this to flip buttons
function pushState(recording: boolean, extra?: Record<string, any>) {
  try { (chrome.storage as any)?.session?.set?.({ recording }).catch?.(() => {}) } catch {}
  getPort().postMessage({ type: 'RECORDING_STATE', recording, ...extra })
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms))

function inferSuffixFromActiveTabUrl(url?: string | null): string {
  try {
    if (!url) return 'google-meet'
    const u = new URL(url)
    const last = u.pathname.split('/').pop() || 'google-meet'
    return last
  } catch { return 'google-meet' }
}

// simple 1-channel RMS meter for debugging
function attachRmsMeter(track: MediaStreamTrack, label: 'RAW' | 'FINAL') {
  try {
    const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext
    const ctx = new AC()
    void ctx.resume().catch(() => {})
    const src = ctx.createMediaStreamSource(new MediaStream([track]))
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    const buf = new Uint8Array(analyser.frequencyBinCount)
    src.connect(analyser)
    const id = setInterval(() => {
      analyser.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) {
        const x = (buf[i] - 128) / 128
        sum += x * x
      }
      const rms = Math.sqrt(sum / buf.length)
      console.log('[offscreen]', `${label} input level (rms):`, rms.toFixed(3))
    }, 1000)
    track.addEventListener('ended', () => { try { clearInterval(id) } catch {} })
  } catch (e) {
    log('meter setup failed (non-fatal)', e)
  }
}

// record & mix
async function maybeGetMicStream(): Promise<MediaStream | null> {
  if (!WANT_MIC_MIX) return null
  try {
    // only succeeds if mic permission was previously granted to the extension origin
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
    const t = mic.getAudioTracks()[0]
    log('mic stream acquired:', !!t, 'muted:', t?.muted, 'enabled:', t?.enabled)
    return mic
  } catch (e) {
    log('mic getUserMedia failed (continuing without mic):', e)
    return null
  }
}

function mixAudio(tabStream: MediaStream, micStream: MediaStream | null): MediaStream {
  const tabAudio = tabStream.getAudioTracks()[0]
  if (!micStream || !tabAudio) return tabStream

  const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext
  const ctx = new AC()
  mixCtx = ctx
  void ctx.resume().catch(() => {})
  const dst = ctx.createMediaStreamDestination()

  try {
    const tabSource = ctx.createMediaStreamSource(new MediaStream([tabAudio]))
    tabSource.connect(dst)
  } catch (err) {
    log('tab source connect failed for mixing; using tab audio only', err)
    return tabStream
  }

  try {
    const micTrack = micStream.getAudioTracks()[0]
    if (micTrack) {
      const micSource = ctx.createMediaStreamSource(new MediaStream([micTrack]))
      micSource.connect(dst)
    }
  } catch (e) {
    log('mic source connect failed; continuing with tab audio only', e)
  }

  const final = new MediaStream([
    ...tabStream.getVideoTracks(),
    ...dst.stream.getAudioTracks()
  ])

  // DO NOT stop tabAudio here!!! stopping will kill the upstream source
  return final
}

// build constraints using a streamId. try 'tab' first, then 'desktop'
function makeConstraints(streamId: string, source: 'tab' | 'desktop'): MediaStreamConstraints {
  const mandatory = { chromeMediaSource: source, chromeMediaSourceId: streamId } as any
  return {
    audio: {
      mandatory,
      optional: [{ googDisableLocalEcho: false }]
    } as any,
    video: {
      mandatory: {
        ...mandatory,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 30
      }
    } as any
  }
}

// try to record using streamId
async function captureWithStreamId(streamId: string): Promise<MediaStream> {
  try {
    log(`Attempting getUserMedia with streamId ${streamId} source= tab`)
    const s = await navigator.mediaDevices.getUserMedia(makeConstraints(streamId, 'tab'))
    return s
  } catch (e1: any) {
    log('[gUM] failed for chromeMediaSource=tab:', e1?.name || e1, e1?.message || e1)
  }
  log(`Attempting getUserMedia with streamId ${streamId} source= desktop`)
  return await navigator.mediaDevices.getUserMedia(makeConstraints(streamId, 'desktop'))
}

let mediaRecorder: MediaRecorder | null = null
let chunks: BlobPart[] = []
let capturing = false
let playbackCtx: AudioContext | null = null
let mixCtx: AudioContext | null = null
// every stream opened for the current session: tab capture, mic, mixed.
// Stopping only the mixed stream (upstream behavior) leaked the original tab
// audio track, and a tab with a still-active capture cannot be captured again
// ("Cannot capture a tab with an active stream") until the offscreen dies.
let activeStreams: MediaStream[] = []

function releaseCapture() {
  activeStreams.forEach(s => { try { s.getTracks().forEach(t => t.stop()) } catch {} })
  activeStreams = []
  try { void mixCtx?.close() } catch {}
  mixCtx = null
  stopLocalPlayback()
}

// tabCapture mutes the captured tab for the user: whoever captures must route
// the audio back to the speakers. Only tab audio — routing the mic would echo.
function startLocalPlayback(tabAudio: MediaStreamTrack) {
  try {
    const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext
    playbackCtx = new AC()
    void playbackCtx.resume().catch(() => {})
    playbackCtx.createMediaStreamSource(new MediaStream([tabAudio])).connect(playbackCtx.destination)
    log('local playback of tab audio started')
  } catch (e) {
    log('local playback setup failed (call audio will stay muted while recording)', e)
  }
}

function stopLocalPlayback() {
  try { void playbackCtx?.close() } catch {}
  playbackCtx = null
}

async function prepareAndRecord(baseStream: MediaStream): Promise<void> {
  const a = baseStream.getAudioTracks()
  const v = baseStream.getVideoTracks()
  log('getUserMedia() tracks:', {
    audioCount: a.length,
    videoCount: v.length,
    audioMuted: a[0]?.muted,
    audioEnabled: a[0]?.enabled
  })
  a.forEach((t) => { try { t.enabled = true } catch {} })

  if (!a.length) {
    pushState(false, { warning: 'NO_TAB_AUDIO' })
  } else {
    const T = a[0]
    console.log('[offscreen] audio track settings:', T?.getSettings?.())
    console.log('[offscreen] audio track muted/enabled:', T?.muted, T?.enabled)
    T?.addEventListener('mute', () => console.log('[offscreen] track MUTED'))
    T?.addEventListener('unmute', () => console.log('[offscreen] track UNMUTED'))
  }
  if (!v.length) throw new Error('No video track in captured stream')

  // debug meters
  const rawAudio = baseStream.getAudioTracks()[0]
  if (rawAudio) attachRmsMeter(rawAudio, 'RAW')

  // keep the call audible for the user while recording
  if (rawAudio) startLocalPlayback(rawAudio)

  const micStream = await maybeGetMicStream()
  const mixedStream = mixAudio(baseStream, micStream)

  activeStreams = [baseStream, mixedStream]
  if (micStream) activeStreams.push(micStream)

  const finalAudio = mixedStream.getAudioTracks()[0]
  if (finalAudio) attachRmsMeter(finalAudio, 'FINAL')
  if (!finalAudio) log('WARNING: final stream has NO audio track — recording will be silent')

  log('final stream tracks -> video:', mixedStream.getVideoTracks().length, 'audio:', mixedStream.getAudioTracks().length)

  // (upstream had a 1s blocking RMS "safety check" here; removed — it only
  // logged a warning and added a full second to every recording start, while
  // the periodic RMS meters above already surface silent-input cases)

  chunks = []
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
    ? 'video/webm;codecs=vp8,opus'
    : 'video/webm'

  mediaRecorder = new MediaRecorder(mixedStream, {
    mimeType: mime,
    videoBitsPerSecond: 3_000_000,
    audioBitsPerSecond: 128_000
  })

  const started = new Promise<void>((resolve, reject) => {
    const startTimeout = setTimeout(() => reject(new Error('MediaRecorder did not start (timeout)')), 4000)

    mediaRecorder!.onstart = () => {
      clearTimeout(startTimeout)
      capturing = true
      pushState(true)
      log('MediaRecorder started')
      resolve()
    }

    mediaRecorder!.onerror = (e: any) => {
      clearTimeout(startTimeout)
      log('MediaRecorder error', e)
      releaseCapture()
      mediaRecorder = null
      capturing = false
      pushState(false)
      reject(new Error(e?.name || 'MediaRecorder error'))
    }

    mediaRecorder!.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size) chunks.push(e.data)
    }

    mediaRecorder!.onstop = async () => {
      try {
        const blob = new Blob(chunks, { type: mime })
        log('Finalizing; chunks =', chunks.length, 'blob.size =', blob.size)

        // filename suffix
        let suffix = 'google-meet'
        try {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
          suffix = inferSuffixFromActiveTabUrl(tabs[0]?.url || null)
        } catch {}

        const filename = `google-meet-recording-${suffix}-${Date.now()}.webm`
        const blobUrl = URL.createObjectURL(blob)
        getPort().postMessage({ type: 'OFFSCREEN_SAVE', filename, blobUrl })
      } catch (e) {
        log('Finalize/Save failed', e)
      } finally {
        releaseCapture()
        mediaRecorder = null
        chunks = []
        capturing = false
        pushState(false)
      }
    }
  })

  mediaRecorder.start(1000)

  // if tab navigates or video track ends, auto-stop
  mixedStream.getVideoTracks()[0]?.addEventListener('ended', () => {
    log('Video track ended')
    if (mediaRecorder && capturing) { try { mediaRecorder.stop() } catch {} }
  })

  await started
}

async function startRecordingFromStreamId(streamId: string): Promise<void> {
  if (capturing) { log('Already recording; ignoring start'); return }
  // defensively drop any stream left over by a crashed or interrupted attempt:
  // a lingering tab capture makes the new getUserMedia fail with
  // "Cannot capture a tab with an active stream"
  releaseCapture()
  const baseStream = await captureWithStreamId(streamId)
  await prepareAndRecord(baseStream)
}

function stopRecording() {
  if (!mediaRecorder || !capturing) {
    console.warn('[offscreen] Stop called but not recording')
    throw new Error('Not currently recording')
  }
  try { mediaRecorder.stop() } catch (e) { console.error('[offscreen] Stop error', e); throw e }
}

// port rpc
async function handleRpcMessage(msg: any): Promise<void> {
  try {
    if (msg?.type === 'OFFSCREEN_START') {
      const streamId = msg.streamId as string | undefined
      if (!streamId) return respond(msg, { ok: false, error: 'Missing streamId' })
      try {
        // wait until actually starts
        await startRecordingFromStreamId(streamId)
        return respond(msg, { ok: true })
      } catch (e: any) {
        return respond(msg, { ok: false, error: `${e?.name || 'Error'}: ${e?.message || e}` })
      }
    }

    if (msg?.type === 'OFFSCREEN_START_TAB') {
      // background must provide streamId
      return respond(msg, { ok: false, error: 'Use OFFSCREEN_START with streamId from background' })
    }

    if (msg?.type === 'OFFSCREEN_STOP') {
      try { stopRecording(); return respond(msg, { ok: true }) }
      catch (e) { return respond(msg, { ok: false, error: String(e) }) }
    }

    if (msg?.type === 'OFFSCREEN_STATUS') {
      let recording = false
      try {
        const res = await (chrome.storage as any)?.session?.get?.(['recording'])
        recording = !!res?.recording
      } catch {}
      return respond(msg, { recording })
    }

    if (msg?.type === 'DIAG_ECHO') {
      return respond(msg, { ok: true, pong: 'offscreen-alive' })
    }

    if (msg?.type === 'REVOKE_BLOB_URL' && typeof msg.blobUrl === 'string') {
      try { URL.revokeObjectURL(msg.blobUrl) } catch {}
      return
    }
  } catch (e) {
    console.error('[offscreen] error', e)
    respond(msg, { ok: false, error: String(e) })
  }
}

// open the initial port (attaches handleRpcMessage via connectPort)
getPort()

// allow background to check before port is ready
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  try {
    if (msg?.type === 'OFFSCREEN_PING') { sendResponse({ ok: true, via: 'onMessage' }); return true }
    if (msg?.type === 'OFFSCREEN_CONNECT') { connectPort(); sendResponse({ ok: true }); return true }
  } catch (e) { sendResponse({ ok: false, error: String(e) }) }
  return false
})
