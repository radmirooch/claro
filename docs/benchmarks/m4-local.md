# Local comparison — 2026-11-08

Hardware: Apple M4, 16 GB unified memory. This is a small functional/speed check, not an ASR quality leaderboard.

- Qwen: `moona3k/mlx-qwen3-asr-0.6b-4bit`, revision `4c59c533f95c84afb796655e814709034f826f04`, `mlx-qwen3-asr==0.4.4`, MLX/Metal.
- Whisper: locally installed `whisper.cpp` large-v3-turbo, beam/best-of 1, four CPU threads plus Metal.
- Translation: TranslateGemma 4B via Ollama, CPU only, two threads. `/api/ps` confirmed zero VRAM allocation for this model.
- Input: identical 8.38-second **synthetic** Spanish speech generated locally with macOS Mónica. This does not establish accuracy on real conversations, noise, accents or microphone.
- Whole-file: three sequential calls per engine after startup warmup. Live: the same PCM replayed at real-time cadence through the actual segmentation, bounded queue and HTTP APIs. No microphone was used for this benchmark.

Reference:

> Hola, me gustaría reservar una mesa para dos personas mañana a las ocho. No queremos sentarnos cerca de la puerta. ¿Podría confirmar la dirección y decirme cuánto cuesta el menú?

## Observed timings

| Configuration | First nonempty text from replay start | Median inference per update | Maximum queue + inference + transport after snapshot |
| --- | ---: | ---: | ---: |
| Qwen, 1.5 s updates | 1.815 s | 0.260 s | 0.469 s |
| Whisper, 1.5 s updates | 4.145 s | 2.594 s | 3.542 s |
| Qwen, 1.5 s, concurrent translation including cold load | 1.742 s | 0.371 s | 1.634 s |
| Qwen, 1 s updates | 1.112 s | 0.230 s | 0.728 s |
| Qwen, 1 s, concurrent warm translation | 1.275 s | 0.372 s | 0.471 s |

No utterances were dropped. Superseded pending Whisper partials were coalesced, so it did not deliver every requested update. Whole-file median: Qwen 0.702 s, Whisper 2.679 s (three runs each in the 1.5-second comparison). Individual results vary with background load; the faster first result during a translation test is warmup/measurement variation, not evidence that translation accelerates ASR.

The concurrent translation input was a fixed two-sentence restaurant request, started at replay start to test resource contention. It was not triggered by the live caption itself. Translation took 16.893 s including cold loading in one run and 5.440 s warm in the next. This is still noticeable delay. Separating CPU/GPU workloads and bounding the queue prevents translation from blocking caption requests, but does not remove shared memory/CPU contention or make translation instantaneous.

## Quality observation

Both whole-file transcriptions preserved the reference words, apart from spelling/punctuation/number formatting. With the live audio window and added endpoint silence, Qwen's final result changed **“cuánto cuesta el menú”** into **“cuanto cuesta al menos”**. Whisper retained “el menú.” This remains a real error; faster recognition is not a quality win. Intermediate text also changes while the speaker continues. Final Qwen phrases are re-decoded without the provisional prefix, but that does not guarantee correction.

Default: Qwen + 1.5 s updates for a balanced starting point. The 1 s option kept up on this Mac and sample. Whisper stays selectable for comparison. Real conversation quality should be tested on your own consented recordings before choosing a permanent default.

## Reproduce

With Claro running and the microphone stopped:

```sh
npm run benchmark:asr -- /path/to/spanish.wav --interval=1.5 --translation --output=.runtime/comparison-1.5.json
npm run benchmark:asr -- /path/to/spanish.wav --interval=1 --engines=qwen --translation --output=.runtime/comparison-1.json
```

Use PCM16 mono 16 kHz WAV, at most 15 seconds. The local raw reports contain each provisional/final text and timing; `.runtime/` and audio are excluded from Git. At the time of this run the test suite had 12 passing checks, including simulated microphone capture, late translation, lazy tap translation, model routing, revision identity and queue bounds. Browser verification covered readiness and switching Qwen/Whisper; it did not measure real microphone recognition quality.


## Incremental translation, 8 November 2026

Same M4 / 16 GB, existing TranslateGemma 4B and Qwen3-ASR weights. No new model download. The local configuration now sets `OLLAMA_NUM_GPU=99`. These are illustrative single-device runs, not broad model-quality results.

For the same two-sentence Spanish input, completed translation took 3,072 ms on warm CPU (two threads) and 2,187 ms on warm GPU. Switching/loading took 7,247–7,835 ms on the first request. A separate GPU streaming run produced its first text in 560–621 ms; complete translations took 1,008–2,016 ms for the three tested inputs. Time starts when text is submitted, not at the beginning of speech.

The mobile HTTPS bridge passed through 27 records for a two-sentence translation: first text 611 ms, complete response 2,232 ms. This test ran on the Mac against the actual mobile endpoint with certificate verification and authenticated pairing; it does not measure an actual iPhone radio link.

Synthetic Spanish speech replay at a 1-second ASR interval:

