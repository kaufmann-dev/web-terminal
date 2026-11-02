export const RECORDING_TYPES = [
  'audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus',
];
// The server's speech recognizer accepts only 16 kHz mono 16-bit PCM WAV.
export const TRANSCRIPTION_SAMPLE_RATE = 16000;

export function encodeWav(audioBuffer) {
  const channels = Array.from({ length: audioBuffer.numberOfChannels },
    (_, index) => audioBuffer.getChannelData(index));
  const length = audioBuffer.length;
  const view = new DataView(new ArrayBuffer(44 + length * 2));
  const text = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, audioBuffer.sampleRate, true);
  view.setUint32(28, audioBuffer.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, length * 2, true);
  for (let index = 0; index < length; index++) {
    let sample = 0;
    for (const channel of channels) sample += channel[index];
    sample = Math.max(-1, Math.min(1, sample / channels.length));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([view.buffer], { type: 'audio/wav' });
}

export class VoiceRecorder {
  constructor({ getTarget, submit, render, mediaDevices = globalThis.navigator?.mediaDevices,
    Recorder = globalThis.MediaRecorder, secure = globalThis.isSecureContext,
    now = () => performance.now(), timers = globalThis, AudioContext = globalThis.OfflineAudioContext }) {
    Object.assign(this, { getTarget, submit, render, mediaDevices, Recorder, secure, now, timers,
      AudioContext });
    this.config = null;
    this.operation = null;
    this.state = 'idle';
    this.message = '';
  }

  unavailable() {
    if (!this.secure) return 'Microphone requires HTTPS.';
    if (!this.mediaDevices?.getUserMedia || !this.Recorder?.isTypeSupported || !this.AudioContext) {
      return 'Microphone recording is unsupported.';
    }
    if (!this.config) return 'Checking voice availability…';
    if (!this.config.available) return 'Voice model is not installed.';
    if (!RECORDING_TYPES.some((type) => this.Recorder.isTypeSupported(type))) {
      return 'No supported audio recording format.';
    }
    if (!this.getTarget()) return 'Connect a terminal to dictate.';
    return '';
  }

