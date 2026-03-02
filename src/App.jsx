import { useEffect, useRef } from 'react'
import './App.css'

const BALL_COLORS = ['#ff6b6b', '#ffd93d', '#6bcb77', '#4d96ff', '#c77dff', '#ff9a3c', '#00d4ff', '#ff61a6', '#a0f0b0']
const PEG_SCALE = [261.63, 293.66, 329.63, 392, 440, 523.25, 587.33, 659.25]

class PegAudioEngine {
  constructor() {
    this.audioContext = null
    this.masterGain = null
    this.compressor = null
    this.pendingHits = []
    this.noteTokens = 1
    this.maxNotesPerSecond = 14
    this.maxVoices = 4
    this.activeVoices = 0
    this.lastTick = performance.now()
    this.sequenceStep = 0
  }

  init() {
    if (this.audioContext) {
      return
    }

    const context = new window.AudioContext()
    const compressor = context.createDynamicsCompressor()
    compressor.threshold.value = -22
    compressor.knee.value = 20
    compressor.ratio.value = 10
    compressor.attack.value = 0.003
    compressor.release.value = 0.2

    const masterGain = context.createGain()
    masterGain.gain.value = 0.22

    masterGain.connect(compressor)
    compressor.connect(context.destination)

    this.audioContext = context
    this.masterGain = masterGain
    this.compressor = compressor
  }

  unlock() {
    this.init()
    if (this.audioContext?.state === 'suspended') {
      void this.audioContext.resume()
    }
  }

  registerHit(x, intensity) {
    if (!this.audioContext) {
      return
    }

    this.pendingHits.push({
      x,
      intensity: Math.max(0.1, Math.min(1, intensity)),
      at: performance.now(),
    })
  }

  chooseHit() {
    if (this.pendingHits.length === 0) {
      return null
    }

    let bestIndex = 0
    for (let index = 1; index < this.pendingHits.length; index += 1) {
      if (this.pendingHits[index].intensity > this.pendingHits[bestIndex].intensity) {
        bestIndex = index
      }
    }

    const [best] = this.pendingHits.splice(bestIndex, 1)
    return best
  }

  playHit(hit, canvasWidth) {
    if (!this.audioContext || !this.masterGain || this.activeVoices >= this.maxVoices) {
      return
    }

    const now = this.audioContext.currentTime
    const normalizedX = Math.max(0, Math.min(0.999, hit.x / Math.max(canvasWidth, 1)))
    const baseIndex = Math.floor(normalizedX * PEG_SCALE.length)
    const noteIndex = (baseIndex + this.sequenceStep) % PEG_SCALE.length
    this.sequenceStep = (this.sequenceStep + 1) % PEG_SCALE.length
    const frequency = PEG_SCALE[noteIndex]

    const voiceGain = this.audioContext.createGain()
    const tone = this.audioContext.createOscillator()
    const shimmer = this.audioContext.createOscillator()
    const filter = this.audioContext.createBiquadFilter()

    const velocity = hit.intensity
    const peak = 0.03 + velocity * 0.08
    const duration = 0.11 + velocity * 0.14

    filter.type = 'lowpass'
    filter.frequency.value = 1800 + velocity * 2200
    filter.Q.value = 0.9

    tone.type = 'triangle'
    tone.frequency.setValueAtTime(frequency, now)
    shimmer.type = 'sine'
    shimmer.frequency.setValueAtTime(frequency * 2, now)

    voiceGain.gain.setValueAtTime(0.0001, now)
    voiceGain.gain.exponentialRampToValueAtTime(peak, now + 0.01)
    voiceGain.gain.exponentialRampToValueAtTime(0.0001, now + duration)

    tone.connect(filter)
    shimmer.connect(filter)
    filter.connect(voiceGain)
    voiceGain.connect(this.masterGain)

    this.activeVoices += 1
    tone.start(now)
    shimmer.start(now)
    tone.stop(now + duration)
    shimmer.stop(now + duration)
    shimmer.onended = () => {
      this.activeVoices = Math.max(0, this.activeVoices - 1)
      tone.disconnect()
      shimmer.disconnect()
      filter.disconnect()
      voiceGain.disconnect()
    }
  }

  tick(canvasWidth) {
    if (!this.audioContext || this.audioContext.state !== 'running') {
      return
    }

    const now = performance.now()
    const elapsed = now - this.lastTick
    this.lastTick = now

    this.pendingHits = this.pendingHits.filter((hit) => now - hit.at < 180)
    this.noteTokens = Math.min(4, this.noteTokens + (elapsed / 1000) * this.maxNotesPerSecond)

    while (this.noteTokens >= 1 && this.pendingHits.length > 0 && this.activeVoices < this.maxVoices) {
      const hit = this.chooseHit()
      if (!hit) {
        break
      }
      this.playHit(hit, canvasWidth)
      this.noteTokens -= 1
    }
  }

