'use strict';

const { fork: forkProcess } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MAX_VOICE_BYTES = 10 * 1024 * 1024;
const MAX_VOICE_DURATION_MS = 5 * 60 * 1000;
const VOICE_SAMPLE_RATE = 16000;
// Browser resampling can add a few milliseconds; recordings stop at the five-minute deadline.
const DURATION_TOLERANCE_MS = 2000;
const MODEL_FILES = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'];
// Recognizer memory grows with input length, so audio is decoded in segments of at most 30 s
// (about 1 GB peak), each cut at the quietest 100 ms frame within its last five seconds.
const SEGMENT_SAMPLES = 30 * VOICE_SAMPLE_RATE;
const CUT_SEARCH_SAMPLES = 5 * VOICE_SAMPLE_RATE;
const CUT_FRAME_SAMPLES = VOICE_SAMPLE_RATE / 10;
const WORKER_PATH = path.join(__dirname, 'transcription-worker.js');

class VoiceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function cleanTranscript(text) {
  return text.replace(/[\r\n\t\u2028\u2029]+/g, ' ')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim();
}

const invalidAudio = () => new VoiceError(400, 'Audio could not be transcribed. Record again.');
const transcriptionFailed = () => new VoiceError(502, 'Voice transcription failed. Record again.');

// Accepts only 16 kHz mono 16-bit PCM WAV and returns its samples scaled to [-1, 1).
function parseWav(buffer) {
  if (buffer.length < 12 || buffer.toString('latin1', 0, 4) !== 'RIFF'
    || buffer.toString('latin1', 8, 12) !== 'WAVE') {
    throw invalidAudio();
  }
  let hasFormat = false;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString('latin1', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > buffer.length) throw invalidAudio();
    if (id === 'fmt ') {
      if (size < 16 || buffer.readUInt16LE(start) !== 1 || buffer.readUInt16LE(start + 2) !== 1
        || buffer.readUInt32LE(start + 4) !== VOICE_SAMPLE_RATE || buffer.readUInt16LE(start + 14) !== 16) {
        throw invalidAudio();
      }
      hasFormat = true;
    } else if (id === 'data') {
      if (!hasFormat || size % 2) throw invalidAudio();
      const samples = new Float32Array(size / 2);
      if (samples.length * 1000 / VOICE_SAMPLE_RATE > MAX_VOICE_DURATION_MS + DURATION_TOLERANCE_MS) {
        throw new VoiceError(413, 'Recording exceeds the 5-minute limit.');
      }
      for (let index = 0; index < samples.length; index++) {
        samples[index] = buffer.readInt16LE(start + index * 2) / 32768;
      }
      return samples;
    }
    // RIFF chunks are padded to an even length.
    offset = start + size + (size % 2);
  }
  throw invalidAudio();
}

function splitSamples(samples) {
  const segments = [];
  let start = 0;
  while (samples.length - start > SEGMENT_SAMPLES) {
    const end = start + SEGMENT_SAMPLES;
    let cut = end;
    let quietest = Infinity;
    for (let frame = end - CUT_SEARCH_SAMPLES; frame + CUT_FRAME_SAMPLES <= end; frame += CUT_FRAME_SAMPLES / 2) {
      let energy = 0;
      for (let index = frame; index < frame + CUT_FRAME_SAMPLES; index++) energy += samples[index] ** 2;
      if (energy < quietest) {
        quietest = energy;
        cut = frame + CUT_FRAME_SAMPLES / 2;
      }
    }
    segments.push(samples.slice(start, cut));
    start = cut;
  }
  segments.push(samples.slice(start));
  return segments;
}

