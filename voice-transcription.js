'use strict';

const MAX_VOICE_BYTES = 10 * 1024 * 1024;
const MAX_VOICE_DURATION_MS = 5 * 60 * 1000;
const AUDIO_TYPES = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg' };

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

function createTranscriptionService({ apiKey, fetchImpl = fetch, timeoutMs = 60000 }) {
  return async ({ audio, mimeType, signal }) => {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const combinedSignal = AbortSignal.any([signal, timeout.signal]);
    try {
      const form = new FormData();
      form.set('file', new Blob([audio], { type: mimeType }),
        `recording.${AUDIO_TYPES[mimeType.split(';')[0].trim()]}`);
      for (const [name, value] of Object.entries({
        model_id: 'scribe_v2', no_verbatim: 'true', tag_audio_events: 'false',
        diarize: 'false', timestamps_granularity: 'none', webhook: 'false',
      })) form.set(name, value);
      const response = await fetchImpl('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST', headers: { 'xi-api-key': apiKey }, body: form, signal: combinedSignal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 429) throw new VoiceError(429, 'Transcription is busy. Try again later.');
        if ([400, 415, 422].includes(response.status)) {
          throw new VoiceError(400, 'Audio could not be transcribed. Record again.');
        }
        throw new VoiceError(502, 'Transcription provider unavailable.');
      }
      const result = await response.json();
      if (typeof result.text !== 'string') throw new Error('Invalid provider response');
      return cleanTranscript(result.text);
    } catch (err) {
      if (signal.aborted) throw signal.reason;
      if (timeout.signal.aborted) throw new VoiceError(504, 'Transcription timed out. Record again.');
      if (err instanceof VoiceError) throw err;
      throw new VoiceError(502, 'Transcription provider unavailable.');
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = { AUDIO_TYPES, MAX_VOICE_BYTES, MAX_VOICE_DURATION_MS, VoiceError,
  cleanTranscript, createTranscriptionService };