  dispose() {
    this.pendingHits = []
    if (this.audioContext) {
      void this.audioContext.close()
    }
    this.audioContext = null
    this.masterGain = null
    this.compressor = null
  }
}

class HapticsEngine {
  constructor() {
    this.supported = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'
    this.tokens = 1
    this.maxPerSecond = 10
    this.lastTick = performance.now()
    this.lastPulse = 0
    this.minGapMs = 55
  }

  trigger(intensity) {
    if (!this.supported) {
      return
    }

    const now = performance.now()
    const elapsed = now - this.lastTick
    this.lastTick = now
    this.tokens = Math.min(3, this.tokens + (elapsed / 1000) * this.maxPerSecond)

    if (this.tokens < 1 || now - this.lastPulse < this.minGapMs) {
      return
    }

    this.tokens -= 1
    this.lastPulse = now

    const clamped = Math.max(0.1, Math.min(1, intensity))
    const duration = Math.round(6 + clamped * 14)
    navigator.vibrate(duration)
  }

  dispose() {
    if (this.supported) {
      navigator.vibrate(0)
    }
  }
}

function collideBallWithPoint(ball, point, bounce) {
  if (point.pinned) {
    return
  }

  const dx = point.x - ball.x
  const dy = point.y - ball.y
  const distance = Math.hypot(dx, dy)
  const minDistance = ball.r + point.r

  if (distance <= 0 || distance >= minDistance) {
    return
  }

  const nx = dx / distance
  const ny = dy / distance
  const overlap = minDistance - distance

  const ballMass = ball.r * ball.r * 0.09
  const pointMass = point.r * point.r * 0.45
  const invBallMass = 1 / ballMass
  const invPointMass = 1 / pointMass
  const invSum = invBallMass + invPointMass

  ball.x -= nx * overlap * (invBallMass / invSum)
  ball.y -= ny * overlap * (invBallMass / invSum)
  point.x += nx * overlap * (invPointMass / invSum)
  point.y += ny * overlap * (invPointMass / invSum)

  const pointVx = point.x - point.ox
  const pointVy = point.y - point.oy
  const relativeVx = ball.vx - pointVx
  const relativeVy = ball.vy - pointVy
  const relativeNormalVelocity = relativeVx * nx + relativeVy * ny

  if (relativeNormalVelocity >= 0) {
    return
  }

  const restitution = Math.min(0.86, Math.max(0.28, bounce * 0.9))
  const impulse = (-(1 + restitution) * relativeNormalVelocity) / invSum

  ball.vx += impulse * nx * invBallMass
  ball.vy += impulse * ny * invBallMass

  const nextPointVx = pointVx - impulse * nx * invPointMass
  const nextPointVy = pointVy - impulse * ny * invPointMass
  point.ox = point.x - nextPointVx
  point.oy = point.y - nextPointVy
}

function solveBallRagdollCollisions(balls, ragdolls, bounce) {
  for (const ragdoll of ragdolls) {
    for (const point of ragdoll.points) {
      for (const ball of balls) {
        collideBallWithPoint(ball, point, bounce)
      }
    }
  }
}

class Peg {
  constructor(x, y) {
    this.x = x
    this.y = y
    this.r = 5
    this.flash = 0
  }

  draw(ctx) {
    ctx.beginPath()
    ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2)
    ctx.fillStyle = this.flash > 0 ? '#fff' : '#334466'
    ctx.fill()
    if (this.flash > 0) {
      ctx.shadowColor = '#88ccff'
      ctx.shadowBlur = 15
      ctx.fill()
      ctx.shadowBlur = 0
      this.flash -= 1
    }
  }
}

class Ball {
  constructor(x, y, vx = 0, vy = 0) {
    this.x = x
    this.y = y
    this.vx = vx
    this.vy = vy
    this.r = 6 + Math.random() * 5
    this.color = BALL_COLORS[Math.floor(Math.random() * BALL_COLORS.length)]
    this.trail = []
  }