  update() {
    if (this.operation && !this.isCurrent(this.operation)) this.cancel();
    const reason = this.unavailable();
    const elapsed = this.operation?.startedAt === undefined ? 0
      : Math.min(this.config.maxDurationMs, this.now() - this.operation.startedAt);
    const seconds = Math.floor(elapsed / 1000);
    this.render({ state: this.state, disabled: Boolean(reason) ||
      ['permission', 'transcribing'].includes(this.state),
    cancelDisabled: !this.operation, message: reason || this.message || 'Ready to dictate',
    elapsed: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` });
  }

  isCurrent(operation) {
    const target = this.getTarget();
    return this.operation === operation && target?.controller === operation.target.controller
      && target?.connection === operation.target.connection;
  }

  release(operation) {
    this.timers.clearInterval(operation.timer);
    this.timers.clearTimeout(operation.deadline);
    if (operation.recorder) {
      operation.recorder.ondataavailable = null;
      operation.recorder.onstop = null;
      operation.recorder.onerror = null;
      if (operation.recorder.state !== 'inactive') {
        try { operation.recorder.stop(); } catch { /* Tracks still must be released. */ }
      }
    }
    operation.stream?.getTracks().forEach((track) => track.stop());
    operation.chunks = [];
    operation.abort.abort();
  }

  cancel(message = '') {
    const operation = this.operation;
    this.operation = null;
    if (operation) this.release(operation);
    this.state = 'idle';
    this.message = message;
    this.update();
  }

  fail(operation, message) {
    if (this.operation !== operation) return;
    this.cancel();
    this.state = 'error';
    this.message = message;
    this.update();
  }

  async start() {
    if (this.operation || this.unavailable()) return;
    const operation = { target: this.getTarget(), chunks: [], bytes: 0, abort: new AbortController() };
    this.operation = operation;
    this.state = 'permission';
    this.message = 'Allow microphone access…';
    this.update();
    try {
      const stream = await this.mediaDevices.getUserMedia({ audio: true });
      if (!this.isCurrent(operation)) {
        stream.getTracks().forEach((track) => track.stop());
        if (this.operation === operation) this.cancel();
        return;
      }
      operation.stream = stream;
      const mimeType = RECORDING_TYPES.find((type) => this.Recorder.isTypeSupported(type));
      const recorder = new this.Recorder(stream, { mimeType });
      operation.recorder = recorder;
      recorder.ondataavailable = ({ data }) => {
        if (!this.isCurrent(operation)) return;
        operation.bytes += data.size;
        if (operation.bytes > this.config.maxBytes) {
          this.fail(operation, 'Recording exceeds the 10 MiB limit.');
          return;
        }
        if (data.size) operation.chunks.push(data);
      };
      recorder.onerror = () => this.fail(operation, 'Microphone recording failed. Try again.');
      recorder.onstop = () => this.finish(operation);
      recorder.start(1000);
      operation.startedAt = this.now();
      operation.timer = this.timers.setInterval(() => this.update(), 1000);
      operation.deadline = this.timers.setTimeout(() => this.stop(), this.config.maxDurationMs);
      this.state = 'recording';
      this.message = 'Recording';
      this.update();
    } catch (err) {
      this.fail(operation, err.name === 'NotAllowedError'
        ? 'Microphone access denied.' : 'Unable to start microphone recording.');
    }
  }

  stop() {
    const operation = this.operation;
    if (!operation || this.state !== 'recording') return;
    this.state = 'transcribing';
    this.message = 'Transcribing…';
    this.timers.clearInterval(operation.timer);
    this.timers.clearTimeout(operation.deadline);
    try {
      operation.recorder.stop();
      operation.stream.getTracks().forEach((track) => track.stop());
      this.update();
    } catch {
      this.fail(operation, 'Microphone recording failed. Try again.');
    }
  }

  async finish(operation) {
    if (!this.isCurrent(operation) || operation.submitted) return;
    operation.submitted = true;
    this.state = 'transcribing';
    this.message = 'Transcribing…';
    this.timers.clearInterval(operation.timer);
    this.timers.clearTimeout(operation.deadline);
    operation.stream.getTracks().forEach((track) => track.stop());
    this.update();
    try {
      const recording = new Blob(operation.chunks, { type: operation.recorder.mimeType });
      operation.chunks = [];
      if (!recording.size) {
        this.fail(operation, 'No audio recorded. Try again.');
        return;
      }
      let audio;
      try {
        // decodeAudioData resamples to the context's rate.
        const context = new this.AudioContext(1, 1, TRANSCRIPTION_SAMPLE_RATE);
        audio = encodeWav(await context.decodeAudioData(await recording.arrayBuffer()));
      } catch {
        this.fail(operation, 'Audio could not be processed. Record again.');
        return;
      }
      if (!this.isCurrent(operation)) {
        if (this.operation === operation) this.cancel();
        return;
      }
      const { text } = await this.submit(audio, operation.abort.signal);
      if (!this.isCurrent(operation)) {
        if (this.operation === operation) this.cancel();
        return;
      }
      // Consume the operation before inserting; no response can be replayed.
      this.operation = null;
      this.release(operation);
      if (text) operation.target.controller.pasteTerminalProgrammatically(text);
      this.state = 'idle';
      this.message = text ? 'Text inserted. Press Enter to execute.' : 'No speech detected';
      this.update();
    } catch (err) {
      this.fail(operation, err.message || 'Transcription failed. Try again.');
    }
  }
}

export function bindVoiceControls(root, recorder) {
  let announcement = '';
  const groups = [...root.querySelectorAll('[data-voice-controls]')];
  const live = root.getElementById('voice-announcement');
  for (const group of groups) {
    for (const button of group.querySelectorAll('button')) {
      const activate = () => {
        if (button.disabled) return;
        if (button.hasAttribute('data-voice-cancel')) recorder.cancel('Dictation canceled.');
        else if (recorder.state === 'recording') recorder.stop();
        else recorder.start();
      };
      // Preserve existing textarea focus and the software keyboard on touch and mouse.
      let touch = null;
      let suppressClickUntil = 0;
      button.addEventListener('touchstart', (event) => {
        event.preventDefault();
        touch = event.touches.length === 1 ? event.touches[0] : null;
      }, { passive: false });
      button.addEventListener('touchmove', (event) => {
        const moved = [...event.touches].find((item) => item.identifier === touch?.identifier);
        if (!moved || Math.hypot(moved.clientX - touch.clientX, moved.clientY - touch.clientY) >= 10) {
          touch = null;
        }
      }, { passive: true });
      button.addEventListener('touchend', (event) => {
        event.preventDefault();
        suppressClickUntil = performance.now() + 1000;
        const end = [...event.changedTouches].find((item) => item.identifier === touch?.identifier);
        if (end && Math.hypot(end.clientX - touch.clientX, end.clientY - touch.clientY) < 10) activate();
        touch = null;
      }, { passive: false });
      button.addEventListener('touchcancel', () => { touch = null; });
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', (event) => {
        if (event.detail !== 0 && performance.now() < suppressClickUntil) return;
        activate();
      });
    }
  }
  return ({ state, disabled, cancelDisabled, message, elapsed }) => {
    for (const group of groups) {
      group.dataset.state = state;
      const action = group.querySelector('[data-voice-action]');
      // The markup holds microphone and stop icons; CSS shows one based on the group's state.
      const actionLabel = state === 'recording' ? 'Stop dictation' : 'Start dictation';
      action.setAttribute('aria-label', actionLabel);
      action.setAttribute('title', actionLabel);
      action.disabled = disabled;
      group.querySelector('[data-voice-cancel]').disabled = cancelDisabled;
      const status = group.querySelector('[data-voice-status]');
      status.textContent = state === 'recording' ? `${message} ${elapsed}` : message;
      status.title = status.textContent;
      status.setAttribute('aria-label', status.textContent);
    }
    const next = `${state}: ${message}`;
    if (announcement !== next) {
      announcement = next;
      live.textContent = message;
    }
  };
}
