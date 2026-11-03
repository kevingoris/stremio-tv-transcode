// tv-transcode.js — on-the-fly transcoding for low-power TVs in Stremio Service
// https://github.com/kevingoris/stremio-tv-transcode
//
// Stremio's streaming server always sends the original file to the player.
// Cheap Android TVs often can't decode some formats in hardware (AV1,
// 10-bit H.264, 4K...), so the picture stays black, or it freezes on the first
// frame while the audio keeps playing.
//
// This module is loaded from a small hook in server.js (handleTorrent). When a
// device on the LAN (not the PC itself) requests a video that the TV can't
// decode, the server converts it on the fly to H.264 + AAC, which every TV
// supports, and can burn subtitles into the picture. Anything the TV can
// play is sent untouched, as before.
//
// The output is a constant-bitrate MPEG-TS (fixed muxrate): every byte maps to
// an exact moment in the video, so the player's "Range" requests (seeking,
// resuming) turn into an ffmpeg "-ss" and seeking keeps working.
//
// Settings: tv-transcode.config.json next to this file (see README).
// To turn it off without touching server.js: create "tv-transcode.off" next
// to this file.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execFile } = require("child_process");

const BIN_DIR = path.dirname(process.execPath);
const EXE = process.platform === "win32" ? ".exe" : "";
const OFF_FLAG = path.join(BIN_DIR, "tv-transcode.off");
const CONFIG_FILE = path.join(BIN_DIR, "tv-transcode.config.json");
const WORK_DIR = path.join(os.tmpdir(), "stremio-transcode");
const LOG_FILE = path.join(WORK_DIR, "tv-transcode.log");

const DEFAULTS = {
    // What the TV decodes in hardware. Anything else gets converted.
    supportedCodecs: [ "h264", "hevc", "vp9", "mpeg2video", "mpeg4" ],
    h264Allow10bit: false,
    maxWidth: 1920,
    maxHeight: 1088,
    // Output
    outputWidth: 1280,        // 1280 = 720p. Use 1920 for 1080p panels (more CPU).
    videoBitrate: "2000k",
    audioBitrate: "128k",
    maxAudioTracks: 4,
    muxrate: 3000000,         // bits/s, must be above video + all audio tracks
    x264Preset: "veryfast",
    // Subtitles burned into the picture (an empty array means none)
    burnSubtitles: [ "spa" ], // ISO 639-2 language codes, in order of preference
    preferSubtitleTitle: "latin|lat\\b|419|latam",
    subtitlesWaitMs: 6000,
    // Only these devices (IPs) get conversion. An empty array means every device on the LAN.
    clients: [],
    // Local server port (ffmpeg reads the original file through it)
    serverPort: 11470
};

const config = (() => {
    try { return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"))); } catch (e) { return DEFAULTS; }
})();

const FFMPEG = findBin("ffmpeg");
const FFPROBE = findBin("ffprobe");
const LOCAL_BASE = "http://127.0.0.1:" + config.serverPort;
const BYTES_PER_SEC = config.muxrate / 8;
const TS_PACKET = 188;
const VIDEO_EXT = /\.(mkv|mp4|m4v|webm|avi|mov|ts)$/i;
const TEXT_SUBS = [ "ass", "ssa", "subrip", "srt", "webvtt", "mov_text" ];

const probes = {};   // key -> Promise<info|null>
const subJobs = {};  // key -> { done, file, promise }
const sessions = {}; // key -> Set<session>

try { fs.mkdirSync(WORK_DIR, { recursive: true }); } catch (e) {}

function findBin(name) {
    const candidates = [ path.join(BIN_DIR, name + EXE), path.join(BIN_DIR, "bin", name + EXE),
        "/usr/lib/jellyfin-ffmpeg/" + name, "/usr/bin/" + name, "/usr/local/bin/" + name ];
    return candidates.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } }) || name;
}

function log(msg) {
    fs.appendFile(LOG_FILE, new Date().toISOString() + " " + msg + "\n", () => {});
}