  update(sim) {
    const { bounce, gravity, pegs } = sim

    this.vy += gravity
    this.vx *= 0.99
    this.vy *= 0.99
    this.x += this.vx
    this.y += this.vy
    this.trail.push({ x: this.x, y: this.y })
    if (this.trail.length > 8) {
      this.trail.shift()
    }

    if (this.x - this.r < 0) {
      this.x = this.r
      this.vx = Math.abs(this.vx) * bounce
    }

    if (this.x + this.r > sim.canvas.width) {
      this.x = sim.canvas.width - this.r
      this.vx = -Math.abs(this.vx) * bounce
    }

    if (this.y + this.r > sim.canvas.height) {
      this.y = sim.canvas.height - this.r
      this.vy = -Math.abs(this.vy) * bounce
      this.vx *= 0.85
      if (Math.abs(this.vy) < 0.5) {
        this.vy = 0
      }
    }

    for (const peg of pegs) {
      const dx = this.x - peg.x
      const dy = this.y - peg.y
      const distance = Math.hypot(dx, dy)
      const minDistance = this.r + peg.r

      if (distance < minDistance && distance > 0) {
        const nx = dx / distance
        const ny = dy / distance
        this.x += nx * (minDistance - distance)
        this.y += ny * (minDistance - distance)
        const dot = this.vx * nx + this.vy * ny
        this.vx -= 2 * dot * nx * bounce
        this.vy -= 2 * dot * ny * bounce
        peg.flash = 8
        sim.onPegHit?.(peg, Math.abs(dot) / 12)
      }
    }
  }

  draw(ctx) {
    for (let i = 0; i < this.trail.length; i += 1) {
      ctx.beginPath()
      ctx.arc(this.trail[i].x, this.trail[i].y, this.r * (i / this.trail.length), 0, Math.PI * 2)
      const alpha = Math.floor((i / this.trail.length) * 60)
        .toString(16)
        .padStart(2, '0')
      ctx.fillStyle = `${this.color}${alpha}`
      ctx.fill()
    }

    const gradient = ctx.createRadialGradient(
      this.x - this.r * 0.3,
      this.y - this.r * 0.3,
      this.r * 0.1,
      this.x,
      this.y,
      this.r,
    )
    gradient.addColorStop(0, '#fff')
    gradient.addColorStop(0.3, this.color)
    gradient.addColorStop(1, `${this.color}99`)

    ctx.beginPath()
    ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2)
    ctx.fillStyle = gradient
    ctx.fill()
  }
}

class Point {
  constructor(x, y, r = 5) {
    this.x = x
    this.y = y
    this.ox = x
    this.oy = y
    this.r = r
    this.pinned = false
  }

  integrate(gravity) {
    if (this.pinned) {
      return
    }

    const vx = this.x - this.ox
    const vy = this.y - this.oy
    this.ox = this.x
    this.oy = this.y
    this.x += vx * 0.978
    this.y += vy * 0.978 + gravity
  }

  constrain(sim) {
    if (this.pinned) {
      return
    }

    if (this.x - this.r < 0) {
      const vx = this.x - this.ox
      this.x = this.r
      this.ox = this.x + vx * sim.bounce
    }

    if (this.x + this.r > sim.canvas.width) {
      const vx = this.x - this.ox
      this.x = sim.canvas.width - this.r
      this.ox = this.x + vx * sim.bounce
    }

    if (this.y + this.r > sim.canvas.height) {
      const vy = this.y - this.oy
      this.y = sim.canvas.height - this.r
      this.oy = this.y + vy * sim.bounce
      this.ox += (this.x - this.ox) * 0.15
    }

    for (const peg of sim.pegs) {
      const dx = this.x - peg.x
      const dy = this.y - peg.y
      const distance = Math.hypot(dx, dy)
      const minDistance = this.r + peg.r
      if (distance < minDistance && distance > 0) {
        const nx = dx / distance
        const ny = dy / distance
        const push = minDistance - distance
        const speed = Math.hypot(this.x - this.ox, this.y - this.oy)
        this.x += nx * push
        this.y += ny * push
        peg.flash = 8
        sim.onPegHit?.(peg, speed / 9)
      }
    }
  }
}

class Link {
  constructor(a, b, stiffness = 1) {
    this.a = a
    this.b = b
    this.length = Math.hypot(b.x - a.x, b.y - a.y)
    this.stiffness = stiffness
  }

  solve() {
    const dx = this.b.x - this.a.x
    const dy = this.b.y - this.a.y
    const distance = Math.hypot(dx, dy) || 0.001
    const difference = ((distance - this.length) / distance) * 0.5 * this.stiffness
    const offsetX = dx * difference
    const offsetY = dy * difference

    if (!this.a.pinned) {
      this.a.x += offsetX
      this.a.y += offsetY
    }

    if (!this.b.pinned) {
      this.b.x -= offsetX
      this.b.y -= offsetY
    }
  }
}

