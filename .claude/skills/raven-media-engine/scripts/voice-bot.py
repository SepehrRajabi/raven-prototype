"""Native stand-in for a person talking into a microphone: joins as "<hex>#audio" and
publishes a synthetic voice (a gliding harmonic stack with a syllable rhythm, which the
speech detector accepts; a plain tone is not speech). Used to check Auto-level: run two
at different levels and watch the app's faders even them out.

    python -m venv <scratch>/lkbot
    <scratch>/lkbot/Scripts/pip install livekit livekit-api numpy
    <scratch>/lkbot/Scripts/python voice-bot.py raven-nest-<nestId> <index 0-2> <level dB> [options]

    --turn A/B     talk for A seconds out of every B (default 3/6)
    --offset S     start the turn S seconds into the cycle, so two bots take turns
    --mute F-T     mute the microphone track from F to T seconds after joining
    --seconds N    leave after N seconds (default 3600)

<level dB> scales the voice: about the K-weighted loudness of its speech, in LUFS. Two
bots talking at once 20 dB apart look like bleed to Auto-level, so give them turns.
The voice plays on the tester's speakers when the app is in the call: keep it short.
"""
import argparse
import asyncio
import os
import time

import numpy as np
from livekit import api, rtc

VOICES = [
    ("a0d10a0d10a0d10a0d10a0d10a0d1000#audio", "Quiet Bot", 110.0),
    ("10d010d010d010d010d010d010d01000#audio", "Loud Bot", 150.0),
    ("70c470c470c470c470c470c470c47000#audio", "Third Voice", 125.0),
]
RATE, FRAME = 48_000, 480


def env(name, fallback):
    path = os.path.join(os.environ.get("RAVEN_REPO", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..")), ".env")
    for line in open(path, encoding="utf-8"):
        if line.strip().startswith(name + "="):
            return line.split("=", 1)[1].strip().strip("\"'")
    return fallback


def voice(seconds, pitch):
    """The voice_like signal of audio/voice.rs tests: unit-ish level, scaled later."""
    t = np.arange(int(RATE * seconds)) / RATE
    glide = pitch + 0.12 * pitch * np.sin(2 * np.pi * 2 * t)
    phase = 2 * np.pi * np.cumsum(glide) / RATE
    syllable = 0.5 + 0.5 * np.sin(2 * np.pi * 3 * t)
    voiced = sum(np.sin(phase * h) / h for h in range(1, 21))
    return syllable * voiced


def k_loudness(signal):
    """Rough K-weighted loudness, enough to set the bot's level: the voice is mostly
    under 2 kHz, where the weighting is close to flat."""
    return -0.691 + 10 * np.log10(np.mean(signal**2) + 1e-12)


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("room")
    parser.add_argument("index", type=int)
    parser.add_argument("level", type=float)
    parser.add_argument("--turn", default="3/6")
    parser.add_argument("--offset", type=float, default=0.0)
    parser.add_argument("--mute", default=None)
    parser.add_argument("--seconds", type=float, default=3600)
    args = parser.parse_args()
    talk, cycle = (float(x) for x in args.turn.split("/"))
    mute_from, mute_to = (float(x) for x in args.mute.split("-")) if args.mute else (None, None)

    identity, name, pitch = VOICES[args.index]
    token = (
        api.AccessToken(env("LIVEKIT_API_KEY", "devkey"), env("LIVEKIT_API_SECRET", "secret"))
        .with_identity(identity)
        .with_name(name)
        .with_grants(api.VideoGrants(room_join=True, room=args.room, can_publish=True, can_subscribe=False))
        .to_jwt()
    )
    room = rtc.Room()
    await room.connect(env("LIVEKIT_URL", "ws://127.0.0.1:7880"), token, rtc.RoomOptions(auto_subscribe=False))
    source = rtc.AudioSource(RATE, 2)
    track_name = "raven-audio-" + identity[:8] + "-0000-4000-8000-" + identity[20:32]
    track = rtc.LocalAudioTrack.create_audio_track(track_name, source)
    publication = await room.local_participant.publish_track(
        track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
    )

    speech = voice(talk, pitch)
    speech *= 10 ** ((args.level - k_loudness(speech)) / 20)
    print(f"{name} talking at {args.level:.1f} LUFS ({talk:g}s of every {cycle:g}s, "
          f"offset {args.offset:g}s) in {args.room}; peak {20 * np.log10(np.abs(speech).max()):.1f} dBFS",
          flush=True)

    start = time.monotonic()
    sent = 0
    muted = False
    while time.monotonic() - start < args.seconds:
        elapsed = sent / RATE
        should_mute = mute_from is not None and mute_from <= elapsed < mute_to
        if should_mute != muted:
            muted = should_mute
            (track.mute if muted else track.unmute)()
            print(f"{elapsed:6.1f}s {'muted' if muted else 'unmuted'}", flush=True)
        position = (elapsed + cycle - args.offset) % cycle
        if muted or position >= talk:
            block = np.zeros(FRAME)
        else:
            index = int(position * RATE)
            block = speech[index:index + FRAME]
            block = np.pad(block, (0, FRAME - len(block)))
        pcm = (np.clip(block, -1, 1) * 32767).astype(np.int16)
        frame = rtc.AudioFrame.create(RATE, 2, FRAME)
        np.frombuffer(frame.data, dtype=np.int16)[:] = np.repeat(pcm, 2)
        await source.capture_frame(frame)
        sent += FRAME
        await asyncio.sleep(max(0, start + sent / RATE - time.monotonic() - 0.02))
    await room.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
