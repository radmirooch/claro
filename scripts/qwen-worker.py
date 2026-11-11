"""Local MLX worker. Audio arrives over stdin; it is never written to disk."""
import base64
import io
import json
import os
import sys
import wave

# Keep stdout exclusively for the Node RPC protocol.
protocol = sys.stdout
sys.stdout = sys.stderr
import numpy as np
from mlx_qwen3_asr import Session

def send(value):
    protocol.write(json.dumps(value, ensure_ascii=False) + "\n")
    protocol.flush()

try:
    session = Session(
        model=os.environ.get("QWEN_MODEL", "moona3k/mlx-qwen3-asr-0.6b-4bit")
    )
    # Compile Metal kernels before enabling the microphone.
    session.transcribe(
        np.zeros(16000, dtype=np.float32),
        language="Spanish",
        max_new_tokens=16
    )
    send({"ready": True})
except Exception as error:
    send({"ready": False, "error": str(error)})
    raise SystemExit(1)

state = None
stream_id = None
fed = 0
for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        with wave.open(io.BytesIO(base64.b64decode(request["wav"])), "rb") as wav:
            if wav.getframerate() != 16000 or wav.getnchannels() != 1 or wav.getsampwidth() != 2:
                raise ValueError("Expected PCM16 mono 16 kHz")
            audio = np.frombuffer(
                wav.readframes(wav.getnframes()), dtype="<i2"
            ).astype(np.float32) / 32768
        live = request.get("live")
        if live:
            if stream_id != live["id"] or state is None:
                state = session.init_streaming(
                    language=request["language"],
                    chunk_size_sec=live["interval"],
                    max_context_sec=15,
                    finalization_mode="latency"
                )
                stream_id, fed = live["id"], 0
            if len(audio) < fed:
                raise ValueError("Audio revision moved backwards")
            if live["final"]:
                # Recheck the full phrase without a forced tentative prefix.
                # This fixes tail errors that fast streaming can otherwise freeze.
                text = session.transcribe(audio, language=request["language"]).text
                state = None
            else:
                state = session.feed_audio(audio[fed:], state)
                fed = len(audio)
                text = state.text
        else:
            text = session.transcribe(audio, language=request["language"]).text
        send({"id": request["id"], "text": text.strip()})
    except Exception as error:
        state = None
        send({"id": request.get("id"), "error": str(error)})