class Ragdoll {
  constructor(cx, cy) {
    const createPoint = (x, y, r) => new Point(cx + x, cy + y, r)

    this.head = createPoint(0, 0, 12)
    this.neck = createPoint(0, 16, 5)
    this.chest = createPoint(0, 36, 10)
    this.pelvis = createPoint(0, 58, 9)
    this.shoulderLeft = createPoint(-20, 28, 8)
    this.shoulderRight = createPoint(20, 28, 8)
    this.elbowLeft = createPoint(-32, 52, 7)
    this.elbowRight = createPoint(32, 52, 7)
    this.wristLeft = createPoint(-34, 74, 5)
    this.wristRight = createPoint(34, 74, 5)
    this.hipLeft = createPoint(-11, 62, 8)
    this.hipRight = createPoint(11, 62, 8)
    this.kneeLeft = createPoint(-13, 90, 7)
    this.kneeRight = createPoint(13, 90, 7)
    this.ankleLeft = createPoint(-14, 116, 5)
    this.ankleRight = createPoint(14, 116, 5)

    this.points = [
      this.head,
      this.neck,
      this.chest,
      this.pelvis,
      this.shoulderLeft,
      this.shoulderRight,
      this.elbowLeft,
      this.elbowRight,
      this.wristLeft,
      this.wristRight,
      this.hipLeft,
      this.hipRight,
      this.kneeLeft,
      this.kneeRight,
      this.ankleLeft,
      this.ankleRight,
    ]

    this.links = [
      new Link(this.head, this.neck, 1),
      new Link(this.neck, this.chest, 1),
      new Link(this.chest, this.pelvis, 1),
      new Link(this.chest, this.shoulderLeft, 1),
      new Link(this.chest, this.shoulderRight, 1),
      new Link(this.neck, this.shoulderLeft, 0.5),
      new Link(this.neck, this.shoulderRight, 0.5),
      new Link(this.shoulderLeft, this.elbowLeft, 1),
      new Link(this.shoulderRight, this.elbowRight, 1),
      new Link(this.elbowLeft, this.wristLeft, 1),
      new Link(this.elbowRight, this.wristRight, 1),
      new Link(this.pelvis, this.hipLeft, 1),
      new Link(this.pelvis, this.hipRight, 1),
      new Link(this.chest, this.hipLeft, 0.4),
      new Link(this.chest, this.hipRight, 0.4),
      new Link(this.hipLeft, this.kneeLeft, 1),
      new Link(this.hipRight, this.kneeRight, 1),
      new Link(this.kneeLeft, this.ankleLeft, 1),
      new Link(this.kneeRight, this.ankleRight, 1),
      new Link(this.shoulderLeft, this.shoulderRight, 0.7),
      new Link(this.hipLeft, this.hipRight, 0.7),
      new Link(this.shoulderLeft, this.hipRight, 0.3),
      new Link(this.shoulderRight, this.hipLeft, 0.3),
    ]

    const spin = (Math.random() - 0.5) * 5
    for (const pt of this.points) {
      pt.ox = pt.x - spin * (pt.y - cy) * 0.05 + (Math.random() - 0.5)
      pt.oy = pt.y - spin * (pt.x - cx) * 0.05 - 1.5
    }
  }

  update(sim) {
    for (const point of this.points) {
      point.integrate(sim.gravity)
    }

    for (let i = 0; i < 8; i += 1) {
      for (const link of this.links) {
        link.solve()
      }
      for (const point of this.points) {
        point.constrain(sim)
      }
    }
  }

