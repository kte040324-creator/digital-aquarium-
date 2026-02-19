import { useState } from 'react'
import './App.css'
import { Gallery } from './components/Gallery'
import { HandOverlay } from './hand/HandOverlay'
import type { HandUpdate } from './hand/types'

const emptyHand: HandUpdate = {
  cursor: { x: 0, y: 0, visible: false },
  pinch: {
    isPinched: false,
    justStarted: false,
    justEnded: false,
    distance: 1,
    strength: 0,
  },
  right: {
    thumb: { x: 0, y: 0, visible: false },
    index: { x: 0, y: 0, visible: false },
    middle: { x: 0, y: 0, visible: false },
    ring: { x: 0, y: 0, visible: false },
    pinky: { x: 0, y: 0, visible: false },
  },
  left: {
    thumb: { x: 0, y: 0, visible: false },
    index: { x: 0, y: 0, visible: false },
    middle: { x: 0, y: 0, visible: false },
    ring: { x: 0, y: 0, visible: false },
    pinky: { x: 0, y: 0, visible: false },
  },
  hasRight: false,
  hasLeft: false,
}

function App() {
  // Aquarium-only UI: always run the camera/hand tracking.
  const enabled = true
  const [hand, setHand] = useState<HandUpdate>(emptyHand)

  return (
    <div className="app aquariumOnly">
      <main className="layout aquariumOnly">
        <section className="stage">
          <HandOverlay enabled={enabled} onUpdate={setHand} />
          <Gallery hand={hand} />
        </section>
      </main>
    </div>
  )
}

export default App
