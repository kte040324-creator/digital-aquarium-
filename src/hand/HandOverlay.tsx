
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DrawingUtils,
  FilesetResolver,
  HandLandmarker,
  type HandLandmarkerResult,
} from '@mediapipe/tasks-vision'
import type { HandTip, HandTips, HandUpdate } from './types'
import { clamp, dist2D, lerp } from './handMath'
import './handOverlay.css'

type Props = {
  enabled: boolean
  onUpdate: (u: HandUpdate) => void
}

const CAM_DEVICE_ID_KEY = 'mica_camera_deviceId'

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

const WASM_BASE =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm'

export function HandOverlay({ enabled, onUpdate }: Props) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const rafRef = useRef<number | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const landmarkerRef = useRef<HandLandmarker | null>(null)

  const lastEmitRef = useRef<HandUpdate | null>(null)
  const smoothedCursorRef = useRef<{ x: number; y: number } | null>(null)
  const prevPinchedRef = useRef<boolean>(false)

  const [err, setErr] = useState<string | null>(null)
  const [phase, setPhase] = useState<
    'idle' | 'picking' | 'loading' | 'ready' | 'error' | 'no-camera'
  >('idle')

  const mirrored = true

  const savedDeviceId =
    typeof window !== 'undefined' ? window.localStorage.getItem(CAM_DEVICE_ID_KEY) : null

  const [showPicker, setShowPicker] = useState<boolean>(() => !savedDeviceId)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [pendingDeviceId, setPendingDeviceId] = useState<string>(() => savedDeviceId ?? '')
  const [activeDeviceId, setActiveDeviceId] = useState<string>(() => savedDeviceId ?? '')

  const emptyUpdate = useMemo<HandUpdate>(
    () => ({
      cursor: { x: 0, y: 0, visible: false },
      pinch: {
        isPinched: false,
        justStarted: false,
        justEnded: false,
        distance: 1,
        strength: 0,
      },
      right: emptyTips(),
      left: emptyTips(),
      hasRight: false,
      hasLeft: false,
    }),
    [],
  )

  useEffect(() => {
    const onResize = () => {
      const canvas = canvasRef.current
      const stage = stageRef.current
      if (!stage) return
      const rect = stage.getBoundingClientRect()
      if (canvas) {
        canvas.width = Math.max(1, Math.round(rect.width))
        canvas.height = Math.max(1, Math.round(rect.height))
      }
    }
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    if (!enabled) {
      setPhase('idle')
      setErr(null)
      cleanup()
      onUpdate(emptyUpdate)
      return
    }

    let cancelled = false

    async function start() {
      try {
        setPhase(showPicker ? 'picking' : 'loading')
        setErr(null)

        if (showPicker) {
          // Don't auto-start the camera until the user picks one (first visit UX).
          onUpdate(emptyUpdate)
          return
        }

        const videoConstraints: MediaTrackConstraints = activeDeviceId
          ? { deviceId: { exact: activeDeviceId } }
          : { facingMode: 'user' }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
          audio: false,
        })
        if (cancelled) return
        streamRef.current = stream

        const video = videoRef.current
        if (!video) throw new Error('Video element not mounted')
        video.srcObject = stream
        await video.play()

        const vision = await FilesetResolver.forVisionTasks(WASM_BASE)
        if (cancelled) return

        landmarkerRef.current = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: MODEL_URL,
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numHands: 2,
        })

        if (cancelled) return
        setPhase('ready')
        tick()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setErr(msg)
        if (msg.toLowerCase().includes('notallowed')) setPhase('no-camera')
        else setPhase('error')
        cleanup()
        onUpdate(emptyUpdate)

        // If the chosen camera is missing / invalid (common when switching to NDI Virtual),
        // fall back to the picker.
        setShowPicker(true)
      }
    }

    start()

    return () => {
      cancelled = true
      cleanup()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, onUpdate, emptyUpdate, showPicker, activeDeviceId])

  useEffect(() => {
    if (!enabled) return
    if (!showPicker) return

    let cancelled = false

    async function refreshDevices() {
      try {
        const list = await navigator.mediaDevices.enumerateDevices()
        if (cancelled) return
        setDevices(list.filter((d) => d.kind === 'videoinput'))
      } catch (e) {
        // ignore; some browsers require permission first
      }
    }

    const onDeviceChange = () => refreshDevices()
    refreshDevices()
    navigator.mediaDevices.addEventListener?.('devicechange', onDeviceChange)
    return () => {
      cancelled = true
      navigator.mediaDevices.removeEventListener?.('devicechange', onDeviceChange)
    }
  }, [enabled, showPicker])

  async function requestPermissionAndRefresh() {
    try {
      // Asking for any camera once helps populate device labels in enumerateDevices().
      const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      tmp.getTracks().forEach((t) => t.stop())
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setErr(msg)
      setPhase(msg.toLowerCase().includes('notallowed') ? 'no-camera' : 'error')
      return
    }

    try {
      const list = await navigator.mediaDevices.enumerateDevices()
      setDevices(list.filter((d) => d.kind === 'videoinput'))
    } catch {
      // ignore
    }
  }

  function startWithPendingCamera() {
    if (pendingDeviceId) {
      window.localStorage.setItem(CAM_DEVICE_ID_KEY, pendingDeviceId)
    } else {
      window.localStorage.removeItem(CAM_DEVICE_ID_KEY)
    }
    setActiveDeviceId(pendingDeviceId)
    setShowPicker(false)
    setPhase('loading')
  }

  function cleanup() {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }

    prevPinchedRef.current = false
    smoothedCursorRef.current = null
    lastEmitRef.current = null

    landmarkerRef.current?.close()
    landmarkerRef.current = null

    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }

  function shouldEmit(next: HandUpdate) {
    const prev = lastEmitRef.current
    if (!prev) return true

    if (prev.hasRight !== next.hasRight) return true
    if (prev.hasLeft !== next.hasLeft) return true
    if (prev.cursor.visible !== next.cursor.visible) return true
    if (prev.pinch.isPinched !== next.pinch.isPinched) return true
    if (next.pinch.justStarted || next.pinch.justEnded) return true

    if (!next.cursor.visible) return false

    const dCursor =
      Math.abs(prev.cursor.x - next.cursor.x) +
      Math.abs(prev.cursor.y - next.cursor.y)
    if (dCursor > 2) return true

    const pr = prev.right
    const nr = next.right
    const pl = prev.left
    const nl = next.left
    const dTips =
      Math.abs(pr.index.x - nr.index.x) +
      Math.abs(pr.index.y - nr.index.y) +
      Math.abs(pr.thumb.x - nr.thumb.x) +
      Math.abs(pr.thumb.y - nr.thumb.y) +
      Math.abs(pl.index.x - nl.index.x) +
      Math.abs(pl.index.y - nl.index.y)

    return dTips > 0.003
  }

  function drawOverlay(result: HandLandmarkerResult) {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const w = canvas.width
    const h = canvas.height
    ctx.clearRect(0, 0, w, h)

    const drawer = new DrawingUtils(ctx)
    for (const landmarks of result.landmarks ?? []) {
      const mapped = mirrored
        ? landmarks.map((p) => ({ ...p, x: 1 - p.x }))
        : landmarks

      drawer.drawConnectors(mapped, HandLandmarker.HAND_CONNECTIONS, {
        color: 'rgba(225, 225, 225, 0.95)',
        lineWidth: 3,
      })
      drawer.drawLandmarks(mapped, {
        color: 'rgba(245, 245, 245, 0.95)',
        radius: 3,
      })

      const thumbTip = mapped[4]
      const indexTip = mapped[8]
      if (thumbTip)
        drawPoint(
          ctx,
          thumbTip.x * w,
          thumbTip.y * h,
          7,
          'rgba(220,220,220,0.95)',
          3,
        )
      if (indexTip)
        drawPoint(
          ctx,
          indexTip.x * w,
          indexTip.y * h,
          7,
          'rgba(220,220,220,0.95)',
          3,
        )

      if (thumbTip && indexTip) {
        const ax = thumbTip.x * w
        const ay = thumbTip.y * h
        const bx = indexTip.x * w
        const by = indexTip.y * h
        drawDistance(
          ctx,
          ax,
          ay,
          bx,
          by,
          `${Math.round(Math.hypot(ax - bx, ay - by))}px`,
        )
      }
    }
  }

  function tick() {
    rafRef.current = requestAnimationFrame(tick)

    const video = videoRef.current
    const lm = landmarkerRef.current
    if (!enabled || !video || !lm) return
    if (video.readyState < 2) return

    const now = performance.now()
    const result = lm.detectForVideo(video, now)

    const allLandmarks = result.landmarks ?? []
    const handedness = (result as any).handedness as any[] | undefined

    const rightIdx = findHandIndex(handedness, 'right')
    const leftIdx = findHandIndex(handedness, 'left')

    const rightLm = rightIdx !== -1 ? allLandmarks[rightIdx] : undefined
    const leftLm = leftIdx !== -1 ? allLandmarks[leftIdx] : undefined

    const hasRight = Boolean(rightLm && rightLm.length >= 21)
    const hasLeft = Boolean(leftLm && leftLm.length >= 21)

    if (phase === 'ready') drawOverlay(result)

    if (!hasRight && !hasLeft) {
      prevPinchedRef.current = false
      smoothedCursorRef.current = null
      const next = emptyUpdate
      if (shouldEmit(next)) {
        lastEmitRef.current = next
        onUpdate(next)
      }
      return
    }

    const primary = (hasRight ? rightLm : leftLm)!
    const indexTip = primary[8]
    const thumbTip = primary[4]

    const rawX = mirrored ? 1 - indexTip.x : indexTip.x
    const rawY = indexTip.y

    const nextX = clamp(rawX, 0, 1) * window.innerWidth
    const nextY = clamp(rawY, 0, 1) * window.innerHeight

    const prevSmooth = smoothedCursorRef.current
    const smooth = prevSmooth
      ? { x: lerp(prevSmooth.x, nextX, 0.35), y: lerp(prevSmooth.y, nextY, 0.35) }
      : { x: nextX, y: nextY }
    smoothedCursorRef.current = smooth

    const d = dist2D(indexTip.x, indexTip.y, thumbTip.x, thumbTip.y)
    const pinchOn = 0.04
    const pinchOff = 0.055

    let isPinched = prevPinchedRef.current
    if (!isPinched && d < pinchOn) isPinched = true
    if (isPinched && d > pinchOff) isPinched = false

    const justStarted = !prevPinchedRef.current && isPinched
    const justEnded = prevPinchedRef.current && !isPinched
    prevPinchedRef.current = isPinched

    const strength = clamp((pinchOff - d) / (pinchOff - pinchOn), 0, 1)

    const next: HandUpdate = {
      cursor: { x: smooth.x, y: smooth.y, visible: true },
      pinch: { isPinched, justStarted, justEnded, distance: d, strength },
      right: hasRight ? tipsFromLandmarks(rightLm!, mirrored) : emptyTips(),
      left: hasLeft ? tipsFromLandmarks(leftLm!, mirrored) : emptyTips(),
      hasRight,
      hasLeft,
    }

    if (shouldEmit(next)) {
      lastEmitRef.current = next
      onUpdate(next)
    }
  }

  return (
    <>
      <div
        className={mirrored ? 'handStageBg mirrored' : 'handStageBg'}
        ref={stageRef}
      >
        <video className="handStageVideo" ref={videoRef} playsInline muted />
      </div>

      <div
        className={mirrored ? 'handStageOverlay mirrored' : 'handStageOverlay'}
        aria-hidden
      >
        <canvas className="handStageCanvas" ref={canvasRef} />
      </div>

      {enabled && showPicker && (
        <div className="handStageUi">
          <div className="handStageUiCard">
            <div className="handStageUiTitle">카메라 선택</div>
            <div className="handStageUiSub">
              NDI Virtual을 연결했다면 목록에서 <b>NDI</b> / <b>Virtual</b> 이름이 들어간 카메라를 선택해줘.
            </div>

            <label className="handStageUiLabel">
              Camera
              <select
                className="handStageUiSelect"
                value={pendingDeviceId}
                onChange={(e) => setPendingDeviceId(e.target.value)}
              >
                <option value="">Default camera</option>
                {devices.map((d, idx) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Camera ${idx + 1}`}
                  </option>
                ))}
              </select>
            </label>

            <div className="handStageUiBtns">
              <button
                className="handStageUiBtn ghost"
                type="button"
                onClick={requestPermissionAndRefresh}
              >
                권한 요청 / 목록 새로고침
              </button>
              <button className="handStageUiBtn" type="button" onClick={startWithPendingCamera}>
                시작
              </button>
            </div>

            {err && <div className="handStageUiErr">{err}</div>}
          </div>
        </div>
      )}
    </>
  )
}

function emptyTips(): HandTips {
  return {
    thumb: { x: 0, y: 0, visible: false },
    index: { x: 0, y: 0, visible: false },
    middle: { x: 0, y: 0, visible: false },
    ring: { x: 0, y: 0, visible: false },
    pinky: { x: 0, y: 0, visible: false },
  }
}

function tipsFromLandmarks(landmarks: any[], mirrored: boolean): HandTips {
  return {
    thumb: toTip(landmarks[4], mirrored),
    index: toTip(landmarks[8], mirrored),
    middle: toTip(landmarks[12], mirrored),
    ring: toTip(landmarks[16], mirrored),
    pinky: toTip(landmarks[20], mirrored),
  }
}

function toTip(
  p: { x: number; y: number } | undefined,
  mirrored: boolean,
): HandTip {
  if (!p) return { x: 0, y: 0, visible: false }
  const x = mirrored ? 1 - p.x : p.x
  return {
    x: clamp(x, 0, 1),
    y: clamp(p.y, 0, 1),
    visible: true,
  }
}

function findHandIndex(handedness: any[] | undefined, target: 'left' | 'right') {
  if (!handedness || !Array.isArray(handedness)) return -1
  for (let i = 0; i < handedness.length; i++) {
    const cats = handedness[i]
    const first = Array.isArray(cats) ? cats[0] : undefined
    const name = (first && (first.categoryName || first.displayName)) || ''
    if (String(name).toLowerCase() === target) return i
  }
  return -1
}

function drawPoint(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  fill: string,
  strokeW: number,
) {
  ctx.save()
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fillStyle = fill
  ctx.fill()
  ctx.lineWidth = strokeW
  ctx.strokeStyle = 'rgba(0,0,0,0.55)'
  ctx.stroke()
  ctx.restore()
}

function drawDistance(
  ctx: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  label: string,
) {
  ctx.save()
  ctx.lineWidth = 3
  ctx.strokeStyle = 'rgba(255,255,255,0.55)'
  ctx.beginPath()
  ctx.moveTo(ax, ay)
  ctx.lineTo(bx, by)
  ctx.stroke()

  const mx = (ax + bx) / 2
  const my = (ay + by) / 2
  ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
  const padX = 6
  const padY = 4
  const metrics = ctx.measureText(label)
  const tw = metrics.width
  const th = 12

  ctx.fillStyle = 'rgba(20,20,20,0.45)'
  roundRect(
    ctx,
    mx - tw / 2 - padX,
    my - th - padY - 6,
    tw + padX * 2,
    th + padY * 2,
    8,
  )
  ctx.fill()

  ctx.fillStyle = 'rgba(235,235,235,0.9)'
  ctx.fillText(label, mx - tw / 2, my - 6)
  ctx.restore()
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}
