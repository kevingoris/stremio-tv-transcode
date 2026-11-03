# stremio-tv-transcode

**Automatic transcoding for low-power TVs in Stremio Service.**
*Spanish version below / [Versión en español abajo](#español).*

> 🤖 **Made with AI.** All the code and docs in this repository were written by **Claude** (Anthropic's AI) in Claude Code. The repository owner came up with the idea, tested it on their own TV and guided the work; they didn't write the code.

## The problem

Stremio Service (the streaming server you run on your PC) always sends the **original file** to the player. Many cheap Android TVs (for example TCL with a Realtek chip) can only decode H.264 8-bit, HEVC and VP9 up to 1080p in hardware. With formats like **AV1** (common in small anime releases), **10-bit H.264** or **4K**, what you get is:

- ExoPlayer: **audio but a black screen**.
- VLC / MPV: decodes in software, gets **stuck on one frame**.

The server already ships ffmpeg and knows how to transcode, but the TV app never asks it to.

## What this does

A small hook in `server.js` sends every video request from the local network to `tv-transcode.js`:

1. It probes the file with **ffprobe** (once per file).
2. If the TV **can** play it → it sends the original file, untouched, as before.
3. If it **can't** → it converts it on the fly to **H.264 + AAC** (720p by default) and:
   - keeps all the audio tracks,
   - **burns the subtitles into the picture** in the language you pick (Spanish by default),
   - serves it as a **constant-bitrate MPEG-TS**. Each byte maps to an exact moment, so **seeking and resuming keep working**: the player's `Range` requests are turned into an ffmpeg `-ss`.

Requests from the PC itself (`127.0.0.1`) are never touched, so Stremio on the PC works as usual.

Tested with: Stremio Service on Windows 10 (Xeon E3-1505M, 4 cores), Stremio for Android TV on a TCL Android TV 9 (720p panel). An AV1 1080p 10-bit episode transcodes about **4x faster than real time** on the CPU (libx264 `veryfast`).

## Install (Windows)

1. Download this repository (Code → Download ZIP) and unzip it.
2. Open PowerShell in that folder and run:
   ```powershell
   powershell -ExecutionPolicy Bypass -File install.ps1
   ```
   It copies `tv-transcode.js` next to `server.js`, adds the hook (keeping `server.js.bak-tvtranscode` as a backup) and restarts Stremio Service.
3. **After every Stremio Service update**, run it again: updates replace `server.js` and remove the hook.

Remove it: `install.ps1 -Uninstall`. Turn it off temporarily: create an empty file named `tv-transcode.off` in the Stremio Service folder.

Other systems: the module also looks for `ffmpeg`/`ffprobe` in Linux paths, but the installer is Windows-only. To add the hook by hand, put the line that `install.ps1` inserts right before `EngineFS.emit("stream-open", ...)` inside `handleTorrent`.

## Settings

Copy `tv-transcode.config.example.json` to the Stremio Service folder as `tv-transcode.config.json` and edit it:

| Key | What it does |
|---|---|
| `supportedCodecs` | Codecs your TV decodes in hardware. Anything else gets converted. |
| `h264Allow10bit` | `true` if your TV handles 10-bit H.264. |
| `maxWidth` / `maxHeight` | Maximum resolution your TV decodes. |
| `outputWidth` | Output width (1280 = 720p, 1920 = 1080p, which uses more CPU). |
| `videoBitrate`, `audioBitrate`, `muxrate` | Output quality. `muxrate` has to be above video + all audio tracks. |
| `burnSubtitles` | Languages to burn in, in order of preference (`["spa"]`, `["eng"]`, `[]` for none). |
| `preferSubtitleTitle` | Regex to prefer a track by title (e.g. Latin American Spanish). |

Log: `%TEMP%\stremio-transcode\tv-transcode.log`.

## Limitations

- The **PC does the work**: it needs enough CPU (or you can lower `outputWidth`/`x264Preset`).
- Seeking takes a few seconds (ffmpeg starts again from that point).
- Subtitles are burned into the picture, so you can't switch them from the TV. Text subtitles only (ASS/SRT), not image ones (PGS).
- It isn't official: it depends on the internal structure of `server.js`, which can change between versions.

## For the Stremio team 💡

The proper fix would be in Stremio itself: the TV app knows which codecs its device supports (`MediaCodecList`), and the server already has the HLS transcoder. If the app checked the format before playing and, when the device doesn't support it, asked the server for the HLS stream (`/hlsv2/...`) instead of the original file, this patch wouldn't be needed. See [FEATURE_REQUEST.md](FEATURE_REQUEST.md).

---

## Español

**Transcodificación automática para TVs poco potentes en Stremio Service.**

> 🤖 **Hecho con IA.** Todo el código y la documentación de este repositorio los escribió **Claude** (la IA de Anthropic) en Claude Code. El dueño del repositorio puso la idea, lo probó en su TV y fue guiando el trabajo; no escribió el código.

### El problema
Stremio Service siempre le manda a la TV el **archivo original**. Muchas Android TV baratas (por ejemplo TCL con chip Realtek) solo decodifican por hardware H.264 de 8 bits, HEVC y VP9 hasta 1080p. Con **AV1** (muy común en releases livianos de anime), **H.264 de 10 bits** o **4K**:
- Exo: **se escucha pero se ve negro**.
- VLC o MPV: **se traban en un cuadro**.

### Qué hace
Cuando la TV pide un video, el server lo analiza. Si la TV lo puede reproducir, se lo manda tal cual. Si no, lo convierte en el momento a **H.264 + AAC** (720p por defecto):
- conserva todos los audios,
- **quema los subtítulos** en tu idioma (español por defecto, prefiere latino),
- se puede **adelantar, retroceder y retomar** donde lo dejaste.

### Instalar (Windows)
1. Descargá el repo (Code → Download ZIP) y descomprimilo.
2. En PowerShell, dentro de la carpeta, ejecutá:
   ```powershell
   powershell -ExecutionPolicy Bypass -File install.ps1
   ```
3. **Después de cada actualización de Stremio Service**, volvé a ejecutarlo.

Para sacarlo: `install.ps1 -Uninstall`. Para apagarlo un rato: creá un archivo vacío llamado `tv-transcode.off` en la carpeta de Stremio Service.

### Configuración
Copiá `tv-transcode.config.example.json` a la carpeta de Stremio Service con el nombre `tv-transcode.config.json` y cambiá lo que necesites. La tabla de arriba, en inglés, explica cada opción. Por ejemplo, `"burnSubtitles": ["eng"]` quema los subtítulos en inglés.

### Limitaciones
- La que trabaja es **la PC**: necesita un procesador razonable.
- Adelantar tarda unos segundos.
- Los subtítulos van quemados en la imagen, así que no se pueden cambiar desde la TV.
- No es oficial: cada actualización de Stremio borra el enganche y hay que volver a ejecutar el instalador.

## License
MIT — see [LICENSE](LICENSE). Not affiliated with Stremio.