  draw(ctx) {
    const skin = '#f4c48a'
    const dark = '#3a2010'
    const joint = '#e0a060'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    const limb = (a, b, widthA, widthB, color) => {
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len = Math.hypot(dx, dy) || 1
      const nx = (-dy / len) * widthA
      const ny = (dx / len) * widthA
      const nx2 = (-dy / len) * widthB
      const ny2 = (dx / len) * widthB

      ctx.beginPath()
      ctx.moveTo(a.x + nx, a.y + ny)
      ctx.lineTo(b.x + nx2, b.y + ny2)
      ctx.lineTo(b.x - nx2, b.y - ny2)
      ctx.lineTo(a.x - nx, a.y - ny)
      ctx.closePath()
      ctx.fillStyle = color
      ctx.fill()
      ctx.strokeStyle = dark
      ctx.lineWidth = 1.2
      ctx.stroke()
    }

    limb(this.chest, this.pelvis, 13, 10, skin)
    limb(this.neck, this.chest, 5, 9, skin)
    limb(this.shoulderLeft, this.elbowLeft, 7, 6, skin)
    limb(this.shoulderRight, this.elbowRight, 7, 6, skin)
    limb(this.elbowLeft, this.wristLeft, 6, 4, skin)
    limb(this.elbowRight, this.wristRight, 6, 4, skin)
    limb(this.hipLeft, this.kneeLeft, 9, 8, '#4a6080')
    limb(this.hipRight, this.kneeRight, 9, 8, '#4a6080')
    limb(this.kneeLeft, this.ankleLeft, 8, 5, '#5a7090')
    limb(this.kneeRight, this.ankleRight, 8, 5, '#5a7090')

    const foot = (ankle, knee) => {
      const angle = Math.atan2(ankle.y - knee.y, ankle.x - knee.x) + Math.PI * 0.5
      ctx.save()
      ctx.translate(ankle.x, ankle.y)
      ctx.rotate(angle)
      ctx.beginPath()
      ctx.ellipse(2, 0, 8, 5, 0, 0, Math.PI * 2)
      ctx.fillStyle = '#222'
      ctx.fill()
      ctx.strokeStyle = dark
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.restore()
    }

    foot(this.ankleLeft, this.kneeLeft)
    foot(this.ankleRight, this.kneeRight)

    const hand = (wrist) => {
      ctx.beginPath()
      ctx.arc(wrist.x, wrist.y, 5, 0, Math.PI * 2)
      ctx.fillStyle = skin
      ctx.fill()
      ctx.strokeStyle = dark
      ctx.lineWidth = 1
      ctx.stroke()
    }

    hand(this.wristLeft)
    hand(this.wristRight)

    for (const pt of [this.shoulderLeft, this.shoulderRight, this.hipLeft, this.hipRight, this.elbowLeft, this.elbowRight, this.kneeLeft, this.kneeRight]) {
      ctx.beginPath()
      ctx.arc(pt.x, pt.y, pt.r * 0.65, 0, Math.PI * 2)
      ctx.fillStyle = joint
      ctx.fill()
    }

    ctx.beginPath()
    ctx.arc(this.head.x, this.head.y, this.head.r, 0, Math.PI * 2)
    ctx.fillStyle = skin
    ctx.fill()
    ctx.strokeStyle = dark
    ctx.lineWidth = 1.5
    ctx.stroke()

    ctx.beginPath()
    ctx.arc(this.head.x, this.head.y, this.head.r, Math.PI, Math.PI * 2)
    ctx.fillStyle = '#4a2808'
    ctx.fill()

    const faceAngle = Math.atan2(this.head.y - this.neck.y, this.head.x - this.neck.x) - Math.PI * 0.5
    ctx.save()
    ctx.translate(this.head.x, this.head.y)
    ctx.rotate(faceAngle)
    ctx.beginPath()
    ctx.arc(-4, 4, 2.5, 0, Math.PI * 2)
    ctx.fillStyle = '#111'
    ctx.fill()
    ctx.beginPath()
    ctx.arc(4, 4, 2.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.beginPath()
    ctx.arc(-4, 4.5, 1, 0, Math.PI * 2)
    ctx.fillStyle = '#fff'
    ctx.fill()
    ctx.beginPath()
    ctx.arc(4, 4.5, 1, 0, Math.PI * 2)
    ctx.fill()
    ctx.beginPath()
    ctx.arc(0, 8, 3.5, 0.3, Math.PI - 0.3)
    ctx.strokeStyle = '#c06040'
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.restore()
  }

  grab(mx, my) {
    let best = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const point of this.points) {
      const distance = Math.hypot(mx - point.x, my - point.y)
      if (distance < Math.max(point.r + 10, 18) && distance < bestDistance) {
        bestDistance = distance
        best = point
      }
    }
    return best
  }
}

