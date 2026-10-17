/**
 * Fixed Web Audio bank, built once on the first user gesture. Nothing is
 * created per sound: shots and effects re-trigger envelopes on reused voices.
 *
 * - 6 noise voices (looping noise → filter → panner → gain): gunshots, echoes, impacts, chests.
 * - 6 tone voices (oscillator → panner → gain): shot body/character, hits, pickups, chimes.
 * - Ambient: looping wind (filter + slow gust LFO), a bird voice, and a storm rumble.
 * - Master gain → compressor → speakers; mute ramps the master to silence.
 * Oscillators total TONE_VOICES + 3 (gust LFO, bird, rumble) = 9.
 */
export const Sfx = {
  Shot: 0,
  Damage: 1,
  Hit: 2,
  Elimination: 3,
  Pickup: 4,
  Chest: 5,
  Swing: 6,
  Heal: 7,
  Reload: 8,
} as const;
const NOISE_VOICES = 6,
  TONE_VOICES = 6;
// Per weapon ID: noise filter frequency, Q, decay seconds, loudness, body pitch.
const SHOT_FREQ = [1800, 900, 1300, 3800, 2600, 2300, 2800, 1500];
const SHOT_Q = [0.8, 0.6, 0.5, 0.9, 1.1, 0.8, 1.2, 0.7];
const SHOT_DECAY = [0.13, 0.12, 0.3, 0.5, 0.07, 0.2, 0.09, 0.15];
const SHOT_GAIN = [0.55, 0.4, 0.8, 0.85, 0.4, 0.6, 0.45, 0.6];
const SHOT_BODY = [130, 90, 85, 70, 160, 110, 180, 120];

