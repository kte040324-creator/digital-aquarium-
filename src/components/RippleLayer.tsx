import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'

type Point = { id: string; x: number; y: number }

type Props = {
  /** Points are in container coordinates (CSS pixels) */
  points: Point[]
  containerRef: React.RefObject<HTMLElement | null>
  above?: boolean
}

type Ripple = {
  x: number
  y: number
  r: number
  vr: number
  age: number
  life: number
  a0: number
  lw: number
}

const MOVE_EPS_PX = 14
const RIPPLE_COOLDOWN_MS = 140
const MAX_RIPPLES = 160

export function RippleLayer({ points, containerRef, above }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const pointsRef = useRef<Point[]>(points)
  const rectRef = useRef<DOMRect | null>(null)
  const prevByIdRef = useRef<Record<string, { x: number; y: number }>>({})
  const lastSpawnByIdRef = useRef<Record<string, number>>({})
  const ripplesRef = useRef<Ripple[]>([])
  const rafRef = useRef<number | null>(null)
  const lastTRef = useRef<number>(performance.now())

  pointsRef.current = points

  const style = useMemo<React.CSSProperties>(
    () => ({
      position: 'fixed',
      inset: 0,
      width: '100%',
      height: '100%',
      display: 'block',
      pointerEvents: 'none',
      zIndex: above ? 950 : 1,
    }),
    [above],
  )

  useLayoutEffect(() => {
    const el = containerRef.current
    const canvas = canvasRef.current
    if (!canvas) return

    const resize = () => {
      const dpr = Math.max(1, window.devicePixelRatio || 1)
      canvas.width = Math.max(1, Math.round(window.innerWidth * dpr))
      canvas.height = Math.max(1, Math.round(window.innerHeight * dpr))
      rectRef.current = el ? el.getBoundingClientRect() : null
    }

    resize()
    window.addEventListener('resize', resize)
    const ro = el ? new ResizeObserver(() => resize()) : null
    if (el && ro) ro.observe(el)
    return () => {
      window.removeEventListener('resize', resize)
      if (el && ro) ro.disconnect()
    }
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
      const w = canvas.width / dpr
      const h = canvas.height / dpr

      // update rect occasionally (container can move due to layout)
      const el = containerRef.current
      if (el) rectRef.current = el.getBoundingClientRect()
      const rect = rectRef.current

      // spawn ripples when points move
      const pts = pointsRef.current
      for (const p of pts) {
        const prev = prevByIdRef.current[p.id]
        if (!prev) {
          prevByIdRef.current[p.id] = { x: p.x, y: p.y }
          continue
        }
        const d = Math.hypot(p.x - prev.x, p.y - prev.y)
        const lastSpawn = lastSpawnByIdRef.current[p.id] ?? 0
        if (d >= MOVE_EPS_PX && now - lastSpawn >= RIPPLE_COOLDOWN_MS) {
          prevByIdRef.current[p.id] = { x: p.x, y: p.y }
          lastSpawnByIdRef.current[p.id] = now
          ripplesRef.current.push({
            x: p.x,
            y: p.y,
            r: 6 + Math.random() * 8,
            vr: 34 + Math.random() * 62,
            age: 0,
            life: 1100 + Math.random() * 1100,
            a0: 0.12 + Math.random() * 0.14,
            lw: 0.9 + Math.random() * 0.9,
          })
        }
      }

      // cap
      if (ripplesRef.current.length > MAX_RIPPLES) {
        ripplesRef.current.splice(0, ripplesRef.current.length - MAX_RIPPLES)
      }

      ctx.clearRect(0, 0, w, h)
      if (rect) {
        ctx.save()
        ctx.beginPath()
        ctx.rect(rect.left, rect.top, rect.width, rect.height)
        ctx.clip()
      }

      ctx.globalCompositeOperation = 'screen'
      const rs = ripplesRef.current
      for (let i = rs.length - 1; i >= 0; i--) {
        const r = rs[i]
        r.age += dt
        if (r.age >= r.life) {
          rs.splice(i, 1)
          continue
        }
        const t = r.age / r.life
        r.r += (r.vr * dt) / 1000
        const a = r.a0 * (1 - t) * (1 - t)

        ctx.beginPath()
        ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(200, 248, 255, ${a})`
        ctx.lineWidth = r.lw
        ctx.stroke()

        // subtle second ring
        ctx.beginPath()
        ctx.arc(r.x, r.y, r.r * 0.66, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(255,255,255, ${a * 0.55})`
        ctx.lineWidth = Math.max(0.6, r.lw * 0.7)
        ctx.stroke()
      }
      ctx.globalCompositeOperation = 'source-over'

      if (rect) ctx.restore()
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [containerRef])

  return <canvas ref={canvasRef} style={style} aria-hidden />
}

