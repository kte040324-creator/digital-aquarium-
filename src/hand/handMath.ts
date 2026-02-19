export function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

export function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

export function dist2D(ax: number, ay: number, bx: number, by: number) {
  const dx = ax - bx
  const dy = ay - by
  return Math.sqrt(dx * dx + dy * dy)
}

