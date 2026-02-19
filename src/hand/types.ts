export type HandCursor = {
  /** viewport x */
  x: number
  /** viewport y */
  y: number
  visible: boolean
}

export type HandPinch = {
  isPinched: boolean
  /** true only for a single update on the transition OFF -> ON */
  justStarted: boolean
  /** true only for a single update on the transition ON -> OFF */
  justEnded: boolean
  /** normalized distance between thumb tip and index tip (0~1-ish) */
  distance: number
  /** 0..1, higher means more strongly pinched */
  strength: number
}


export type HandTipName = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky'

export type HandTip = {
  /** normalized 0..1 in the stage/video space (mirrored if enabled) */
  x: number
  /** normalized 0..1 in the stage/video space */
  y: number
  visible: boolean
}

export type HandTips = Record<HandTipName, HandTip>

export type HandUpdate = {
  cursor: HandCursor
  pinch: HandPinch
  /** Right hand tips (mirrored if enabled) */
  right: HandTips
  /** Left hand tips (mirrored if enabled) */
  left: HandTips
  hasRight: boolean
  hasLeft: boolean
}

