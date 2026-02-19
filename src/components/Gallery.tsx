import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { HandUpdate } from '../hand/types'
import { clamp, lerp } from '../hand/handMath'
import './gallery.css'
import { TrailDots } from './TrailDots'
import { RippleLayer } from './RippleLayer'

type Item = {
  id: string
  title: string
  kind: string
  sizeMul: number
  x: number
  y: number
  w: number
  h: number
  src: string
}

type Props = {
  hand: HandUpdate
}

const PAD = 16
// Fish size: reduce to 2/3 of the current size.
// Fish size: slightly smaller overall.
const SCALE = 0.5 * (2 / 3) * 0.85
const DEFAULT_W = 240 * SCALE
const DEFAULT_H = 240 * SCALE

const SPREAD_CLOSE = 0.035
// Make "open" easier to reach so the spread isn't too tight.
const SPREAD_OPEN = 0.115
const FOLLOW_OPEN = 0.42
const FOLLOW_CLOSE = 0.78
const BUCKETS = 7
const OPEN_MIN_N = 0.03
const OPEN_MAX_N = 0.97
const OPEN_MIN_DIST_N = 0.28
const OPEN_MIN_DIST_SAME_N = 0.42
const CLOSE_JITTER_PX = 36
const OPEN_FOR_FEED = 0.35
const LEFT_FEED_PINCH_ON = 0.045
const LEFT_FEED_PINCH_OFF = 0.065
const FEED_TTL_MS = 1600
const FOOD_LERP = 0.22
const FOOD_WEIGHT = 0.92
// How fast fish move toward food (left-hand pinch). Lower = slower.
// (Further slowed down ~10x for more \"individual\" feel.)
const ATTRACT_FOLLOW = 0.0078
const SEP_ITERS = 2
const SEP_PAD_PX = 16
const SEP_STRENGTH = 0.55

