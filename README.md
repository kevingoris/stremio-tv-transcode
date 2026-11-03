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

## Set it up for your TV

**The defaults come from a TCL TV with a Realtek chip** (H.264 8-bit, HEVC, VP9, up to 1080p). Other TVs support different formats, so the best thing is to ask your own TV. The server can't figure it out by itself: when the TV requests a video, it doesn't say which formats it supports.

### Option A — automatic, over ADB (recommended)

1. **Turn on debugging on the TV:** Settings → Device Preferences → About → click **Build** 7 times. Then go to **Developer options** and turn on **USB debugging** (on some TVs it's also called *Network debugging* / *ADB over network*).
2. **Find the TV's IP:** Settings → Network → your Wi-Fi network (e.g. `192.168.0.10`).
3. **Download adb** ([Android platform-tools](https://developer.android.com/tools/releases/platform-tools)) and unzip it.
4. Run:
   ```powershell
   powershell -ExecutionPolicy Bypass -File detect-tv-codecs.ps1 -TvIp 192.168.0.10 -Adb C:\path\to\platform-tools\adb.exe -OnlyThisTv
   ```
   The first time, **the TV shows a prompt to allow the PC**: accept it (and tick "always allow").
5. The script reads the TV's decoder list (the `media_codecs*.xml` files Android itself uses), keeps **only the hardware ones**, shows you what it found and saves `tv-transcode.config.json` in the Stremio Service folder. With `-OnlyThisTv`, only that TV gets conversion and the other devices (phone, other TVs) keep getting the original file. Try `-DryRun` first if you just want to see it.
6. Restart Stremio Service.

Example output on the TCL TV:
```
Hardware decoders found on the TV:
  h264        up to 1920x1088  (OMX.realtek.video.decoder)
  hevc        up to 1920x1088  (OMX.realtek.video.decoder)
  vp9         up to 1920x1088  (OMX.realtek.video.decoder)
  ...
```
There's no `av1` in the list → AV1 videos get converted.

### Option B — by hand

Look up your TV's chip (on the spec sheet, or with an app like *AIDA64* or *Device Info HW* on the TV) and which formats it decodes. Then copy `tv-transcode.config.example.json` to the Stremio Service folder as `tv-transcode.config.json` and edit it. For example, a TV that does decode AV1 and 4K:
```json
{ "supportedCodecs": ["h264", "hevc", "vp9", "av1"], "maxWidth": 3840, "maxHeight": 2160 }
```
Any key you leave out uses its default. Restart Stremio Service after changing it.

**How to tell if a format isn't supported:** with ExoPlayer you hear audio over a black screen, and with VLC/MPV the picture freezes on one frame. That format belongs **outside** `supportedCodecs`.

## Settings

All the keys in `tv-transcode.config.json`:

| Key | What it does |
|---|---|
| `supportedCodecs` | Codecs your TV decodes in hardware (ffmpeg names: `h264`, `hevc`, `vp9`, `av1`, `mpeg2video`...). Anything else gets converted. |
| `clients` | IPs of the devices that get conversion (`["192.168.0.10"]`). An empty array means every device on the network. |
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

### Configurarlo para tu TV
**Los valores por defecto son los de una TV TCL con chip Realtek.** Tu TV puede soportar otros formatos, así que lo mejor es preguntárselo a ella. El server no lo puede saber solo: cuando la TV pide un video, no dice qué formatos soporta.

**Automático, por ADB (recomendado):**
1. En la TV: Configuración → Preferencias del dispositivo → Información → hacé clic 7 veces en **Compilación**. Después, en **Opciones de desarrollador**, activá **Depuración por USB** (o *Depuración por red*).
2. Fijate la IP de la TV en Configuración → Red.
3. Descargá [adb](https://developer.android.com/tools/releases/platform-tools) y descomprimilo.
4. Ejecutá:
   ```powershell
   powershell -ExecutionPolicy Bypass -File detect-tv-codecs.ps1 -TvIp 192.168.0.10 -Adb C:\ruta\a\platform-tools\adb.exe -OnlyThisTv
   ```
   La primera vez, **la TV te pregunta si permitís la conexión de la PC**: aceptá.
5. El script lee la lista de decodificadores de la TV, se queda **solo con los de hardware**, te muestra lo que encontró y guarda `tv-transcode.config.json`. Con `-OnlyThisTv`, solo esa TV recibe la conversión; el celular y los demás dispositivos reciben el archivo original. Con `-DryRun` te lo muestra sin guardar nada.
6. Reiniciá Stremio Service.

**A mano:** buscá qué chip tiene tu TV y qué formatos soporta, copiá `tv-transcode.config.example.json` a la carpeta de Stremio Service como `tv-transcode.config.json` y editalo (la tabla de arriba, en inglés, explica cada opción). Por ejemplo, `"burnSubtitles": ["eng"]` quema los subtítulos en inglés.

**Cómo darte cuenta de que la TV no soporta un formato:** en Exo se escucha pero se ve negro, y en VLC o MPV la imagen se traba en un cuadro.

### Limitaciones
- La que trabaja es **la PC**: necesita un procesador razonable.
- Adelantar tarda unos segundos.
- Los subtítulos van quemados en la imagen, así que no se pueden cambiar desde la TV.
- No es oficial: cada actualización de Stremio borra el enganche y hay que volver a ejecutar el instalador.

## License
MIT — see [LICENSE](LICENSE). Not affiliated with Stremio.
