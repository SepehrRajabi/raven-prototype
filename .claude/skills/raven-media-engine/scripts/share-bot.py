"""Native stand-in for a second Raven sharer: joins as "<hex>#video" and publishes a moving
1280x720 test screen with source SCREENSHARE (index 3: a camera). One process per sharer,
so each can be started and stopped on its own. Use it when the browser bot cannot connect
(see references/testing.md).

    python -m venv <scratch>/lkbot
    <scratch>/lkbot/Scripts/pip install livekit livekit-api numpy
    <scratch>/lkbot/Scripts/python share-bot.py raven-nest-<nestId> <index 0-3> [seconds]

Identities: 0 Tone Bot (the browser tone bot's person), 1 Share Bot, 2 Third Bot, 3 Cam Bot.
After a LiveKit outage the SDK does not bring these publishers back: restart the processes.
"""
import asyncio
import os
import sys
import time

import numpy as np
from livekit import api, rtc

SHARERS = [
    ("b07b07b07b07b07b07b07b07b07b07b0#video", "Tone Bot", (60, 130, 200)),
    ("5ec0d5ec0d5ec0d5ec0d5ec0d5ec0d00#video", "Share Bot", (210, 140, 60)),
    ("7417d7417d7417d7417d7417d7417d00#video", "Third Bot", (120, 190, 90)),
    ("ca3ca3ca3ca3ca3ca3ca3ca3ca3ca300#video", "Cam Bot", (190, 90, 160)),
]
W, H, FPS = 1280, 720, 30


def env(name, fallback):
    path = os.path.join(os.environ.get("RAVEN_REPO", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..")), ".env")
    for line in open(path, encoding="utf-8"):
        if line.strip().startswith(name + "="):
            return line.split("=", 1)[1].strip().strip("\"'")
    return fallback


async def main():
    room_name, index = sys.argv[1], int(sys.argv[2])
    seconds = float(sys.argv[3]) if len(sys.argv) > 3 else 3600
    identity, name, colour = SHARERS[index]
    token = (
        api.AccessToken(env("LIVEKIT_API_KEY", "devkey"), env("LIVEKIT_API_SECRET", "secret"))
        .with_identity(identity)
        .with_name(name)
        .with_grants(api.VideoGrants(room_join=True, room=room_name, can_publish=True, can_subscribe=False))
        .to_jwt()
    )
    room = rtc.Room()
    await room.connect(env("LIVEKIT_URL", "ws://127.0.0.1:7880"), token, rtc.RoomOptions(auto_subscribe=False))
    source = rtc.VideoSource(W, H)
    track = rtc.LocalVideoTrack.create_video_track("raven-screen-" + identity[:8], source)
    options = rtc.TrackPublishOptions(
        source=rtc.TrackSource.SOURCE_CAMERA if index == 3 else rtc.TrackSource.SOURCE_SCREENSHARE,
        simulcast=False,
        video_encoding=rtc.VideoEncoding(max_framerate=FPS, max_bitrate=2_500_000),
    )
    await room.local_participant.publish_track(track, options)
    print(f"sharing as {identity} in {room_name}", flush=True)

    background = np.zeros((H, W, 4), dtype=np.uint8)
    background[:, :, 0], background[:, :, 1], background[:, :, 2] = (c // 5 for c in colour)
    background[:, :, 3] = 255
    frame_no = 0
    start = time.monotonic()
    while time.monotonic() - start < seconds:
        frame = background.copy()
        x = (frame_no * 8) % (W - 200)
        frame[260:460, x:x + 200, :3] = colour
        # A strip of stripes whose phase changes every frame, so every frame differs.
        frame[40:80, :, :3] = ((np.arange(W) + frame_no * 16) % 64 < 32)[:, None] * 200
        source.capture_frame(rtc.VideoFrame(W, H, rtc.VideoBufferType.RGBA, frame.tobytes()))
        frame_no += 1
        await asyncio.sleep(max(0, start + frame_no / FPS - time.monotonic()))
    await room.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