export function Gallery({ hand }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const didInitPosRef = useRef(false)
  const scatterRef = useRef<{
    bucket: number
    vecById: Record<
      string,
      {
        openNX: number
        openNY: number
        closeX: number
        closeY: number
        attractS: number
        foodW: number
        swimP: number
        swimS: number
        swimAX: number
        swimAY: number
        swimBX: number
        swimBY: number
      }
    >
  }>({ bucket: -1, vecById: {} })
  const prevLeftPinchedRef = useRef(false)
  const foodRef = useRef<{
    x: number
    y: number
    ttlMs: number
    lastTs: number
  }>({ x: 0, y: 0, ttlMs: 0, lastTs: performance.now() })

  const [items, setItems] = useState<Item[]>(() => makeItems())
  const emitters = items.map((it) => ({
    id: it.id,
    x: it.x + (it.w || DEFAULT_W) / 2,
    y: it.y + (it.h || DEFAULT_H) / 2,
  }))

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return

    const clampAll = () => {
      const rect = el.getBoundingClientRect()

      // one-time: randomize initial positions (avoid same-kind clustering)
      if (!didInitPosRef.current && rect.width > 10 && rect.height > 10) {
        didInitPosRef.current = true
        const chosen: Array<{ cx: number; cy: number; kind: string }> = []
        setItems((prev) => {
          const next = prev.map((it) => {
            const w = it.w || DEFAULT_W
            const h = it.h || DEFAULT_H
            const maxX = Math.max(PAD, rect.width - PAD - w)
            const maxY = Math.max(PAD, rect.height - PAD - h)

            let cx = PAD + Math.random() * (maxX - PAD) + w / 2
            let cy = PAD + Math.random() * (maxY - PAD) + h / 2

            for (let tries = 0; tries < 48; tries++) {
              const tx = PAD + Math.random() * (maxX - PAD) + w / 2
              const ty = PAD + Math.random() * (maxY - PAD) + h / 2
              const ok = chosen.every((p) => {
                const d = Math.hypot(p.cx - tx, p.cy - ty)
                const minD = p.kind === it.kind ? 160 : 120
                return d > minD
              })
              if (ok || tries > 46) {
                cx = tx
                cy = ty
                break
              }
            }

            chosen.push({ cx, cy, kind: it.kind })
            return {
              ...it,
              x: clamp(cx - w / 2, PAD, maxX),
              y: clamp(cy - h / 2, PAD, maxY),
            }
          })
          return next
        })
      }

      setItems((prev) =>
        prev.map((it) => {
          const w = it.w || DEFAULT_W
          const h = it.h || DEFAULT_H
          const maxX = Math.max(PAD, rect.width - PAD - w)
          const maxY = Math.max(PAD, rect.height - PAD - h)
          return { ...it, x: clamp(it.x, PAD, maxX), y: clamp(it.y, PAD, maxY) }
        }),
      )
    }
    clampAll()
    const ro = new ResizeObserver(() => clampAll())
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (!hand.hasRight) return

    const rect = el.getBoundingClientRect()
    const tips = hand.right
    const { thumb, index, middle, ring } = tips
    if (!thumb.visible || !index.visible || !middle.visible || !ring.visible) return

    // Hand center (normalized)
    const cxN = (thumb.x + index.x + middle.x + ring.x) / 4
    const cyN = (thumb.y + index.y + middle.y + ring.y) / 4

    // Spread metric (normalized): average distance between adjacent fingers
    const d01 = hypot(index.x - thumb.x, index.y - thumb.y)
    const d12 = hypot(middle.x - index.x, middle.y - index.y)
    const d23 = hypot(ring.x - middle.x, ring.y - middle.y)
    const spread = (d01 + d12 + d23) / 3

    // Map spread to openness (0..1)
    const tRaw = (spread - SPREAD_CLOSE) / (SPREAD_OPEN - SPREAD_CLOSE)
    const t = clamp(tRaw, 0, 1)
    // Ease-out so it spreads wider with the same physical hand opening.
    const tEase = 1 - Math.pow(1 - t, 3)

    // When closing, converge faster for a "snap" feeling
    const follow = lerp(FOLLOW_CLOSE, FOLLOW_OPEN, t)

    const cx = cxN * rect.width
    const cy = cyN * rect.height

    const bucket = Math.floor(t * BUCKETS) // 0..BUCKETS-1

    setItems((prev) => {
      // regenerate random targets when bucket changes
      if (scatterRef.current.bucket !== bucket) {
        scatterRef.current.bucket = bucket
        const chosen: Array<{ x: number; y: number; kind: string }> = []
        const nextVec: typeof scatterRef.current.vecById = {}

        const shuffled = [...prev].sort(() => Math.random() - 0.5)
        for (const it of shuffled) {
          let x = OPEN_MIN_N + Math.random() * (OPEN_MAX_N - OPEN_MIN_N)
          let y = OPEN_MIN_N + Math.random() * (OPEN_MAX_N - OPEN_MIN_N)

          for (let tries = 0; tries < 24; tries++) {
            const tx = OPEN_MIN_N + Math.random() * (OPEN_MAX_N - OPEN_MIN_N)
            const ty = OPEN_MIN_N + Math.random() * (OPEN_MAX_N - OPEN_MIN_N)
            const ok = chosen.every((p) => {
              const d = Math.hypot(p.x - tx, p.y - ty)
              if (d <= OPEN_MIN_DIST_N) return false
              if (p.kind === it.kind && d <= OPEN_MIN_DIST_SAME_N) return false
              return true
            })
            if (
              ok ||
              tries > 22
            ) {
              x = tx
              y = ty
              break
            }
          }

          chosen.push({ x, y, kind: it.kind })
          nextVec[it.id] = {
            openNX: x,
            openNY: y,
            closeX: (Math.random() * 2 - 1) * CLOSE_JITTER_PX,
            closeY: (Math.random() * 2 - 1) * CLOSE_JITTER_PX,
            // per-fish chase speed variance (individual feel)
            attractS: 0.55 + Math.random() * 1.25,
            // per-fish pull strength towards food (breaks uniformity)
            foodW: clamp(0.62 + Math.random() * 0.33, 0.55, 0.95),
            // per-fish swim noise params (curvy / random approach)
            swimP: Math.random() * Math.PI * 2,
            swimS: 0.55 + Math.random() * 1.25,
            swimAX: 18 + Math.random() * 36,
            swimAY: 12 + Math.random() * 30,
            swimBX: 6 + Math.random() * 22,
            swimBY: 6 + Math.random() * 18,
          }
        }

        scatterRef.current.vecById = nextVec
      }

      // Feed gesture: left thumb-index pinch creates/updates a food target.
      const now = performance.now()
      const dt = Math.max(0, now - foodRef.current.lastTs)
      foodRef.current.lastTs = now
      foodRef.current.ttlMs = Math.max(0, foodRef.current.ttlMs - dt)

      const lt = hand.left
      const canFeed = hand.hasLeft && lt.thumb.visible && lt.index.visible
      const pinchDist = canFeed
        ? Math.hypot(lt.thumb.x - lt.index.x, lt.thumb.y - lt.index.y)
        : 1

      let isLeftPinched = prevLeftPinchedRef.current
      if (!isLeftPinched && pinchDist < LEFT_FEED_PINCH_ON) isLeftPinched = true
      if (isLeftPinched && pinchDist > LEFT_FEED_PINCH_OFF) isLeftPinched = false
      const justStarted = !prevLeftPinchedRef.current && isLeftPinched
      prevLeftPinchedRef.current = isLeftPinched

      if (canFeed && (justStarted || isLeftPinched)) {
        const fx = lt.index.x * rect.width
        const fy = lt.index.y * rect.height
        if (foodRef.current.ttlMs <= 0 || justStarted) {
          foodRef.current.x = fx
          foodRef.current.y = fy
        } else {
          foodRef.current.x = lerp(foodRef.current.x, fx, FOOD_LERP)
          foodRef.current.y = lerp(foodRef.current.y, fy, FOOD_LERP)
        }
        foodRef.current.ttlMs = FEED_TTL_MS
      }

      const useFood = foodRef.current.ttlMs > 0 && t >= OPEN_FOR_FEED
      const foodX = foodRef.current.x
      const foodY = foodRef.current.y
      const tSec = now * 0.001

      // 1) move towards targets
      const moved = prev.map((it) => {
        const w = it.w || DEFAULT_W
        const h = it.h || DEFAULT_H

        const maxX = Math.max(PAD, rect.width - PAD - w)
        const maxY = Math.max(PAD, rect.height - PAD - h)

        const v = scatterRef.current.vecById[it.id]
        const openNX = v?.openNX ?? 0.5
        const openNY = v?.openNY ?? 0.5
        const closeX = v?.closeX ?? 0
        const closeY = v?.closeY ?? 0
        const attractS = v?.attractS ?? 1
        const foodW = v?.foodW ?? FOOD_WEIGHT
        const swimP = v?.swimP ?? 0
        const swimS = v?.swimS ?? 1
        const swimAX = v?.swimAX ?? 28
        const swimAY = v?.swimAY ?? 18
        const swimBX = v?.swimBX ?? 12
        const swimBY = v?.swimBY ?? 10

        const openTargetX = openNX * rect.width - w / 2
        const openTargetY = openNY * rect.height - h / 2

        const closeTargetX = cx + closeX - w / 2
        const closeTargetY = cy + closeY - h / 2

        let targetX = lerp(closeTargetX, openTargetX, tEase)
        let targetY = lerp(closeTargetY, openTargetY, tEase)

        // Feeding: each fish is attracted to the food from its current spread position.
        if (useFood) {
          // Add per-fish curvy offset so the path isn't a uniform straight line.
          const tt = tSec * swimS + swimP
          const ox =
            Math.sin(tt) * swimAX + Math.sin(tt * 0.73 + swimP * 1.7) * swimBX
          const oy =
            Math.cos(tt * 1.08 + swimP) * swimAY +
            Math.sin(tt * 0.61 + swimP * 0.3) * swimBY

          const foodTargetX = foodX - w / 2 + ox
          const foodTargetY = foodY - h / 2 + oy
          targetX = lerp(targetX, foodTargetX, foodW)
          targetY = lerp(targetY, foodTargetY, foodW)
        }

        const nx = clamp(targetX, PAD, maxX)
        const ny = clamp(targetY, PAD, maxY)

        const effFollow = clamp(
          lerp(follow, ATTRACT_FOLLOW, useFood ? 1 : 0) * attractS,
          0.0008,
          0.92,
        )

        return {
          ...it,
          x: lerp(it.x, nx, effFollow),
          y: lerp(it.y, ny, effFollow),
        }
      })

      // 2) separation pass (reduce overlaps)
      // Stronger when spread/open; a bit weaker while feeding so it still "gathers".
      const sepFactor = (useFood ? 0.45 : 0.9) * clamp(0.35 + t * 0.85, 0, 1)

      const out = moved.map((it) => ({ ...it }))
      for (let iter = 0; iter < SEP_ITERS; iter++) {
        for (let i = 0; i < out.length; i++) {
          const a = out[i]
          const aw = a.w || DEFAULT_W
          const ah = a.h || DEFAULT_H
          const acx = a.x + aw / 2
          const acy = a.y + ah / 2

          for (let j = i + 1; j < out.length; j++) {
            const b = out[j]
            const bw = b.w || DEFAULT_W
            const bh = b.h || DEFAULT_H
            const bcx = b.x + bw / 2
            const bcy = b.y + bh / 2

            let dx = bcx - acx
            let dy = bcy - acy
            let d = Math.hypot(dx, dy)

            // minimum center distance based on visual size
            const minD =
              (Math.max(aw, ah) + Math.max(bw, bh)) * 0.42 + SEP_PAD_PX

            if (d < minD) {
              if (d < 0.0001) {
                // completely overlapped: pick a stable-ish random direction
                const ang = (i * 999 + j * 313) % 360
                dx = Math.cos((ang * Math.PI) / 180)
                dy = Math.sin((ang * Math.PI) / 180)
                d = 1
              }
              const push = ((minD - d) / minD) * SEP_STRENGTH * sepFactor
              const ux = dx / d
              const uy = dy / d
              const px = ux * push * minD
              const py = uy * push * minD

              // push half/half
              a.x -= px * 0.5
              a.y -= py * 0.5
              b.x += px * 0.5
              b.y += py * 0.5
            }
          }
        }
      }

      // clamp after separation
      for (const it of out) {
        const w = it.w || DEFAULT_W
        const h = it.h || DEFAULT_H
        const maxX = Math.max(PAD, rect.width - PAD - w)
        const maxY = Math.max(PAD, rect.height - PAD - h)
        it.x = clamp(it.x, PAD, maxX)
        it.y = clamp(it.y, PAD, maxY)
      }

      return out
    })
  }, [hand])

  return (
    <div className="galleryWrap">
      <div className="gallery" ref={containerRef}>
        <div className="tankBackGifs" aria-hidden>
          <img className="tankBackGif b1" src="/Back_gif/1.gif" alt="" />
          <img className="tankBackGif b2" src="/Back_gif/2.gif" alt="" />
          <img className="tankBackGif b3" src="/Back_gif/2.gif" alt="" />
        </div>
        <RippleLayer
          above
          containerRef={containerRef as unknown as React.RefObject<HTMLElement | null>}
          points={[
            ...(hand.hasRight && hand.right.index.visible
              ? [
                  {
                    id: 'R-index',
                    x: hand.right.index.x * (containerRef.current?.getBoundingClientRect().width || 0),
                    y: hand.right.index.y * (containerRef.current?.getBoundingClientRect().height || 0),
                  },
                ]
              : []),
            ...(hand.hasLeft && hand.left.index.visible
              ? [
                  {
                    id: 'L-index',
                    x: hand.left.index.x * (containerRef.current?.getBoundingClientRect().width || 0),
                    y: hand.left.index.y * (containerRef.current?.getBoundingClientRect().height || 0),
                  },
                ]
              : []),
          ]}
        />
        <TrailDots
          emitters={emitters}
          containerRef={containerRef as unknown as React.RefObject<HTMLElement | null>}
          above
        />
        {items.map((it) => (
          <div
            key={it.id}
            className="item"
            style={{
              left: it.x,
              top: it.y,
              width: it.w || DEFAULT_W * it.sizeMul,
              height: it.h || DEFAULT_H * it.sizeMul,
            }}
          >
            <img
              className="itemMedia"
              src={it.src}
              alt={it.title}
              draggable={false}
              onLoad={(e) => {
                const img = e.currentTarget
                const nw = (img.naturalWidth || DEFAULT_W) * SCALE * it.sizeMul
                const nh = (img.naturalHeight || DEFAULT_H) * SCALE * it.sizeMul
                setItems((prev) =>
                  prev.map((p) =>
                    p.id === it.id ? { ...p, w: nw, h: nh } : p,
                  ),
                )
              }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

function makeItems(): Item[] {
  const files = [
    { id: 'F1', src: '/GIF/F1.gif' },
    { id: 'F2', src: '/GIF/F2.gif' },
    { id: 'F3', src: '/GIF/F3.gif' },
    { id: 'F4', src: '/GIF/F4.gif' },
  ]

  // Double fish count: 2 of each GIF (total 8).
  const doubled = [...files, ...files]

  return doubled.map((f, idx) => ({
    id: String(idx + 1).padStart(2, '0'),
    title: `${f.id}-${idx < files.length ? 'A' : 'B'}`,
    kind: f.id,
    // per-fish stable random size multiplier (more varied)
    // keep the minimum, but cap the maximum so fish don't get too huge
    sizeMul: 0.55 + Math.random() * 0.8, // ~0.55..1.35
    x: PAD + idx * 10,
    y: PAD + idx * 10,
    w: DEFAULT_W,
    h: DEFAULT_H,
    src: f.src,
  }))
}

function hypot(dx: number, dy: number) {
  return Math.hypot(dx, dy)
}