function isLoopback(addr) {
    return !addr || addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function needsTranscode(v) {
    if (!v) return false;
    if (!config.supportedCodecs.includes(v.codec_name)) return true;
    if (v.codec_name === "h264" && !config.h264Allow10bit && /10|12/.test(v.pix_fmt || "")) return true;
    if ((v.width || 0) > config.maxWidth || (v.height || 0) > config.maxHeight) return true;
    return false;
}

function pickSubtitle(subs) {
    const lang = (s) => ((s.tags && s.tags.language) || "").toLowerCase();
    const title = (s) => ((s.tags && s.tags.title) || "");
    const prefer = config.preferSubtitleTitle ? new RegExp(config.preferSubtitleTitle, "i") : null;
    for (const l of config.burnSubtitles || []) {
        const ofLang = subs.filter((s) => lang(s) === l);
        const pick = (prefer && ofLang.find((s) => prefer.test(title(s))))
            || ofLang.find((s) => !/forced|signs/i.test(title(s)))
            || ofLang[0];
        if (pick) return pick;
    }
    return null;
}

function probe(key, inputUrl) {
    if (probes[key]) return probes[key];
    probes[key] = new Promise((resolve) => {
        execFile(FFPROBE, [ "-v", "error", "-show_entries",
            "stream=index,codec_type,codec_name,pix_fmt,width,height:stream_tags=language,title:stream_disposition=default:format=duration",
            "-of", "json", inputUrl ], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
            if (err) { log("probe failed " + key + ": " + err.message); delete probes[key]; return resolve(null); }
            try {
                const j = JSON.parse(stdout);
                const streams = j.streams || [];
                const video = streams.find((s) => s.codec_type === "video");
                const audio = streams.filter((s) => s.codec_type === "audio");
                const subs = streams.filter((s) => s.codec_type === "subtitle" && TEXT_SUBS.includes(s.codec_name));
                const duration = parseFloat(j.format && j.format.duration) || 0;
                const sub = pickSubtitle(subs);
                const info = { needs: needsTranscode(video) && duration > 0, video, audio: audio.slice(0, config.maxAudioTracks), sub, duration };
                log("probe " + key + ": " + (video ? video.codec_name + " " + video.pix_fmt + " " + video.width + "x" + video.height : "no video")
                    + " dur=" + duration + " transcode=" + info.needs + " subs=" + (sub ? sub.index + " " + ((sub.tags && sub.tags.title) || "") : "none"));
                resolve(info);
            } catch (e) { log("probe parse " + key + ": " + e.message); delete probes[key]; resolve(null); }
        });
    });
    return probes[key];
}

// Extracts the subtitle track to an .ass file. It has to read the whole file
// (the torrent downloads much faster than it gets watched).
function extractSubs(key, inputUrl, info) {
    if (!info.sub) return null;
    if (subJobs[key]) return subJobs[key];
    const file = path.join(WORK_DIR, key.replace(/[^a-z0-9]/gi, "_") + ".ass");
    const job = { done: false, file };
    if (fs.existsSync(file)) { job.done = true; job.promise = Promise.resolve(true); return subJobs[key] = job; }
    const tmp = file + ".tmp.ass";
    job.promise = new Promise((resolve) => {
        const p = spawn(FFMPEG, [ "-hide_banner", "-loglevel", "error", "-y", "-i", inputUrl,
            "-map", "0:" + info.sub.index, "-c:s", "ass", tmp ], { windowsHide: true });
        p.on("close", (code) => {
            if (code === 0 && fs.existsSync(tmp)) {
                try { fs.renameSync(tmp, file); job.done = true; } catch (e) {}
            }
            log("subs " + key + (job.done ? " ready" : " failed (" + code + ")"));
            resolve(job.done);
            if (job.done) kickSessionsWithoutSubs(key);
        });
    });
    return subJobs[key] = job;
}

// Once the subtitles are ready, drop the connections that were being served
// without them: the player retries from the same position and the new
// connection comes with subtitles.
function kickSessionsWithoutSubs(key) {
    (sessions[key] || new Set()).forEach((s) => {
        if (!s.withSubs) { log("reconnecting session without subs " + key); s.kill(); try { s.res.destroy(); } catch (e) {} }
    });
}

