// Capabilities are explicit: a settings screen cannot enable a missing engine.
export const MODULES = Object.freeze([
  { id: 'captions', available: true, optional: false, inputs: ['audio'], outputs: ['caption'] },
  {
    id: 'translation',
    available: true,
    optional: true,
    inputs: ['caption'],
    outputs: ['translation']
  },
  {
    id: 'interlinear',
    available: true,
    optional: true,
    inputs: ['caption', 'translation'],
    outputs: ['interlinear']
  },
  {
    id: 'participants',
    available: true,
    optional: true,
    inputs: ['caption'],
    outputs: ['speaker_assignment']
  },
  {
    id: 'diarization',
    available: false,
    optional: true,
    inputs: ['audio'],
    outputs: ['speaker_turn']
  },
  {
    id: 'voice_identity',
    available: false,
    optional: true,
    inputs: ['audio', 'voice_profile'],
    outputs: ['speaker_assignment']
  },
  {
    id: 'practice',
    available: false,
    optional: true,
    inputs: ['confirmed_self_turn'],
    outputs: ['exercise']
  }
]);

// Modules subscribe to records, not DOM or microphone ownership. Handler
// failure is isolated from capture; listeners are disposed when a module stops.
export function createModuleBus(onError = () => {}) {
  const listeners = new Map();
  return {
    subscribe(type, handler) {
      const set = listeners.get(type) || new Set();
      set.add(handler);
      listeners.set(type, set);
      return () => set.delete(handler);
    },
    publish(type, payload) {
      for (const handler of listeners.get(type) || []) {
        const snapshot = structuredClone(payload);
        Promise.resolve()
          .then(() => handler(snapshot))
          .catch(onError);
      }
    }
  };
}