| Condition | First original text | Maximum post-capture ASR lag | Dropped ASR jobs |
|---|---:|---:|---:|
| Qwen alone | 1,125 ms | 461 ms | 0 |
| Qwen + one concurrent GPU translation | 1,376 ms | 569 ms | 0 |

The concurrent translation completed in 2,529 ms. Sharing the GPU modestly increased ASR latency in this run. The translation still added an evening qualifier not explicit in the source; faster delivery is not a guarantee of accuracy. Continuous draft translation differs from this one-concurrent-job test and should be assessed separately. Raw results remain in ignored `.runtime/benchmark-gpu-translation.json` and `.runtime/benchmark-mobile-stream.json`.


### Full pipeline with repeated draft translation

Replayed the same synthetic Spanish recording with automatic draft translations at roughly 2-second intervals and final-translation priority, using the actual ASR and streaming translation endpoints. Times below start at the beginning of audio replay, unlike the isolated translation timings above.

| Pass | First caption | First translation | Maximum ASR post-capture lag | Dropped jobs |
|---|---:|---:|---:|---:|
| First measured pass | 1,490 ms | 5,164 ms | 2,203 ms | 0 |
| Immediate repeat | 1,352 ms | 1,685 ms | 2,095 ms | 0 |

On the immediate repeat the first translation appeared 333 ms after the first recognized text, but later long drafts competed with ASR: worst observed post-capture lag was about 2.1 seconds. Final translation completed 14.5 seconds after replay began. These results do not support a claim of consistently instantaneous translation. The first-pass slowdown is consistent with warmup/cache effects but was not independently attributed. Original partials and translations changed as context grew; in particular, the model added time-of-day qualifiers absent from the source. Raw reports are `.runtime/benchmark-live-translation-first.json` and `.runtime/benchmark-live-translation.json`.


## Automatic streamed hints (v0.8, 2026-11-08)

Local qwen3:4b, CPU, two threads; Spanish source “¿Nos vemos en la cafetería a las ocho?”, Russian context “Встретимся в кафе в восемь?”. A first non-streamed run took 9,426 ms. A following streamed run, concurrently with a TranslateGemma translation of “Mañana quiero ir a la biblioteca.”, emitted the first validated hint at 3,235 ms, the second at 4,900 ms and the third at 5,954 ms; both jobs completed in 6,153 ms. Translation emitted its first text at 1,758 ms. These are local request-to-output measurements, not speech-start latency or an iPhone test, and the runs have different warm/cache conditions. They demonstrate overlapping model work and early hint display, not a guaranteed speedup or zero hardware contention.


An additional short-audio comparison used the first 1.5 seconds of the existing synthetic Spanish WAV on the running Qwen endpoint. Baseline round trips: 120 / 94 / 94 ms; with a concurrently starting streamed CPU hint job: 299 / 518 / 545 ms. The first hint arrived at 7,009 ms and the job finished at 10,044 ms after a server restart. A one-thread trial gave baseline 200 / 109 / 98 ms and concurrent 210 / 538 / 480 ms, with first hint at 11,482 ms and completion at 14,934 ms. One thread did not meaningfully eliminate contention and made hints slower, so the two-thread default was retained. These small sequential samples are diagnostic, not a statistical benchmark. ASR does not wait for hint completion, but zero added latency on shared hardware is not claimed.

## Complete interlinear output (v0.9, 8 November 2026)

Synthetic typed phrases only, installed Qwen3 4B; no microphone recording or new model download. The initial indexed-object format took 35.2 s for an eight-unit Spanish phrase (first validated item 19.9 s). Switching to a compact ordered meanings array reduced output overhead: a different seven-unit Spanish phrase took 20.1 s (first 16.4 s); English→Russian took 13.7 s and Russian→Spanish 13.0 s. These are different texts/warmup states, not a controlled speedup estimate. One English result assigned a punctuation-only meaning; the validator now rejects such output for lexical source units, and the prompt explicitly distinguishes per-word equivalents from splitting a natural sentence translation.

With the revised prompt and temporary `GLOSS_NUM_GPU=99`, English→Russian produced six meanings in 9.1 s (first 6.6 s), and Russian→Spanish four meanings in 4.9 s (first 3.5 s). A subsequent concurrent GPU gloss + TranslateGemma run completed both jobs in 13.3 s, first gloss 4.3 s. Qwen ASR round trips for the first 1.5 seconds of the existing synthetic Spanish WAV were 1806/281/258 ms before that run and 2087/957/629 ms during it. Cold/warm conditions differ, and these tiny samples are not a performance ranking. They establish hardware contention, not instant translation. The default interlinear CPU policy was retained; GPU use is configurable, not silently enabled. Raw diagnostic timings are in ignored `.runtime/interlinear-gpu-check.json`.

Structural coverage checks do not certify translation quality. Articles, idioms and grammatical roles can still be translated awkwardly. The natural sentence translation stays available separately, and incomplete outputs expose retry rather than claim full completion.

Browser QA uses synthetic fixtures: late meanings leave all source coordinates unchanged; resizing preserves every source unit in order; bubbles stay within three source rows at normal and large text in the tested viewports; no horizontal overflow at 320 px; captions-only retains source text even if the original had previously been hidden. These checks do not measure physical iPhone behavior or microphone quality.