export class Sound {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseFilters: BiquadFilterNode[] = [];
  private noisePans: StereoPannerNode[] = [];
  private noiseGains: GainNode[] = [];
  private tones: OscillatorNode[] = [];
  private tonePans: StereoPannerNode[] = [];
  private toneGains: GainNode[] = [];
  private windFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;
  private bird: OscillatorNode | null = null;
  private birdGain: GainNode | null = null;
  private rumbleGain: GainNode | null = null;
  private noiseCursor = 0;
  private toneCursor = 0;
  private nextChirp = 0;
  muted = false;
  unlock(): void {
    try {
      if (!this.context) this.build(new AudioContext());
      const context = this.context!;
      if (context.state === "suspended")
        void context.resume().catch(() => {});
    } catch {
      /* Silent play remains available if audio is blocked. */
    }
  }
  private build(c: AudioContext): void {
    this.context = c;
    const compressor = c.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.ratio.value = 4;
    compressor.connect(c.destination);
    const master = (this.master = c.createGain());
    master.gain.value = this.muted ? 0 : 0.9;
    master.connect(compressor);
    // One second of white noise, looped by every noise source.
    const noise = c.createBuffer(1, c.sampleRate, c.sampleRate),
      data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const loopNoise = () => {
      const source = c.createBufferSource();
      source.buffer = noise;
      source.loop = true;
      source.start();
      return source;
    };
    for (let i = 0; i < NOISE_VOICES; i++) {
      const filter = c.createBiquadFilter(),
        pan = c.createStereoPanner(),
        gain = c.createGain();
      filter.type = "bandpass";
      gain.gain.value = 0;
      loopNoise().connect(filter);
      filter.connect(pan);
      pan.connect(gain);
      gain.connect(master);
      this.noiseFilters.push(filter);
      this.noisePans.push(pan);
      this.noiseGains.push(gain);
    }
    for (let i = 0; i < TONE_VOICES; i++) {
      const tone = c.createOscillator(),
        pan = c.createStereoPanner(),
        gain = c.createGain();
      tone.type = "triangle";
      gain.gain.value = 0;
      tone.connect(pan);
      pan.connect(gain);
      gain.connect(master);
      tone.start();
      this.tones.push(tone);
      this.tonePans.push(pan);
      this.toneGains.push(gain);
    }
    // Ambient wind: low-passed noise whose level breathes with a slow LFO.
    const windFilter = (this.windFilter = c.createBiquadFilter()),
      windGain = (this.windGain = c.createGain()),
      gust = c.createOscillator(),
      gustDepth = c.createGain();
    windFilter.type = "lowpass";
    windFilter.frequency.value = 500;
    windGain.gain.value = 0;
    loopNoise().connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(master);
    gust.frequency.value = 0.09;
    gustDepth.gain.value = 0;
    gust.connect(gustDepth);
    gustDepth.connect(windGain.gain);
    gust.start();
    this.gustDepth = gustDepth;
    // Bird chirps (forest) and a low storm rumble.
    const bird = (this.bird = c.createOscillator()),
      birdGain = (this.birdGain = c.createGain());
    bird.type = "sine";
    birdGain.gain.value = 0;
    bird.connect(birdGain);
    birdGain.connect(master);
    bird.start();
    const rumble = c.createOscillator(),
      rumbleFilter = c.createBiquadFilter(),
      rumbleGain = (this.rumbleGain = c.createGain());
    rumble.type = "sawtooth";
    rumble.frequency.value = 42;
    rumbleFilter.type = "lowpass";
    rumbleFilter.frequency.value = 160;
    rumbleGain.gain.value = 0;
    rumble.connect(rumbleFilter);
    rumbleFilter.connect(rumbleGain);
    rumbleGain.connect(master);
    rumble.start();
  }
  private gustDepth: GainNode | null = null;
  private ready(): AudioContext | null {
    const c = this.context;
    return c && !this.muted && c.state === "running" ? c : null;
  }
  private noise(
    t: number,
    type: BiquadFilterType,
    freq: number,
    q: number,
    peak: number,
    decay: number,
    pan: number,
  ): void {
    const i = this.noiseCursor++ % NOISE_VOICES,
      f = this.noiseFilters[i],
      g = this.noiseGains[i].gain;
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(80, freq * 0.45), t + decay);
    f.Q.setValueAtTime(q, t);
    this.noisePans[i].pan.setValueAtTime(pan, t);
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.0001, t);
    g.linearRampToValueAtTime(peak, t + 0.004);
    g.exponentialRampToValueAtTime(0.0001, t + decay);
  }
  /** Delayed noise layer (echoes, pellet spread) on the next reused voice. */
  private noiseAt(
    start: number,
    type: BiquadFilterType,
    freq: number,
    q: number,
    peak: number,
    decay: number,
    pan: number,
  ): void {
    this.noise(start, type, freq, q, peak, decay, pan);
  }
  private tone(
    t: number,
    type: OscillatorType,
    from: number,
    to: number,
    peak: number,
    duration: number,
    pan: number,
    delay = 0,
  ): void {
    const i = this.toneCursor++ % TONE_VOICES,
      f = this.tones[i].frequency,
      g = this.toneGains[i].gain,
      start = t + delay;
    this.tones[i].type = type;
    this.tonePans[i].pan.setValueAtTime(pan, start);
    f.cancelScheduledValues(start);
    g.cancelScheduledValues(start);
    f.setValueAtTime(from, start);
    f.exponentialRampToValueAtTime(to, start + duration);
    g.setValueAtTime(0.0001, start);
    g.linearRampToValueAtTime(peak, start + 0.006);
    g.exponentialRampToValueAtTime(0.0001, start + duration);
  }
  /**
   * kind: Sfx value. volume 0..1 (distance falloff is the caller's), weapon picks
   * the gun voicing for shots, pan -1 (left) .. 1 (right).
   */
  play(kind: number, volume = 1, weapon = 0, pan = 0): void {
    const c = this.ready();
    if (!c || volume <= 0.01) return;
    const t = c.currentTime,
      v = Math.min(1, volume);
    switch (kind) {
      case Sfx.Shot: {
        const w = weapon >= 0 && weapon < SHOT_FREQ.length ? weapon : 0;
        // Shared layer: filtered noise burst + low body, tuned per weapon.
        this.noise(t, "bandpass", SHOT_FREQ[w], SHOT_Q[w], SHOT_GAIN[w] * v, SHOT_DECAY[w], pan);
        this.tone(t, "sine", SHOT_BODY[w], 38, 0.35 * v, Math.min(0.2, SHOT_DECAY[w] + 0.05), pan);
        // Character layers so every gun is recognisable by ear.
        switch (w) {
          case 2: // Shotgun: deep boom and a second pellet-spread burst
            this.tone(t, "sawtooth", 62, 30, 0.3 * v, 0.28, pan);
            this.noiseAt(t + 0.025, "lowpass", 1400, 0.6, 0.45 * v, 0.22, pan);
            break;
          case 3: // Longshot: supersonic crack, then a long rolling echo
            this.noise(t, "highpass", 5200, 0.7, 0.5 * v, 0.05, pan);
            this.noiseAt(t + 0.09, "lowpass", 700, 0.5, 0.22 * v, 0.7, -pan);
            break;
          case 4: // SMG: tight, high tick
            this.tone(t, "square", 1900, 900, 0.05 * v, 0.03, pan);
            break;
          case 5: // Marksman: crisp crack and a short echo
            this.noise(t, "highpass", 4200, 0.8, 0.35 * v, 0.06, pan);
            this.noiseAt(t + 0.11, "bandpass", 1200, 0.7, 0.14 * v, 0.3, -pan);
            break;
          case 6: // Sidekick: snappy pop plus slide click
            this.tone(t + 0.0, "triangle", 900, 260, 0.12 * v, 0.05, pan);
            this.noiseAt(t + 0.06, "highpass", 3200, 1.2, 0.08 * v, 0.03, pan);
            break;
          case 7: // Vanguard: heavy punch with a metallic ring
            this.tone(t, "square", 1650, 1500, 0.05 * v, 0.12, pan);
            this.tone(t, "sawtooth", 95, 40, 0.22 * v, 0.18, pan);
            break;
          default: // Carbine: mid crack
            this.noise(t, "highpass", 3000, 0.8, 0.18 * v, 0.04, pan);
        }
        break;
      }
      case Sfx.Damage:
        this.noise(t, "lowpass", 700, 0.7, 0.45 * v, 0.18, pan);
        this.tone(t, "sawtooth", 120, 50, 0.18 * v, 0.2, pan);
        break;
      case Sfx.Hit:
        this.tone(t, "triangle", 1500, 1100, 0.22 * v, 0.07, pan);
        this.noise(t, "highpass", 3500, 0.7, 0.12 * v, 0.05, pan);
        break;
      case Sfx.Elimination:
        this.tone(t, "triangle", 660, 990, 0.3 * v, 0.16, 0);
        this.tone(t, "triangle", 990, 1320, 0.28 * v, 0.22, 0, 0.11);
        break;
      case Sfx.Pickup:
        this.tone(t, "square", 520, 780, 0.12 * v, 0.09, pan);
        this.tone(t, "square", 780, 1040, 0.1 * v, 0.1, pan, 0.07);
        break;
      case Sfx.Chest:
        this.noise(t, "bandpass", 900, 2, 0.35 * v, 0.25, pan);
        this.tone(t, "triangle", 440, 880, 0.2 * v, 0.3, pan, 0.08);
        this.tone(t, "triangle", 660, 1320, 0.18 * v, 0.35, pan, 0.2);
        break;
      case Sfx.Swing:
        this.noise(t, "bandpass", 1200, 1.4, 0.3 * v, 0.14, pan);
        break;
      case Sfx.Heal:
        this.tone(t, "sine", 392, 523, 0.22 * v, 0.25, 0);
        this.tone(t, "sine", 523, 784, 0.2 * v, 0.3, 0, 0.15);
        break;
      case Sfx.Reload:
        this.noise(t, "highpass", 2500, 1, 0.18 * v, 0.04, pan);
        this.noise(t, "highpass", 1800, 1, 0.2 * v, 0.05, pan);
        this.tone(t, "square", 240, 200, 0.06 * v, 0.05, pan, 0.18);
        break;
    }
  }
  /**
   * Called from throttled HUD work. biome: 0 forest, 1 snow, 2 desert.
   * storm: 0 calm .. 1 inside the storm. active: false in menus.
   */
  ambient(biome: number, storm: number, active: boolean): void {
    const c = this.ready();
    if (!c || !this.windGain || !this.windFilter || !this.gustDepth) return;
    const t = c.currentTime,
      wind = active ? (biome === 1 ? 0.06 : biome === 2 ? 0.05 : 0.025) : 0;
    this.windGain.gain.setTargetAtTime(wind, t, 1.2);
    this.gustDepth.gain.setTargetAtTime(wind * 0.6, t, 1.2);
    this.windFilter.frequency.setTargetAtTime(
      biome === 1 ? 900 : biome === 2 ? 650 : 420,
      t,
      1.5,
    );
    this.rumbleGain!.gain.setTargetAtTime(active ? storm * 0.12 : 0, t, 0.6);
    // Occasional two-note bird calls in forests.
    if (active && biome === 0 && t > this.nextChirp) {
      this.nextChirp = t + 2.5 + Math.random() * 6;
      const f = this.bird!.frequency,
        g = this.birdGain!.gain,
        base = 2200 + Math.random() * 1400;
      for (let k = 0; k < 2; k++) {
        const s = t + k * 0.16;
        f.setValueAtTime(base, s);
        f.exponentialRampToValueAtTime(base * 1.35, s + 0.08);
        g.setValueAtTime(0.0001, s);
        g.linearRampToValueAtTime(0.025, s + 0.01);
        g.exponentialRampToValueAtTime(0.0001, s + 0.12);
      }
    }
  }
  toggle(): void {
    this.muted = !this.muted;
    const c = this.context;
    if (c && this.master) {
      this.master.gain.cancelScheduledValues(c.currentTime);
      this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, c.currentTime, 0.02);
    }
  }
  dispose(): void {
    void this.context?.close().catch(() => {});
  }
}
