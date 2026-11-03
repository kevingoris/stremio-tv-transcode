# Feature request: transcode on the server when the TV can't decode the video

*(Draft to post on Stremio's GitHub. Written by Claude, Anthropic's AI, based on a user's idea and tests.)*

**Problem**

On low-power Android TVs, Stremio sends the original file straight to the player. If the device has no hardware decoder for the format, playback fails silently:

- **AV1** (very common in small anime releases, e.g. `[Trix] ... [WEBRip 1080p AV1 Opus]`), **10-bit H.264** and **4K** on TVs that only decode 1080p.
- ExoPlayer plays **audio over a black screen**. VLC/MPV decode in software and **freeze on one frame**.

Example device: TCL Android TV 9 (Realtek, `OMX.realtek.video.decoder`: avc/hevc/vp9 up to 1920x1088, no AV1), with Stremio Service on a Windows PC on the same network.

**The server can already fix this**

Stremio Service ships ffmpeg with `libdav1d` and has the HLS transcoder (`/hlsv2/.../master.m3u8?mediaURL=...&videoCodecs=h264...`). On a modest PC (Xeon E3-1505M) a 1080p 10-bit AV1 episode transcodes to H.264 about 4x faster than real time.

**Proposal**

In the Android TV app, before playing:
1. Check whether the device decodes the stream's video codec/profile/resolution (`MediaCodecList`, or the server's `/probe` result).
2. If it doesn't, play the server's HLS (`/hlsv2/...`) with `videoCodecs`/`audioCodecs` matching the device's codecs, instead of the original file.
3. Optionally, a setting: "Transcode unsupported formats on the server: Auto / Always / Never".

**Working proof of concept**

https://github.com/kevingoris/stremio-tv-transcode — a small module (`tv-transcode.js`) plus a hook in `server.js` that does it on the server side: it probes the file, and if the codec isn't supported it serves H.264 + AAC as a constant-bitrate MPEG-TS (so Range/seeking keeps working), and it exposes the file's embedded subtitles through a small local subtitles addon, since MPEG-TS can't carry them. It works with the current Android TV app without changes, but the right fix belongs in the app.
