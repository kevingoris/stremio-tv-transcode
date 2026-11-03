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
// supports. Anything the TV can play is sent untouched, as before. The file's
// subtitles reach Stremio through a small addon (see further down), so you
// still pick them, and their timing, in Stremio.
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
                const info = { needs: needsTranscode(video) && duration > 0, video, audio: audio.slice(0, config.maxAudioTracks), subs, duration };
                log("probe " + key + ": " + (video ? video.codec_name + " " + video.pix_fmt + " " + video.width + "x" + video.height : "no video")
                    + " dur=" + duration + " transcode=" + info.needs + " subtitle tracks=" + subs.length);
                resolve(info);
            } catch (e) { log("probe parse " + key + ": " + e.message); delete probes[key]; resolve(null); }
        });
    });
    return probes[key];
}

const NULL_PACKET = (() => {
    const b = Buffer.alloc(TS_PACKET, 0xff);
    b[0] = 0x47; b[1] = 0x1f; b[2] = 0xff; b[3] = 0x10;
    return b;
})();

function serve(req, res, key, inputUrl, info) {
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
    const vf = [ "scale='min(" + config.outputWidth + ",iw)':-2", "format=yuv420p" ];
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
    const session = { kill: () => { try { ff.kill("SIGKILL"); } catch (e) {} } };
    (sessions[key] = sessions[key] || new Set()).add(session);
    log("serving " + key + " from " + t.toFixed(1) + "s bytes " + start + "-" + end + " to " + req.connection.remoteAddress);

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

// ---------------------------------------------------------------------------
// Subtitles addon
//
// The converted video is an MPEG-TS, which can't carry the file's text
// subtitles, so the TV app would lose them. To keep Stremio showing them
// separately (as usual, with its own menu and style), the server also works
// as a small Stremio addon: for each converted file it offers all its embedded
// text tracks, extracted to .srt.
//
//   https://<the address the TV uses for the server>/tv-transcode/manifest.json
// ---------------------------------------------------------------------------

const converted = {}; // key -> { engine, fileIdx, name, length, info, inputUrl, at }
const allSubJobs = {}; // key -> Promise<bool>

function remember(key, engine, fileIdx, fileName, info, inputUrl) {
    const f = engine.files && engine.files[fileIdx];
    converted[key] = { engine, fileIdx, name: fileName, length: f ? f.length : 0, info, inputUrl, at: Date.now() };
}

function subFile(key, streamIndex) {
    return path.join(WORK_DIR, key.replace(/[^a-z0-9]/gi, "_") + "_" + streamIndex + ".srt");
}

// Extracts every text subtitle track to .srt in a single pass over the file.
function extractAllSubs(key) {
    const c = converted[key];
    if (!c || !c.info.subs.length) return Promise.resolve(false);
    if (allSubJobs[key]) return allSubJobs[key];
    if (c.info.subs.every((s) => fs.existsSync(subFile(key, s.index)))) return allSubJobs[key] = Promise.resolve(true);
    allSubJobs[key] = new Promise((resolve) => {
        const args = [ "-hide_banner", "-loglevel", "error", "-y", "-i", c.inputUrl ];
        c.info.subs.forEach((s) => args.push("-map", "0:" + s.index, "-c:s", "srt", subFile(key, s.index) + ".tmp.srt"));
        const p = spawn(FFMPEG, args, { windowsHide: true });
        p.on("close", (code) => {
            c.info.subs.forEach((s) => { try { fs.renameSync(subFile(key, s.index) + ".tmp.srt", subFile(key, s.index)); } catch (e) {} });
            log("all subs " + key + " " + (code === 0 ? "ready" : "failed (" + code + ")"));
            if (code !== 0) delete allSubJobs[key];
            resolve(code === 0);
        });
    });
    return allSubJobs[key];
}

function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*",
        "Cache-Control": "max-age=0, no-cache" });
    res.end(body);
}

function baseUrl(req) {
    const secure = req.socket && req.socket.constructor && req.socket.constructor.name === "TLSSocket";
    return (secure ? "https://" : "http://") + req.headers.host + "/tv-transcode";
}

// Which converted file is Stremio asking subtitles for? By size (Stremio
// sends videoSize), then by name; otherwise the one being converted right now.
function findConverted(extra) {
    const list = Object.keys(converted).map((k) => Object.assign({ key: k }, converted[k]));
    const size = parseInt(extra.videoSize, 10);
    if (size) return list.find((c) => c.length === size) || null;
    if (extra.filename) return list.find((c) => c.name === decodeURIComponent(extra.filename)) || null;
    return list.filter((c) => (sessions[c.key] && sessions[c.key].size) || Date.now() - c.at < 60000)
        .sort((a, b) => b.at - a.at)[0] || null;
}

const MANIFEST = {
    id: "local.tv-transcode.subtitles",
    version: "1.0.0",
    name: "TV transcode subtitles",
    description: "Embedded subtitles of the videos that Stremio Service converts for the TV (tv-transcode).",
    resources: [ "subtitles" ],
    types: [ "movie", "series", "anime", "other" ],
    catalogs: []
};

// Routes under /tv-transcode/. Calls next() for anything else.
function handleRoute(req, res, next) {
    const u = (req.url || "").split("?")[0];
    if (u.indexOf("/tv-transcode/") !== 0) return next();
    if (req.method === "OPTIONS") {
        res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" });
        return res.end();
    }
    const rest = u.slice("/tv-transcode/".length);
    if (rest === "manifest.json") return sendJson(res, 200, MANIFEST);

    let m = /^subtitles\/[^/]+\/[^/]+?(?:\/([^/]+))?\.json$/.exec(rest);
    if (m) {
        const extra = {};
        (decodeURIComponent(m[1] || "")).split("&").forEach((kv) => { const i = kv.indexOf("="); if (i > 0) extra[kv.slice(0, i)] = kv.slice(i + 1); });
        const c = findConverted(extra);
        if (!c) return sendJson(res, 200, { subtitles: [] });
        extractAllSubs(c.key);
        const base = baseUrl(req);
        const subtitles = c.info.subs.map((s) => ({
            id: "tvt-" + c.key + "-" + s.index,
            url: base + "/sub/" + c.key.replace("/", "-") + "-" + s.index + ".srt",
            lang: (s.tags && s.tags.language) || "und"
        }));
        log("subtitles for " + c.key + ": " + subtitles.length + " tracks (extra " + JSON.stringify(extra) + ")");
        return sendJson(res, 200, { subtitles, cacheMaxAge: 0 });
    }

    m = /^sub\/([0-9a-f]{40})-(\d+)-(\d+)\.srt$/i.exec(rest);
    if (m) {
        const key = m[1].toLowerCase() + "/" + m[2];
        const file = subFile(key, m[3]);
        const send = () => {
            fs.readFile(file, (err, data) => {
                if (err) { res.writeHead(404, { "Access-Control-Allow-Origin": "*" }); return res.end(); }
                res.writeHead(200, { "Content-Type": "application/x-subrip; charset=utf-8", "Access-Control-Allow-Origin": "*" });
                res.end(data);
            });
        };
        if (fs.existsSync(file)) return send();
        // Still extracting: wait (the torrent downloads fast).
        const job = extractAllSubs(key);
        const timer = setTimeout(send, 120000);
        return job.then(() => { clearTimeout(timer); send(); });
    }
    res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
    res.end();
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
        remember(key, engine, fileIdx, fileName, info, inputUrl);
        serve(req, res, key, inputUrl, info);
    }).catch((e) => { log("error " + key + ": " + e.message); cb(false); });
}

module.exports = { maybeHandle, handleRoute };