function App() {
  const canvasRef = useRef(null)
  const ragdollBtnRef = useRef(null)
  const rainBtnRef = useRef(null)
  const chaosBtnRef = useRef(null)
  const clearBtnRef = useRef(null)
  const gravSliderRef = useRef(null)
  const bounceSliderRef = useRef(null)
  const pegSliderRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const ragdollBtn = ragdollBtnRef.current
    const rainBtn = rainBtnRef.current
    const chaosBtn = chaosBtnRef.current
    const clearBtn = clearBtnRef.current
    const gravSlider = gravSliderRef.current
    const bounceSlider = bounceSliderRef.current
    const pegSlider = pegSliderRef.current

    if (
      !canvas ||
      !ragdollBtn ||
      !rainBtn ||
      !chaosBtn ||
      !clearBtn ||
      !gravSlider ||
      !bounceSlider ||
      !pegSlider
    ) {
      return undefined
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return undefined
    }

    let gravity = 0.3
    let bounce = 0.55
    let pegSpacing = 44
    let rainInterval = null
    const rainTimeouts = new Set()
    let animationFrameId = 0
    const pegAudio = new PegAudioEngine()
    const haptics = new HapticsEngine()
    const pegSoundState = new WeakMap()

    const resize = () => {
      canvas.width = Math.min(window.innerWidth, 900)
      const top = canvas.getBoundingClientRect().top
      canvas.height = window.innerHeight - top - 28
    }

    const pegs = []
    const sim = {
      canvas,
      bounce,
      gravity,
      pegs,
      onPegHit: (peg, intensity) => {
        const now = performance.now()
        const clamped = Math.max(0, Math.min(1, intensity))
        const state = pegSoundState.get(peg) ?? { lastAt: -1e9, streak: 0, suppressedUntil: 0 }

        if (now < state.suppressedUntil) {
          pegSoundState.set(peg, state)
          return
        }

        const sinceLast = now - state.lastAt
        const cooldownMs = 80 + (1 - clamped) * 180
        if (sinceLast < cooldownMs) {
          if (sinceLast < 120) {
            state.streak += 1
          } else {
            state.streak = Math.max(0, state.streak - 1)
          }

          if (state.streak >= 6) {
            state.suppressedUntil = now + 800
            state.streak = 0
          }

          pegSoundState.set(peg, state)
          return
        }

        state.lastAt = now
        state.streak = 0
        pegSoundState.set(peg, state)

        pegAudio.registerHit(peg.x, clamped)
        haptics.trigger(intensity)
      },
    }

    const buildPegs = () => {
      pegs.length = 0
      const rowSpacing = pegSpacing * 0.86
      for (let row = 0; row < 9; row += 1) {
        const cols = row + 4
        const totalWidth = (cols - 1) * pegSpacing
        const startX = (canvas.width - totalWidth) / 2
        for (let col = 0; col < cols; col += 1) {
          pegs.push(new Peg(startX + col * pegSpacing, 80 + row * rowSpacing))
        }
      }
    }

    const balls = []
    const ragdolls = []
    const addBall = (x, y, vx = 0, vy = 0) => {
      if (balls.length < 200) {
        balls.push(new Ball(x, y, vx, vy))
      }
    }

    const spawnRagdoll = () => {
      if (ragdolls.length >= 5) {
        ragdolls.shift()
      }
      const x = canvas.width * 0.25 + Math.random() * canvas.width * 0.5
      ragdolls.push(new Ragdoll(x, -30))
    }

    const mouse = { x: 0, y: 0, down: false, startX: 0, startY: 0, startTime: 0 }
    let activeDragPoint = null

    const canvasPos = (event) => {
      const rect = canvas.getBoundingClientRect()
      const source = event.touches ? event.touches[0] : event
      return { x: source.clientX - rect.left, y: source.clientY - rect.top }
    }

    const onDown = (event) => {
      pegAudio.unlock()
      const { x, y } = canvasPos(event)
      for (const ragdoll of ragdolls) {
        const point = ragdoll.grab(x, y)
        if (point) {
          activeDragPoint = point
          point.pinned = true
          return
        }
      }

      mouse.startX = x
      mouse.x = x
      mouse.startY = y
      mouse.y = y
      mouse.down = true
      mouse.startTime = Date.now()
    }

    const onMove = (event) => {
      const { x, y } = canvasPos(event)
      mouse.x = x
      mouse.y = y

      if (activeDragPoint) {
        activeDragPoint.x = x
        activeDragPoint.y = y
        activeDragPoint.ox = x
        activeDragPoint.oy = y
      }
    }

    const onUp = (event) => {
      if (activeDragPoint) {
        activeDragPoint.pinned = false
        activeDragPoint = null
        return
      }

      if (!mouse.down) {
        return
      }

      mouse.down = false
      const { x, y } = canvasPos(event)
      const dt = Math.max((Date.now() - mouse.startTime) / 100, 0.05)
      const vx = ((x - mouse.startX) / dt) * 0.4
      const vy = ((y - mouse.startY) / dt) * 0.4
      const speed = Math.hypot(vx, vy)
      const cap = 18
      const scale = speed > cap ? cap / speed : 1
      addBall(mouse.startX, mouse.startY, vx * scale, vy * scale)
    }

    const onMouseDown = (event) => onDown(event)
    const onTouchStart = (event) => {
      event.preventDefault()
      onDown(event)
    }
    const onMouseMove = (event) => onMove(event)
    const onTouchMove = (event) => {
      event.preventDefault()
      onMove(event)
    }
    const onMouseUp = (event) => onUp(event)
    const onTouchEnd = (event) => {
      event.preventDefault()
      onUp(event.changedTouches?.[0] ? { ...event, touches: event.changedTouches } : event)
    }

    const onGravityInput = (event) => {
      gravity = Number(event.target.value)
      sim.gravity = gravity
    }

    const onBounceInput = (event) => {
      bounce = Number(event.target.value)
      sim.bounce = bounce
    }

    const onPegInput = (event) => {
      pegSpacing = Number(event.target.value)
      buildPegs()
    }

    const onRainClick = () => {
      pegAudio.unlock()
      if (rainInterval) {
        clearInterval(rainInterval)
        rainInterval = null
        return
      }

      rainInterval = setInterval(() => {
        addBall(canvas.width * 0.2 + Math.random() * canvas.width * 0.6, 10, (Math.random() - 0.5) * 3, 0)
      }, 120)

      const timeoutId = setTimeout(() => {
        if (rainInterval) {
          clearInterval(rainInterval)
          rainInterval = null
        }
        rainTimeouts.delete(timeoutId)
      }, 6000)
      rainTimeouts.add(timeoutId)
    }

    const onChaosClick = () => {
      pegAudio.unlock()
      for (let i = 0; i < 20; i += 1) {
        const timeoutId = setTimeout(() => {
          addBall(
            canvas.width * 0.1 + Math.random() * canvas.width * 0.8,
            Math.random() * canvas.height * 0.3,
            (Math.random() - 0.5) * 12,
            (Math.random() - 0.5) * 6,
          )
          rainTimeouts.delete(timeoutId)
        }, i * 60)
        rainTimeouts.add(timeoutId)
      }
    }

    const onClearClick = () => {
      pegAudio.unlock()
      balls.length = 0
      ragdolls.length = 0
    }

    const onResize = () => {
      resize()
      buildPegs()
    }

    const drawHistogram = () => {
      const buckets = 20
      const bucketWidth = canvas.width / buckets
      const counts = new Array(buckets).fill(0)
      for (const ball of balls) {
        if (ball.y > canvas.height - 40) {
          counts[Math.min(Math.floor(ball.x / bucketWidth), buckets - 1)] += 1
        }
      }

      const maxCount = Math.max(...counts, 1)
      for (let i = 0; i < buckets; i += 1) {
        const barHeight = (counts[i] / maxCount) * 50
        ctx.fillStyle = `hsla(${200 + i * 8}, 80%, 65%, 0.28)`
        ctx.fillRect(i * bucketWidth, canvas.height - barHeight, bucketWidth - 1, barHeight)
      }
    }

    const drawArrow = () => {
      if (!mouse.down || activeDragPoint) {
        return
      }

      const dx = mouse.x - mouse.startX
      const dy = mouse.y - mouse.startY
      if (Math.hypot(dx, dy) < 5) {
        return
      }

      ctx.save()
      ctx.strokeStyle = 'rgba(255,255,255,0.55)'
      ctx.lineWidth = 2
      ctx.setLineDash([5, 4])
      ctx.beginPath()
      ctx.moveTo(mouse.startX, mouse.startY)
      ctx.lineTo(mouse.x, mouse.y)
      ctx.stroke()
      ctx.setLineDash([])

      const angle = Math.atan2(dy, dx)
      ctx.translate(mouse.x, mouse.y)
      ctx.rotate(angle)
      ctx.fillStyle = 'rgba(255,255,255,0.8)'
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(-10, -5)
      ctx.lineTo(-10, 5)
      ctx.closePath()
      ctx.fill()
      ctx.restore()

      ctx.beginPath()
      ctx.arc(mouse.startX, mouse.startY, 8, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.fill()
    }

    const ballCollisions = () => {
      for (let i = 0; i < balls.length; i += 1) {
        for (let j = i + 1; j < balls.length; j += 1) {
          const a = balls[i]
          const b = balls[j]
          const dx = b.x - a.x
          const dy = b.y - a.y
          const distance = Math.hypot(dx, dy)
          const minDistance = a.r + b.r

          if (distance < minDistance && distance > 0) {
            const nx = dx / distance
            const ny = dy / distance
            const overlap = (minDistance - distance) / 2
            a.x -= nx * overlap
            a.y -= ny * overlap
            b.x += nx * overlap
            b.y += ny * overlap

            const dvx = a.vx - b.vx
            const dvy = a.vy - b.vy
            const dot = dvx * nx + dvy * ny
            a.vx -= dot * nx * bounce
            a.vy -= dot * ny * bounce
            b.vx += dot * nx * bounce
            b.vy += dot * ny * bounce
          }
        }
      }
    }

    const loop = () => {
      ctx.fillStyle = 'rgba(13,13,26,0.86)'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      drawHistogram()
      ctx.fillStyle = 'rgba(255,255,255,0.05)'
      ctx.fillRect(0, canvas.height - 2, canvas.width, 2)

      for (const peg of pegs) {
        peg.draw(ctx)
      }

      ballCollisions()

      for (const ball of balls) {
        ball.update(sim)
      }

      if (balls.length > 180) {
        balls.splice(0, balls.length - 180)
      }

      for (const ragdoll of ragdolls) {
        ragdoll.update(sim)
      }

      for (let pass = 0; pass < 2; pass += 1) {
        solveBallRagdollCollisions(balls, ragdolls, bounce)
      }

      for (const ball of balls) {
        ball.draw(ctx)
      }

      for (const ragdoll of ragdolls) {
        ragdoll.draw(ctx)
      }

      pegAudio.tick(canvas.width)

      if (activeDragPoint) {
        ctx.beginPath()
        ctx.arc(activeDragPoint.x, activeDragPoint.y, activeDragPoint.r + 5, 0, Math.PI * 2)
        ctx.strokeStyle = 'rgba(255,200,80,0.85)'
        ctx.lineWidth = 2.5
        ctx.stroke()
      }

      drawArrow()
      ctx.fillStyle = 'rgba(255,255,255,0.22)'
      ctx.font = '12px Nunito'
      ctx.fillText(`⚪ ${balls.length}  🧍 ${ragdolls.length}`, 10, 20)
      animationFrameId = requestAnimationFrame(loop)
    }

    resize()
    buildPegs()

    window.addEventListener('resize', onResize)
    canvas.addEventListener('mousedown', onMouseDown)
    canvas.addEventListener('touchstart', onTouchStart, { passive: false })
    canvas.addEventListener('mousemove', onMouseMove)
    canvas.addEventListener('touchmove', onTouchMove, { passive: false })
    canvas.addEventListener('mouseup', onMouseUp)
    canvas.addEventListener('touchend', onTouchEnd, { passive: false })
    ragdollBtn.addEventListener('click', spawnRagdoll)
    rainBtn.addEventListener('click', onRainClick)
    chaosBtn.addEventListener('click', onChaosClick)
    clearBtn.addEventListener('click', onClearClick)
    gravSlider.addEventListener('input', onGravityInput)
    bounceSlider.addEventListener('input', onBounceInput)
    pegSlider.addEventListener('input', onPegInput)

    loop()

    return () => {
      cancelAnimationFrame(animationFrameId)
      if (rainInterval) {
        clearInterval(rainInterval)
      }
      for (const timeoutId of rainTimeouts) {
        clearTimeout(timeoutId)
      }
      pegAudio.dispose()
      haptics.dispose()

      window.removeEventListener('resize', onResize)
      canvas.removeEventListener('mousedown', onMouseDown)
      canvas.removeEventListener('touchstart', onTouchStart)
      canvas.removeEventListener('mousemove', onMouseMove)
      canvas.removeEventListener('touchmove', onTouchMove)
      canvas.removeEventListener('mouseup', onMouseUp)
      canvas.removeEventListener('touchend', onTouchEnd)
      ragdollBtn.removeEventListener('click', spawnRagdoll)
      rainBtn.removeEventListener('click', onRainClick)
      chaosBtn.removeEventListener('click', onChaosClick)
      clearBtn.removeEventListener('click', onClearClick)
      gravSlider.removeEventListener('input', onGravityInput)
      bounceSlider.removeEventListener('input', onBounceInput)
      pegSlider.removeEventListener('input', onPegInput)
    }
  }, [])

  return (
    <div className="app-shell">
      <header>
        <h1>🎱 Ball Drop!</h1>
        <div className="controls">
          <button className="btn btn-ragdoll" ref={ragdollBtnRef} type="button">
            🧍 Drop Ragdoll
          </button>
          <button className="btn btn-rain" ref={rainBtnRef} type="button">
            🌧 Rain
          </button>
          <button className="btn btn-chaos" ref={chaosBtnRef} type="button">
            🌀 Chaos
          </button>
          <button className="btn btn-clear" ref={clearBtnRef} type="button">
            🗑 Clear All
          </button>
          <label htmlFor="gravSlider">
            Gravity
            <input defaultValue="0.3" id="gravSlider" max="0.8" min="0.05" ref={gravSliderRef} step="0.05" type="range" />
          </label>
          <label htmlFor="bounceSlider">
            Bounce
            <input defaultValue="0.55" id="bounceSlider" max="0.99" min="0.1" ref={bounceSliderRef} step="0.05" type="range" />
          </label>
          <label htmlFor="pegSlider">
            Pegs
            <input defaultValue="44" id="pegSlider" max="80" min="20" ref={pegSliderRef} step="2" type="range" />
          </label>
        </div>
      </header>
      <canvas id="c" ref={canvasRef} />
      <div className="hint">Click to drop ball · Drag to fling · 🧍 Drop Ragdoll · Grab &amp; drag ragdoll limbs!</div>
    </div>
  )
}

export default App
