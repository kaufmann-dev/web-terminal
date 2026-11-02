'use strict';

// Child process that keeps the speech-recognition model loaded between dictations. It decodes
// one request at a time and exits when the parent disconnects or stops it.
const os = require('node:os');
const path = require('node:path');
const sherpa = require('sherpa-onnx-node');

const SAMPLE_RATE = 16000;
const modelDirectory = process.argv[2];

process.on('disconnect', () => process.exit(0));

let recognizer;
try {
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(modelDirectory, 'encoder.int8.onnx'),
        decoder: path.join(modelDirectory, 'decoder.int8.onnx'),
        joiner: path.join(modelDirectory, 'joiner.int8.onnx'),
      },
      tokens: path.join(modelDirectory, 'tokens.txt'),
      modelType: 'nemo_transducer',
      numThreads: Math.min(4, os.availableParallelism()),
      provider: 'cpu',
      debug: 0,
    },
  });
} catch (error) {
  console.error(`Voice model failed to load: ${error.message}`);
  process.exit(1);
}

process.on('message', ({ id, segments }) => {
  try {
    const text = segments.map((samples) => {
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
      recognizer.decode(stream);
      return recognizer.getResult(stream).text.trim();
    }).filter(Boolean).join(' ');
    process.send({ id, text });
  } catch (error) {
    process.send({ id, error: error.message });
  }
});

process.send({ type: 'ready' });
