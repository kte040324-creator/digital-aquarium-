import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'

type Emitter = { id: string; x: number; y: number }

type Props = {
  emitters: Emitter[]
  containerRef: React.RefObject<HTMLElement | null>
  above?: boolean
}

type Dot = {
  x: number
  y: number
  r: number
  vx: number
  vy: number
  age: number
  life: number
  a0: number
}

const MOVE_EPS = 0.004
const JITTER = 0.8
const MAX_DOTS = 4200
const RATE_MIN = 10
const RATE_MAX = 30

export function TrailDots({ emitters, containerRef, above }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const dotsRef = useRef<Dot[]>([])
  const emittersRef = useRef<Emitter[]>(emitters)
  const prevByIdRef = useRef<Record<string, { x: number; y: number }>>({})
  const rafRef = useRef<number | null>(null)
  const lastTRef = useRef<number>(performance.now())
  const rateRef = useRef<number>(pickRate())
  const rateTRef = useRef<number>(performance.now())
  const accRef = useRef<number>(0)

  emittersRef.current = emitters

  const style = useMemo<React.CSSProperties>(
    () => ({
      // Render in a fixed, top-most layer so it can't be covered by HandOverlay stacking contexts.
      position: 'fixed',
      inset: 0,
      width: '100%',
      height: '100%',
      display: 'block',
      pointerEvents: 'none',
      zIndex: above ? 1000 : 1,
    }),
    [above],
  )

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const resize = () => {
      const dpr = Math.max(1, window.devicePixelRatio || 1)
      canvas.width = Math.max(1, Math.round(window.innerWidth * dpr))
      canvas.height = Math.max(1, Math.round(window.innerHeight * dpr))
    }

    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [containerRef])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const tick = () => {
      rafRef.current = requestAnimationFrame(tick)
      const now = performance.now()
      const dt = Math.min(50, Math.max(0, now - lastTRef.current))
      lastTRef.current = now

      const dpr = Math.max(1, window.devicePixelRatio || 1)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const cssW = canvas.width / dpr
      const cssH = canvas.height / dpr

      const containerEl = containerRef.current
      const rect = containerEl ? containerEl.getBoundingClientRect() : null

      const emittersNow = emittersRef.current

      // randomize spawn rate each second in [10..30] dots/sec
      if (now - rateTRef.current > 1000) {
        rateTRef.current = now
        rateRef.current = pickRate()
      }

      // spawn dots strictly along each GIF path (prev -> now)
      if (rect) {
        // build moved segments
        const segs: Array<{ ax: number; ay: number; bx: number; by: number; d: number }> = []
        let totalD = 0

      for (const e of emittersNow) {
        const prev = prevByIdRef.current[e.id] ?? { x: e.x, y: e.y }
        const dx = e.x - prev.x
        const dy = e.y - prev.y
        const d = Math.hypot(dx, dy)
        if (d < MOVE_EPS) continue
          segs.push({ ax: prev.x, ay: prev.y, bx: e.x, by: e.y, d })
          totalD += d
      }

        // spawn budget this frame
        accRef.current += (rateRef.current * dt) / 1000
        const spawnN = Math.floor(accRef.current)
        accRef.current -= spawnN

        if (spawnN > 0 && totalD > 0.0001 && segs.length) {
          for (let i = 0; i < spawnN; i++) {
            // pick a segment weighted by distance
            let rPick = Math.random() * totalD
            let s = segs[0]
            for (let j = 0; j < segs.length; j++) {
              rPick -= segs[j].d
              if (rPick <= 0) {
                s = segs[j]
                break
              }
            }

            // bias towards the new position so it visually "follows"
            const tSeg = Math.pow(Math.random(), 0.55)
            const cx = s.ax + (s.bx - s.ax) * tSeg + rand(-JITTER, JITTER)
            const cy = s.ay + (s.by - s.ay) * tSeg + rand(-JITTER, JITTER)
            const x = rect.left + cx
            const y = rect.top + cy
            dotsRef.current.push({
              x,
              y,
              r: 1.2 + Math.random() * 2.0,
              vx: rand(-6, 6),
              vy: -(10 + Math.random() * 18),
              age: 0,
              life: 2200 + Math.random() * 2600,
              a0: 0.22 + Math.random() * 0.22,
            })
          }
        }
      }

      for (const e of emittersNow) prevByIdRef.current[e.id] = { x: e.x, y: e.y }

      if (dotsRef.current.length > MAX_DOTS) {
        dotsRef.current.splice(0, dotsRef.current.length - MAX_DOTS)
      }

      // draw
      ctx.clearRect(0, 0, cssW, cssH)
      ctx.globalCompositeOperation = 'screen'

      const dots = dotsRef.current
      for (let i = dots.length - 1; i >= 0; i--) {
        const p = dots[i]
        p.age += dt
        if (p.age >= p.life) {
          dots.splice(i, 1)
          continue
        }
        const t = p.age / p.life
        const a = p.a0 * (1 - t) * (1 - t)

        // drift a bit so it reads like bubbles
        const k = dt / 1000
        p.x += p.vx * k
        p.y += p.vy * k
        p.vx *= 0.993
        p.vy *= 0.999

        // dot now styled like a tiny bubble
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(200, 248, 255, ${a})`
        ctx.fill()
        ctx.lineWidth = 0.9
        ctx.strokeStyle = `rgba(255,255,255,${a * 0.95})`
        ctx.stroke()
      }

      ctx.globalCompositeOperation = 'source-over'
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  return <canvas ref={canvasRef} style={style} aria-hidden />
}

function rand(min: number, max: number) {
  return min + Math.random() * (max - min)
}

function pickRate() {
  return RATE_MIN + Math.floor(Math.random() * (RATE_MAX - RATE_MIN + 1))
}