function subsFilterPath(file) {
    // Escaped for ffmpeg's "subtitles" filter (on Windows: C\:/...).
    return file.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

const NULL_PACKET = (() => {
    const b = Buffer.alloc(TS_PACKET, 0xff);
    b[0] = 0x47; b[1] = 0x1f; b[2] = 0xff; b[3] = 0x10;
    return b;
})();

function serve(req, res, key, inputUrl, info, subFile) {
    const total = Math.ceil(info.duration * BYTES_PER_SEC / TS_PACKET) * TS_PACKET;
    let start = 0, end = total - 1;
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
    if (m) {
        if (m[1] !== "") start = parseInt(m[1], 10);
        else if (m[2] !== "") start = Math.max(0, total - parseInt(m[2], 10));
        if (m[1] !== "" && m[2] !== "") end = Math.min(parseInt(m[2], 10), total - 1);
    }
    if (start >= total) {
        res.statusCode = 416; res.setHeader("Content-Range", "bytes */" + total); return res.end();
    }
    const length = end - start + 1;
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", "video/mp2t");
    res.setHeader("Cache-Control", "max-age=0, no-cache");
    res.setHeader("Content-Length", length);
    if (m) {
        res.statusCode = 206;
        res.setHeader("Content-Range", "bytes " + start + "-" + end + "/" + total);
    }
    if (req.method === "HEAD") return res.end();

    // Byte -> second (the TS is constant bitrate). Never so close to the end
    // that ffmpeg can't output a single frame.
    const t = Math.min(start / BYTES_PER_SEC, Math.max(0, info.duration - 3));
    const vf = [ "scale='min(" + config.outputWidth + ",iw)':-2" ];
    if (subFile) vf.push("subtitles='" + subsFilterPath(subFile) + "'");
    vf.push("format=yuv420p");
    const args = [ "-hide_banner", "-loglevel", "error", "-nostdin" ];
    if (t > 0.5) args.push("-ss", t.toFixed(3));
    args.push("-copyts", "-i", inputUrl, "-map", "0:" + info.video.index);
    info.audio.forEach((a) => args.push("-map", "0:" + a.index));
    args.push("-vf", vf.join(","),
        "-c:v", "libx264", "-preset", config.x264Preset,
        "-b:v", config.videoBitrate, "-maxrate", config.videoBitrate, "-bufsize", config.videoBitrate, "-g", "48",
        "-c:a", "aac", "-b:a", config.audioBitrate, "-ac", "2",
        "-f", "mpegts", "-muxrate", String(config.muxrate), "pipe:1");

    const ff = spawn(FFMPEG, args, { windowsHide: true });
    const session = { res, withSubs: !!subFile, kill: () => { try { ff.kill("SIGKILL"); } catch (e) {} } };
    (sessions[key] = sessions[key] || new Set()).add(session);
    log("serving " + key + " from " + t.toFixed(1) + "s bytes " + start + "-" + end + (subFile ? " with subs" : " without subs")
        + " to " + req.connection.remoteAddress);

    let sent = 0, finished = false, errText = "";
    ff.stderr.on("data", (d) => { if (errText.length < 2000) errText += d; });

    function done() {
        if (finished) return;
        finished = true;
        session.kill();
        sessions[key] && sessions[key].delete(session);
    }
    res.on("close", done);

    ff.stdout.on("data", (chunk) => {
        if (finished) return;
        const left = length - sent;
        if (chunk.length >= left) { res.end(chunk.slice(0, left)); sent += left; return done(); }
        sent += chunk.length;
        if (!res.write(chunk)) { ff.stdout.pause(); res.once("drain", () => ff.stdout.resume()); }
    });

    // If ffmpeg finishes early (end of the video), pad with null packets up
    // to the promised length, otherwise the player treats it as an error.
    ff.on("close", (code) => {
        if (errText) log("ffmpeg " + key + " (" + code + "): " + errText.trim().split("\n").slice(-3).join(" | "));
        if (finished) return;
        const pad = () => {
            while (!finished && sent < length) {
                const n = Math.min(TS_PACKET * 512, length - sent);
                const buf = Buffer.alloc(n);
                for (let o = 0; o < n; o += TS_PACKET) NULL_PACKET.copy(buf, o, 0, Math.min(TS_PACKET, n - o));
                sent += n;
                if (sent >= length) { res.end(buf); return done(); }
                if (!res.write(buf)) return res.once("drain", pad);
            }
        };
        pad();
    });
}

// Calls back with true if it handled the request, false if server.js should
// send the original file as usual.
function maybeHandle(req, res, engine, fileIdx, fileName, cb) {
    try {
        if (fs.existsSync(OFF_FLAG)) return cb(false);
        const addr = req.connection && req.connection.remoteAddress;
        if (isLoopback(addr)) return cb(false);
        if ((config.clients || []).length && !config.clients.includes((addr || "").replace(/^::ffff:/, ""))) return cb(false);
        if (/[?&](notranscode|download)=/.test(req.url)) return cb(false);
        if (!VIDEO_EXT.test(fileName || "")) return cb(false);
    } catch (e) { return cb(false); }

    const key = engine.infoHash + "/" + fileIdx;
    const inputUrl = LOCAL_BASE + "/" + engine.infoHash + "/" + fileIdx;
    probe(key, inputUrl).then((info) => {
        if (!info || !info.needs) return cb(false);
        cb(true);
        let closed = false;
        res.on("close", () => { closed = true; });
        const job = extractSubs(key, inputUrl, info);
        if (!job || job.done) return serve(req, res, key, inputUrl, info, job && job.done ? job.file : null);
        let served = false;
        const go = () => {
            if (served) return;
            served = true;
            if (!closed) serve(req, res, key, inputUrl, info, job.done ? job.file : null);
        };
        job.promise.then(go);
        setTimeout(go, config.subtitlesWaitMs);
    }).catch((e) => { log("error " + key + ": " + e.message); cb(false); });
}

module.exports = { maybeHandle };
