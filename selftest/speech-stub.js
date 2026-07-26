/* Self-test stub for js/speech.js — swapped in by the import map in selftest.html.

   Two reasons this is stubbed rather than used for real:
   - speak() resolves on the utterance's `onend`, which a background or headless
     tab may never fire, hanging the suite on the first `await speakStep()`.
   - voiceSupported() returning false keeps VoiceListener out of the picture, so
     no assertion depends on microphone permission.

   Exports match the real module exactly: gates.js takes `speak`; session.js
   takes `speak`, `stopSpeaking`, `voiceSupported` and `VoiceListener`. */

export const spoken = []; // what the modules under test tried to say, in order

export function speak(text) {
  spoken.push(text);
  return Promise.resolve();
}

export function stopSpeaking() { /* nothing is speaking */ }

export function voiceSupported() { return false; }

export function matchesCallout() { return false; }

/* Never constructed while voiceSupported() is false; present so the import
   shape stays identical to the real module. */
export class VoiceListener {
  constructor(keywords, callbacks) { this.cb = callbacks || {}; }
  start() { if (this.cb.onUnavailable) this.cb.onUnavailable('unsupported'); }
  suspend() {}
  resume() {}
  stop() {}
}
