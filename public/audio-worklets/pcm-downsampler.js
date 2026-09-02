/**
 * AudioWorklet processor — downsamples mic input to 16kHz mono Float32 PCM
 * and posts chunks to the main thread. Runs off the main thread, so
 * downsampling happens without blocking the UI.
 *
 * The processor is registered by the page via:
 *   audioContext.audioWorklet.addModule('/audio-worklets/pcm-downsampler.js')
 *
 * WHY 16kHz:
 *   Gemini's audio input via the Live API (and most STT services in general)
 *   expects 16kHz mono PCM. Most browser mic defaults to 44.1kHz or 48kHz,
 *   so we need to downsample before we send.
 *
 * HOW:
 *   - The worklet receives Float32 frames of arbitrary length (typically 128
 *     samples = ~2.7ms at 48kHz).
 *   - For each frame we compute a per-frame ratio between AudioContext
 *     sampleRate and TARGET_SAMPLE_RATE.
 *   - We accumulate output samples and emit them in ~100ms frames
 *     (1600 samples @ 16kHz) via `port.postMessage(..., [transferList])`
 *     to avoid copies.
 *
 * NOTE: this is a simple linear-interpolation downsampler. It is good
 * enough for speech; for music-quality capture you'd want a proper
 * polyphase / FIR filter.
 */

const TARGET_SAMPLE_RATE = 16000;
// Emit in ~100ms chunks so the server can do sentence-end detection.
const TARGET_FRAME_SAMPLES = 1600; // 1600 / 16000 = 100 ms

class PCMDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this._enabled = true;
    this._buffer = []; // output samples waiting to be flushed
    this._lastSample = 0; // for linear interpolation across frame boundaries
    this._lastHeld = false;

    this.port.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === "enabled") this._enabled = !!msg.value;
      if (msg.type === "flush") {
        this._flush();
      }
    };
  }

  /**
   * Compute one output sample at logical position `t` (in input-sample units)
   * using linear interpolation between `s0` (input sample at floor(t)) and
   * `s1` (input sample at ceil(t)). If `s1` doesn't exist (we're past the end
   * of this input frame), hold the last sample.
   */
  _interp(s0, s1, frac) {
    if (s1 === undefined) return s0; // hold-last for tail
    return s0 + (s1 - s0) * frac;
  }

  _flush() {
    if (this._buffer.length === 0) return;
    const out = new Float32Array(this._buffer.length);
    out.set(this._buffer);
    this._buffer = [];
    // Transferable: zero-copy to main thread.
    this.port.postMessage({ type: "pcm", samples: out.buffer }, [out.buffer]);
  }

  process(inputs, _outputs, _params) {
    if (!this._enabled) return true;

    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0]; // mono
    if (!channel || channel.length === 0) return true;

    const inputRate = sampleRate; // AudioWorklet global: actual context rate
    const ratio = inputRate / TARGET_SAMPLE_RATE;

    // We use a continuously-advancing phase so downsampling is stable across
    // worklet frames. `phase` is in input-sample units.
    //
    // Initialise lazily on first frame via `this._phase` — but since process()
    // is called repeatedly, we keep state on `this`.
    if (this._phase === undefined) this._phase = 0;

    const len = channel.length;

    // Pull output samples at the desired cadence.
    while (this._phase < len) {
      const i0 = Math.floor(this._phase);
      const frac = this._phase - i0;
      const s0 = channel[i0];
      const s1 = i0 + 1 < len ? channel[i0 + 1] : channel[len - 1];

      // Linear interp
      const v = s0 + (s1 - s0) * frac;
      // Soft clip on the very rare out-of-range sample to be safe.
      const clipped = v > 1 ? 1 : v < -1 ? -1 : v;
      this._buffer.push(clipped);

      this._phase += ratio;

      if (this._buffer.length >= TARGET_FRAME_SAMPLES) {
        this._flush();
      }
    }

    // Wrap phase so it doesn't grow unbounded across long sessions.
    this._phase -= len;

    return true;
  }
}

registerProcessor("pcm-downsampler", PCMDownsampler);
