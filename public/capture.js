import { state } from './state.js';
import { $, status } from './dom.js';
import { encodeWav } from './audio.js';
import { LiveBuffer } from './live.js';
import { compatibleSource } from './annotations.js';
import { splitFinalCaption } from './reading.js';
import { post, requestTranslation } from './translation-jobs.js';
import { drainGlosses } from './gloss-jobs.js';
import { show, remember, removeDemo, showTranslation } from './render-history.js';
import { renderConversation } from './render.js';
import { initializePersistence, newConversation } from './persistence.js';
import { renderWatch } from './watch.js';

export function acceptFinal(event) {
  const chunks = splitFinalCaption(event);
  if (chunks.length > 1) {
    state.messages.delete(event.id);
    state.history = state.history.filter(item => item.id !== event.id);
  }
  for (const chunk of chunks) {
    show(chunk);
    requestTranslation(chunk);
  }
}

export function drain() {
  if (state.processing)
    return state.captureDrain;
  state.processing = true;
  state.captureDrain = drainQueue();
  return state.captureDrain;
}

async function drainQueue() {
  try {
    while (state.queue.length) {
      const job = state.queue.shift();
      if (job.transcriptEpoch !== state.transcriptEpoch)
        continue;
      try {
        const params = new URLSearchParams({
          language: job.language,
          engine: job.engine,
          caption_id: job.id,
          revision: job.revision,
          final: job.final,
          interval: job.interval
        });
        let event = await post(`/api/transcribe?${params}`, encodeWav(job.audio, job.rate));
        if (job.transcriptEpoch !== state.transcriptEpoch)
          continue;
        event.target_language = job.target;
        event.sequence = job.sequence;
        event.capture_session = job.capture_session;
        event.input = job.input;
        event.start_seconds = job.start_seconds;
        event.speech_end_seconds = job.speech_end_seconds;
        event.end_reason = job.end_reason;
        event.speaker_id = null;
        event.speaker_assignment = null;
        event.lag_ms = Math.round(performance.now() - job.capturedAt);
        status(!state.running ? 'Завершаю фразу' : state.queue.length ? 'Распознаю' : 'Слушаю');
        // An empty final clears a tentative hallucination instead of saving it.
        if (!event.text) {
          if (event.final) {
            state.messages.delete(event.id);
            if (state.current?.id === event.id)
              state.current = null;
            showTranslation();
          }
          continue;
        }
        // Preserve the object referenced by in-flight translations across ASR revisions.
        const previous = state.messages.get(event.id);
        if (previous) {
          if (previous.gloss_text && !compatibleSource(event.text, previous.gloss_text)) {
            previous.glosses = [];
            previous.gloss_text = null;
            previous.gloss_status = null;
          }
          if (state.activeGloss?.event === previous && !compatibleSource(event.text, state.activeGloss.text))
            state.activeGloss.controller.abort();
          const { translation, speaker_id, speaker_assignment, ...revision } = event;
          Object.assign(previous, revision);
          event = previous;
        }
        if (event.final && $('readingMode').value !== 'live') {
          acceptFinal(event);
          continue;
        }
        if (!state.current || event.sequence >= (state.current.sequence || 0))
          show(event, false);
        else {
          state.messages.set(event.id, event);
          showTranslation();
        }
        if (event.final)
          remember(event);
        requestTranslation(event);
      } catch (e) {
        if (job.transcriptEpoch === state.transcriptEpoch)
          status(e.message);
      }
    }
  } finally {
    state.processing = false;
    drainGlosses();
  }
}

export function controls() {
  const microphoneRunning = state.running && state.captureSource === 'mic';
  document.body.classList.toggle('is-listening', microphoneRunning);
  $('listenLabel').textContent = state.starting && state.captureSource === 'mic'
    ? 'Включаем микрофон…'
    : microphoneRunning
      ? 'Стоп'
      : 'Слушать';
  $('listen').classList.toggle('active', microphoneRunning);
  $('listen').disabled = state.starting || (!microphoneRunning && !state.liveReady);
  for (const id of [
    'language',
    'targetLanguage',
    'settingsLanguage',
    'settingsTargetLanguage',
    'engine',
    'interval',
    'threshold',
    'sentencePause',
    'swap'
  ])
    $(id).disabled = state.running || state.starting;
  $('demo').disabled = $('clear').disabled = state.starting;
  $('translateText').disabled =
    state.starting ||
    state.running ||
    !state.config ||
    (!state.config.translator && $('language').value !== $('targetLanguage').value);
  renderWatch();
}

export function stop() {
  state.flushCapture?.();
  state.flushCapture = null;
  state.generation++;
  state.running = false;
  if (state.capture)
    state.capture.port.onmessage = null;
  state.source?.disconnect();
  state.capture?.disconnect();
  state.silent?.disconnect();
  state.stream?.getTracks().forEach(track => {
    track.onended = null;
    track.stop();
  });
  state.context?.close().catch(() => {});
  state.source = state.capture = state.silent = state.stream = state.context = null;
  $('meter').value = 0;
  controls();
  showTranslation();
  status(state.captureSource === 'display' ? 'Просмотр остановлен' : 'Микрофон выключен');
}

