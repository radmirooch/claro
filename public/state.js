import { CaptionQueue, TranslationQueue } from './live.js';
import { defaultParticipants, readParticipants } from './participants.js';
import { createModuleBus } from './modules.js';

export const state = {
  moduleBus: createModuleBus(),
  participants: defaultParticipants(),
  config: undefined,
  running: false,
  starting: false,
  generation: 0,
  translationEpoch: 0,
  stream: undefined,
  context: undefined,
  source: undefined,
  capture: undefined,
  silent: undefined,
  queue: new CaptionQueue(),
  translationQueue: new TranslationQueue(),
  glossQueue: new CaptionQueue(8),
  processing: false,
  translating: false,
  activeTranslation: undefined,
  lastTranslated: undefined,
  engineInitialized: false,
  sessionId: null,
  history: [],
  current: undefined,
  demoActive: false,
  liveReady: false,
  glossing: false,
  flushCapture: undefined,
  transcriptEpoch: 0,
  followConversation: true,
  pendingPartial: null,
  partialSubmitted: new Map(),
  glossEpoch: 0,
  activeGloss: undefined,
  wordPeek: null,
  messages: new Map(),
  messageRows: new Map()
};

try {
  state.participants = readParticipants(JSON.parse(localStorage.getItem('claro.participants.v1')));
} catch {}
