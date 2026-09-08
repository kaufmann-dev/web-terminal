const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { cleanTranscript } = require('../voice-transcription');

const deferred = () => Promise.withResolvers();
async function fixture(options = {}) {
  const { VoiceRecorder } = await import('../public/js/voice-recorder.mjs');
  const inserted = [];
  const controller = { pasteTerminalProgrammatically: (text) => inserted.push(text) };
  let target = { controller, connection: {} };
  let stopped = 0;
  const track = { stop: () => stopped++ };
  const stream = { getTracks: () => [track] };
  let calls = 0;
  let recorder;
  let clock = 0;
  const intervals = new Map();
  const deadlines = new Map();
  let timerId = 0;
  class Recorder {
    static isTypeSupported(type) { return type === (options.mime || 'audio/webm;codecs=opus'); }
    constructor(_stream, { mimeType }) {
      if (options.constructorError) throw new Error('recorder failed');
      this.mimeType = mimeType; this.state = 'inactive'; recorder = this;
    }
    start(timeslice) { this.state = 'recording'; assert.equal(timeslice, 1000); }
    chunk(blob = new Blob(['speech'])) { this.ondataavailable?.({ data: blob }); }
    stop() {
      this.state = 'inactive';
      this.chunk();
      queueMicrotask(() => this.onstop?.());
    }
  }
  let view;
  const voice = new VoiceRecorder({ getTarget: () => target,
    submit: options.submit || (async (audio) => {
      calls++;
      assert.equal(audio.type, options.mime || 'audio/webm;codecs=opus');
      return { text: cleanTranscript(' do\nthis\tplease\x03 ') };
    }),
    render: (state) => { view = state; },
    mediaDevices: { getUserMedia: options.permission || (async (constraints) => {
      assert.deepEqual(constraints, { audio: true }); return stream;
    }) }, Recorder, secure: true, now: () => clock,
    timers: { setInterval: (fn) => { intervals.set(++timerId, fn); return timerId; },
      clearInterval: (id) => intervals.delete(id),
      setTimeout: (fn, delay) => { deadlines.set(++timerId, { fn, delay }); return timerId; },
      clearTimeout: (id) => deadlines.delete(id) },
  });
  voice.config = { configured: true, maxBytes: 10 * 1024 * 1024, maxDurationMs: 300000 };
  voice.update();
  return { voice, inserted, stream, intervals, deadlines, controller,
    get recorder() { return recorder; }, get stopped() { return stopped; },
    get calls() { return calls; }, get view() { return view; },
    changeTarget: (next) => { target = next; }, tick: (ms) => { clock += ms; intervals.forEach((fn) => fn()); } };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('recording submits the actual format exactly once, cleans text and never appends Enter', async () => {
  for (const mime of ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    const f = await fixture({ mime });
    await Promise.all([f.voice.start(), f.voice.start()]);
    assert.equal(f.voice.state, 'recording');
    f.tick(65000);
    assert.equal(f.view.elapsed, '1:05');
    f.recorder.chunk();
    const duplicateStop = f.recorder.onstop;
    f.voice.stop(); f.voice.stop();
    assert.ok(f.stopped > 0);
    await settle();
    duplicateStop();
    await settle();
    assert.equal(f.calls, 1);
    assert.deepEqual(f.inserted, ['do this please']);
    assert.equal(f.voice.operation, null);
    assert.equal(f.intervals.size + f.deadlines.size, 0);
  }
});

test('cancel while permission is pending releases a late microphone and allows a new operation', async () => {
  const permission = deferred();
  const f = await fixture({ permission: () => permission.promise });
  const pending = f.voice.start();
  assert.equal(f.voice.state, 'permission');
  f.voice.cancel();
  permission.resolve(f.stream);
  await pending;
  assert.equal(f.stopped, 1);
  assert.equal(f.recorder, undefined);
  assert.equal(f.calls, 0);
  await f.voice.start();
  assert.equal(f.voice.state, 'recording');
  f.voice.cancel();
});

test('permission rejection, recorder construction and recording failures release resources', async () => {
  for (const options of [
    { permission: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); } },
    { constructorError: true }, {},
  ]) {
    const f = await fixture(options);
    await f.voice.start();
    if (f.recorder) f.recorder.onerror();
    assert.equal(f.voice.state, 'error');
    assert.equal(f.voice.operation, null);
    if (!options.permission) assert.ok(f.stopped > 0);
    assert.equal(f.calls, 0);
  }
});

test('size overflow cancels, including the final chunk; five minutes automatically submits', async () => {
  const f = await fixture();
  await f.voice.start();
  f.recorder.chunk(new Blob([new Uint8Array(f.voice.config.maxBytes + 1)]));
  await settle();
  assert.equal(f.voice.state, 'error');
  assert.equal(f.calls, 0);
  assert.ok(f.stopped > 0);
  await f.voice.start();
  f.recorder.chunk(new Blob([new Uint8Array(f.voice.config.maxBytes)]));
  f.voice.stop();
  await settle();
  assert.equal(f.voice.state, 'error');
  assert.equal(f.calls, 0);
  await f.voice.start();
  const deadline = [...f.deadlines.values()][0];
  assert.equal(deadline.delay, 300000);
  deadline.fn();
  await settle();
  assert.equal(f.calls, 1);
  assert.equal(f.deadlines.size + f.intervals.size, 0);
});