export async function start({ source = 'mic' } = {}) {
  if (state.starting)
    return;
  if (state.running && state.captureSource === source)
    return stop();
  if (!['mic', 'display'].includes(source))
    return;
  if (state.running)
    stop();
  removeDemo();
  state.current = null;
  state.lastTranslated = null;
  $('mode').textContent = 'Живые субтитры';
  showTranslation();
  state.starting = true;
  state.captureSource = source;
  state.watchError = '';
  controls();
  const epoch = ++state.generation;
  let openedStream;
  try {
    if (source === 'display' && !navigator.mediaDevices?.getDisplayMedia)
      throw new Error('Звук вкладки работает в Chrome и Edge на компьютере');
    if (source === 'mic' && !navigator.mediaDevices?.getUserMedia)
      throw new Error('Микрофон требует localhost или HTTPS.');
    openedStream = source === 'display'
      ? await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: { suppressLocalAudioPlayback: false, echoCancellation: false, noiseSuppression: false },
          systemAudio: 'include',
          selfBrowserSurface: 'exclude',
          surfaceSwitching: 'include'
        })
      : await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
          video: false
        });
    if (source === 'display')
      openedStream.getVideoTracks().forEach(track => track.stop());
    if (epoch !== state.generation) {
      openedStream.getTracks().forEach(t => t.stop());
      return;
    }
    const audioTrack = openedStream.getAudioTracks()[0];
    if (!audioTrack)
      throw new Error('В выбранном источнике нет звука. Отметьте „Поделиться звуком“');
    audioTrack.onended = () => {
      if (epoch === state.generation)
        stop();
    };
    // Chrome rejects constraint changes on tab audio; the request already asks for raw sound.
    if (source === 'display')
      await audioTrack.applyConstraints?.({ echoCancellation: false, noiseSuppression: false }).catch(() => {});
    await initializePersistence();
    const kind = source === 'display' ? 'watch' : 'conversation';
    if (epoch !== state.generation)
      return;
    if (state.sessionKind !== kind) {
      await state.captureDrain;
      if (epoch !== state.generation)
        return;
      if (await newConversation({ preserveCapture: true }) === false)
        throw new Error('Не удалось завершить текущий разговор. Попробуйте снова.');
      if (epoch !== state.generation)
        return;
      state.sessionKind = kind;
    }
    if (audioTrack.readyState === 'ended')
      throw new Error('Показ источника завершён. Выберите вкладку заново.');
    state.stream = openedStream;
    state.captureLabel = source === 'display' ? audioTrack.label || 'Звук вкладки' : 'Микрофон';
    const openedContext = new AudioContext();
    state.context = openedContext;
    await openedContext.resume();
    await openedContext.audioWorklet.addModule('/capture-worklet.js');
    if (epoch !== state.generation) {
      openedStream.getTracks().forEach(t => t.stop());
      await openedContext.close().catch(() => {});
      return;
    }
    const phrases = new LiveBuffer(
      state.context.sampleRate,
      Number($('interval').value),
      source === 'display' ? 0.006 : Number($('threshold').value),
      8,
      Number($('sentencePause').value || 1.2)
    );
    const sessionId = crypto.randomUUID();
    state.source = state.context.createMediaStreamSource(state.stream);
    state.capture = new AudioWorkletNode(state.context, 'capture');
    state.silent = state.context.createGain();
    state.silent.gain.value = 0;
    state.source.connect(state.capture).connect(state.silent).connect(state.context.destination);
    state.running = true;
    status('Слушаю');
    const capturedPair = {
      language: $('language').value,
      target: $('targetLanguage').value,
      engine: $('engine').value,
      interval: Number($('interval').value),
      input: source
    };
    const viewEpoch = state.transcriptEpoch,
      rate = state.context.sampleRate;
    const submit = update => {
      if (!update)
        return;
      const dropped = state.queue.push({
        ...update,
        id: sessionId + '_' + update.sequence,
        sequence: epoch * 1000000 + update.sequence,
        capturedAt: performance.now(),
        rate,
        transcriptEpoch: viewEpoch,
        capture_session: sessionId,
        ...capturedPair
      });
      if (dropped)
        status('Распознавание не успевает: часть речи пропущена. Попробуй интервал 2 с.');
      drain();
    };
    state.flushCapture = () => submit(phrases.flush());
    state.capture.port.onmessage = ({ data }) => {
      if (!state.running || epoch !== state.generation)
        return;
      const { rms, update } = phrases.push(data);
      $('meter').value = rms;
      submit(update);
    };
  } catch (e) {
    if (epoch !== state.generation)
      return;
    stop();
    const message = e.name === 'NotAllowedError'
      ? source === 'display'
        ? 'Выбор источника отменён. Выберите вкладку снова.'
        : 'Доступ к микрофону не разрешён. Разреши его в браузере.'
      : e.message;
    if (source === 'display')
      state.watchError = message;
    status(message);
  } finally {
    if (openedStream && openedStream !== state.stream)
      openedStream.getTracks().forEach(track => {
        track.onended = null;
        track.stop();
      });
    state.starting = false;
    controls();
    renderConversation();
  }
}
