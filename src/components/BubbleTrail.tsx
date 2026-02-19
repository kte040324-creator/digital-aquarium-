import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'

type Emitter = { id: string; x: number; y: number }

type Props = {
  /** bubble emit points in container coordinates */
  emitters: Emitter[]
  /** container element that defines sizing */
  containerRef: React.RefObject<HTMLElement | null>
  /** draw above fish if true */
  above?: boolean
}

type Bubble = {
  x: number
  y: number
  r: number
  vx: number
  vy: number
  age: number
  life: number
  a0: number
}

const MAX_PER_TICK = 520
const JITTER_PX = 1.2
const MOVE_EPS = 0.12 // px: consider "moved"

export function BubbleTrail({ emitters, containerRef, above }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const bubblesRef = useRef<Bubble[]>([])
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
      position: 'absolute',
      inset: 0,
      width: '100%',
      height: '100%',
      display: 'block',
      pointerEvents: 'none',
      zIndex: above ? 999 : 1,
    }),
    [above],
  )

  useLayoutEffect(() => {
    const el = containerRef.current
    const canvas = canvasRef.current
    if (!el || !canvas) return

    const resize = () => {
      const rect = el.getBoundingClientRect()
      const dpr = Math.max(1, window.devicePixelRatio || 1)
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(rect.height * dpr))
    }

    resize()
    const ro = new ResizeObserver(() => resize())
    ro.observe(el)
    return () => ro.disconnect()
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

      // every second, randomize spawn rate in [50..1000] bubbles/sec
      if (now - rateTRef.current > 1000) {
        rateTRef.current = now
        rateRef.current = pickRate()
      }

      const w = canvas.width
      const h = canvas.height

      // draw in CSS pixel space for stable alignment
      const dpr = Math.max(1, window.devicePixelRatio || 1)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const cssW = w / dpr
      const cssH = h / dpr

      // spawn budget (random 50~1000 per sec), but we ALWAYS place bubbles on movement paths
      const emittersNow = emittersRef.current
      if (emittersNow.length) {
        accRef.current += (rateRef.current * dt) / 1000
        const spawnNBase = Math.floor(accRef.current)
        accRef.current -= spawnNBase

        // movement-based emission (per-emitter, by id): spawn *on the segment* prev->now (true path)
        let totalD = 0
        const ds: number[] = []
        const segs: Array<{ id: string; ax: number; ay: number; bx: number; by: number; d: number }> =
          []
        let movedCount = 0

        for (const e of emittersNow) {
          const prev = prevByIdRef.current[e.id] ?? { x: e.x, y: e.y }
          const d = Math.hypot(e.x - prev.x, e.y - prev.y)
          segs.push({ id: e.id, ax: prev.x, ay: prev.y, bx: e.x, by: e.y, d })
          ds.push(d)
          totalD += d
          if (d > MOVE_EPS) movedCount++
        }

        // Total spawn this frame:
        // - Use the random base rate (min 50 ~ max 1000/sec), but only when there is movement.
        // - Guarantee at least 1 bubble per moved fish per frame (so trail never "disappears").
        const spawnN = Math.min(
          MAX_PER_TICK,
          totalD > 0 ? Math.max(spawnNBase, movedCount) : 0,
        )

        if (spawnN > 0 && totalD > 0.01) {
          // allocate counts per emitter by moved distance
          const counts: number[] = new Array(segs.length).fill(0)
          let used = 0
          for (let i = 0; i < segs.length; i++) {
            const c = Math.floor((spawnN * segs[i].d) / totalD)
            counts[i] = c
            used += c
          }
          // distribute remainder by roulette
          let rem = Math.max(0, spawnN - used)
          while (rem-- > 0) {
            let rPick = Math.random() * totalD
            let idx = 0
            for (; idx < segs.length; idx++) {
              rPick -= segs[idx].d
              if (rPick <= 0) break
            }
            if (idx >= segs.length) idx = segs.length - 1
            counts[idx]++
          }

          // ensure every moved emitter gets at least 1 (per-fish path visibility)
          for (let i = 0; i < segs.length; i++) {
            if (segs[i].d > MOVE_EPS && counts[i] === 0) counts[i] = 1
          }

          for (let i = 0; i < segs.length; i++) {
            const s = segs[i]
            const n = counts[i]
            if (n <= 0) continue
            for (let j = 0; j < n; j++) {
              const tSeg = n <= 1 ? 1 : j / (n - 1)
              const ex = s.ax + (s.bx - s.ax) * tSeg
              const ey = s.ay + (s.by - s.ay) * tSeg

              const r = 1.3 + Math.random() * 2.2
              const x = ex + rand(-JITTER_PX, JITTER_PX)
              const y = ey + rand(-JITTER_PX, JITTER_PX)
              const vy = -(6 + Math.random() * 12) // gentler rise; keep trail attached
              const vx = rand(-2.5, 2.5)
              const life = 2800 + Math.random() * 3600
              bubblesRef.current.push({
                x,
                y,
                r,
                vx,
                vy,
                age: 0,
                life,
                a0: 0.26 + Math.random() * 0.24,
              })
            }
          }
        }
      }
      for (const e of emittersNow) prevByIdRef.current[e.id] = { x: e.x, y: e.y }

      // cap to prevent runaway
      if (bubblesRef.current.length > 2500) {
        bubblesRef.current.splice(0, bubblesRef.current.length - 2500)
      }

      // update + draw
      ctx.clearRect(0, 0, cssW, cssH)
      ctx.globalCompositeOperation = 'source-over'

      // Debug: draw tiny points at current emitter positions (helps verify overlay is visible)
      if (emittersNow.length) {
        ctx.fillStyle = 'rgba(255, 60, 60, 0.85)'
        for (const e of emittersNow) {
          ctx.beginPath()
          ctx.arc(e.x, e.y, 3.2, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      ctx.globalCompositeOperation = 'screen'
      const bubbles = bubblesRef.current
      for (let i = bubbles.length - 1; i >= 0; i--) {
        const b = bubbles[i]
        b.age += dt
        if (b.age >= b.life) {
          bubbles.splice(i, 1)
          continue
        }

        const t = b.age / b.life
        // ease-out fade
        const alpha = b.a0 * (1 - t) * (1 - t)
        b.x += b.vx * (dt / 1000)
        b.y += b.vy * (dt / 1000)
        // gentle drift
        b.vx *= 0.995
        b.vy *= 0.998

        ctx.beginPath()
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(180, 250, 255, ${alpha})`
        ctx.fill()
        ctx.lineWidth = 0.8
        ctx.strokeStyle = `rgba(255,255,255,${alpha * 0.9})`
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

function pickRate() {
  return 50 + Math.floor(Math.random() * (1000 - 50 + 1))
}

function rand(min: number, max: number) {
  return min + Math.random() * (max - min)
}