test('cancel or terminal/connection changes discard pending transcription without replay', async () => {
  for (const change of ['cancel', 'session', 'connection', 'disconnect']) {
    const response = deferred(); let signal;
    const f = await fixture({ submit: (_audio, abortSignal) => { signal = abortSignal; return response.promise; } });
    await f.voice.start(); f.voice.stop(); await settle();
    assert.equal(f.voice.state, 'transcribing');
    if (change === 'cancel') f.voice.cancel();
    else {
      f.changeTarget(change === 'disconnect' ? null : {
        controller: change === 'session' ? {} : f.controller, connection: {},
      });
      f.voice.update();
    }
    assert.equal(signal.aborted, true);
    response.resolve({ text: 'stale command' }); await settle();
    assert.deepEqual(f.inserted, []);
    assert.equal(f.voice.operation, null);
  }
});

test('empty speech inserts nothing and provider failures can be retried manually', async () => {
  const f = await fixture({ submit: async () => ({ text: '' }) });
  await f.voice.start(); f.voice.stop(); await settle();
  assert.deepEqual(f.inserted, []);
  assert.equal(f.view.message, 'No speech detected');
  f.voice.submit = async () => { throw new Error('Transcription timed out. Record again.'); };
  await f.voice.start(); f.voice.stop(); await settle();
  assert.equal(f.voice.state, 'error');
  assert.equal(f.view.disabled, false);
  assert.equal(f.voice.operation, null);
});

test('unsupported, insecure, unconfigured, or disconnected recording is disabled', async () => {
  const f = await fixture();
  for (const [key, value] of [['secure', false], ['mediaDevices', {}], ['Recorder', {}], ['config', { configured: false }]]) {
    const original = f.voice[key]; f.voice[key] = value;
    f.voice.update(); await f.voice.start();
    assert.equal(f.view.disabled, true);
    assert.equal(f.voice.operation, null);
    f.voice[key] = original;
  }
  f.changeTarget(null); f.voice.update();
  assert.equal(f.view.disabled, true);
});

test('terminal programmatic paste bypasses armed modifiers and preserves them', () => {
  const source = fs.readFileSync('public/js/terminal.js', 'utf8');
  // Execute the actual two production methods, preserving their lexical this binding.
  const match = source.match(/    runWithMobileModifiersBypassed = ([\s\S]*?)\n    };\n\n    pasteTerminalProgrammatically = ([\s\S]*?)\n    };/);
  assert.ok(match);
  const controller = vm.runInNewContext(`new class {
    runWithMobileModifiersBypassed = ${match[1]}\n};
    pasteTerminalProgrammatically = ${match[2]}\n};
  }`);
  controller.mobileModifiers = { ctrl: true, shift: true, alt: true };
  let inserted;
  controller.terminal = { paste(text) {
    assert.equal(controller.programmaticInputDepth, 1);
    inserted = text;
  } };
  controller.programmaticInputDepth = 0;
  controller.pasteTerminalProgrammatically('hello');
  assert.equal(inserted, 'hello');
  assert.equal(controller.programmaticInputDepth, 0);
  assert.deepEqual(controller.mobileModifiers, { ctrl: true, shift: true, alt: true });
});

test('touch activates once, movement cancels, keyboard activation works and timers do not announce', async () => {
  const { bindVoiceControls } = await import('../public/js/voice-recorder.mjs');
  class Element extends EventTarget {
    dataset = {};
    attributes = {};
    textContent = '';
    disabled = false;
    setAttribute(name, value) { this.attributes[name] = value; }
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  }
  const action = new Element();
  const cancel = new Element(); cancel.setAttribute('data-voice-cancel', '');
  const status = new Element();
  const group = new Element();
  group.querySelectorAll = () => [action, cancel];
  group.querySelector = (sel) => ({ '[data-voice-action]': action, '[data-voice-cancel]': cancel,
    '[data-voice-status]': status })[sel];
  let announcements = 0;
  const live = { set textContent(_text) { announcements++; } };
  const root = { querySelectorAll: () => [group], getElementById: () => live };
  let starts = 0; let stops = 0;
  const voice = { state: 'idle', start() { starts++; this.state = 'recording'; },
    stop() { stops++; }, cancel() { this.state = 'idle'; } };
  const render = bindVoiceControls(root, voice);
  const dispatch = (type, data = {}) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, data); action.dispatchEvent(event); return event;
  };
  const point = { identifier: 1, clientX: 5, clientY: 5 };
  assert.equal(dispatch('touchstart', { touches: [point] }).defaultPrevented, true);
  dispatch('touchend', { changedTouches: [point] });
  dispatch('click', { detail: 1 });
  assert.equal(starts, 1); assert.equal(stops, 0);
  dispatch('touchstart', { touches: [point] });
  dispatch('touchmove', { touches: [{ ...point, clientY: 50 }] });
  dispatch('touchend', { changedTouches: [point] });
  assert.equal(stops, 0);
  dispatch('click', { detail: 0 });
  assert.equal(stops, 1);
  assert.equal(dispatch('mousedown').defaultPrevented, true);
  render({ state: 'recording', message: 'Recording', elapsed: '0:01' });
  render({ state: 'recording', message: 'Recording', elapsed: '0:02' });
  assert.equal(announcements, 1);
  assert.equal(status.textContent, 'Recording 0:02');
  assert.equal(status.attributes['aria-label'], status.textContent);
  render({ state: 'transcribing', message: 'Transcribing…', elapsed: '0:02' });
  assert.equal(announcements, 2);
});