function hasModel(directory) {
  return MODEL_FILES.every((name) => {
    try {
      fs.accessSync(path.join(directory, name), fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  });
}

// Runs speech recognition in a child process that loads the model on first use and exits after
// idleMs without requests, so the model only occupies memory while dictation is in use.
function createTranscriptionService({ modelDirectory, idleMs = 10 * 60 * 1000, timeoutMs = 60000,
  fork = forkProcess, log = console.error }) {
  const available = hasModel(modelDirectory);
  let worker = null;
  let queue = Promise.resolve();
  let idleTimer = null;
  let nextId = 0;
  let closed = false;

  function stopWorker(state) {
    if (worker === state) worker = null;
    clearTimeout(idleTimer);
    state.child.kill('SIGTERM');
  }

  function scheduleIdleStop() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (worker && !worker.pending) stopWorker(worker);
    }, idleMs);
    idleTimer.unref();
  }

  function startWorker() {
    // The worker needs no environment, so application secrets never reach it.
    const child = fork(WORKER_PATH, [modelDirectory], {
      env: {}, serialization: 'advanced', stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    const state = { child, pending: null, ready: false };
    const lost = (detail) => {
      if (worker !== state) return;
      worker = null;
      log(`Voice transcription worker ${detail}.`);
      const { pending } = state;
      state.pending = null;
      pending?.reject(transcriptionFailed());
    };
    child.on('message', (message) => {
      if (worker !== state) return;
      if (message?.type === 'ready') {
        state.ready = true;
        if (state.pending) send(state);
        return;
      }
      const { pending } = state;
      if (!pending || message?.id !== pending.id) return;
      state.pending = null;
      scheduleIdleStop();
      if (typeof message.text === 'string') {
        pending.resolve(message.text);
      } else {
        log(`Voice transcription failed: ${String(message.error).slice(0, 500)}`);
        pending.reject(transcriptionFailed());
      }
    });
    child.on('exit', (code, signal) => lost(signal ? `exited with ${signal}` : `exited with code ${code}`));
    child.on('error', (error) => {
      lost(`failed: ${error.message}`);
      child.kill('SIGKILL');
    });
    worker = state;
    return state;
  }

  function send(state) {
    try {
      state.child.send({ id: state.pending.id, segments: state.pending.segments });
    } catch (error) {
      state.child.emit('error', error);
    }
  }

  function runOnWorker(segments) {
    if (closed) return Promise.reject(transcriptionFailed());
    clearTimeout(idleTimer);
    const state = worker || startWorker();
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      // The deadline covers model loading and decoding.
      const timer = setTimeout(() => {
        if (state.pending?.id !== id) return;
        state.pending = null;
        log('Voice transcription timed out; stopping the worker.');
        stopWorker(state);
        reject(new VoiceError(504, 'Transcription timed out. Record again.'));
      }, timeoutMs);
      const settle = (callback) => (value) => {
        clearTimeout(timer);
        callback(value);
      };
      state.pending = { id, segments, resolve: settle(resolve), reject: settle(reject) };
      if (state.ready) send(state);
    });
  }

  function transcribe({ audio, signal }) {
    if (!available) return Promise.reject(new VoiceError(503, 'Voice model is not installed.'));
    let segments;
    try {
      segments = splitSamples(parseWav(audio));
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        callback(value);
      };
      // A canceled request returns immediately; the worker finishes the short decode and the
      // queue waits for it, so the next request never overlaps it.
      const onAbort = () => settle(reject, signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      queue = queue.then(async () => {
        if (settled) return;
        try {
          settle(resolve, await runOnWorker(segments));
        } catch (error) {
          settle(reject, error);
        }
      });
    });
  }

  function close() {
    closed = true;
    clearTimeout(idleTimer);
    const state = worker;
    if (!state) return Promise.resolve();
    const { pending } = state;
    state.pending = null;
    pending?.reject(transcriptionFailed());
    const { child } = state;
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve));
    stopWorker(state);
    return exited;
  }

  return { available, transcribe, close };
}

module.exports = { MAX_VOICE_BYTES, MAX_VOICE_DURATION_MS, MODEL_FILES, VOICE_SAMPLE_RATE, VoiceError,
  cleanTranscript, createTranscriptionService, parseWav, splitSamples };
