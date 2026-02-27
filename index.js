const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const cors = require("cors");
const fs = require("fs");

const app = express();

const PORT = Number(process.env.PORT) || 5000;
const DOWNLOAD_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS || 15 * 60 * 1000);
const DOWNLOAD_TTL_MS = Number(process.env.DOWNLOAD_TTL_MS || 60 * 60 * 1000);

const downloadsDir = process.env.DOWNLOADS_DIR
  ? path.resolve(process.env.DOWNLOADS_DIR)
  : process.env.RENDER
    ? "/tmp/downloads"
    : path.join(__dirname, "downloads");

const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors(
    allowedOrigins.length > 0
      ? {
          origin(origin, callback) {
            if (!origin || allowedOrigins.includes(origin)) {
              return callback(null, true);
            }
            return callback(new Error("Not allowed by CORS"));
          },
          methods: ["GET", "POST", "OPTIONS"],
        }
      : {},
  ),
);

app.use(express.json({ limit: "1mb" }));

if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}

app.use("/downloads", express.static(downloadsDir));

const cookiesPath = path.join(__dirname, "cookies.txt");
const allowedQualities = new Set(["480p", "720p", "1080p", "max1080p"]);

function buildVideoFormat(quality) {
  if (quality === "480p") return "bestvideo[height<=480]+bestaudio/best[height<=480]";
  if (quality === "720p") return "bestvideo[height<=720]+bestaudio/best[height<=720]";
  if (quality === "1080p" || quality === "max1080p") {
    return "bestvideo[height<=1080]+bestaudio/best[height<=1080]";
  }
  return "bestvideo+bestaudio/best";
}

function scheduleCleanup(filePath) {
  if (!Number.isFinite(DOWNLOAD_TTL_MS) || DOWNLOAD_TTL_MS <= 0) {
    return;
  }

  const timer = setTimeout(() => {
    fs.unlink(filePath, (err) => {
      if (err && err.code !== "ENOENT") {
        console.error("cleanup error:", err.message);
      }
    });
  }, DOWNLOAD_TTL_MS);

  if (typeof timer.unref === "function") {
    timer.unref();
  }
}

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "video-downloader-api" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/download", (req, res) => {
  const { videoUrl, format, quality } = req.body || {};

  if (!videoUrl || typeof videoUrl !== "string") {
    return res.status(400).send({ error: "Invalid or missing videoUrl" });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(videoUrl);
  } catch {
    return res.status(400).send({ error: "Invalid video URL" });
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return res.status(400).send({ error: "Unsupported video URL protocol" });
  }

  if (!["audio", "video"].includes(format)) {
    return res.status(400).send({ error: "Invalid format" });
  }

  if (quality && !allowedQualities.has(quality)) {
    return res.status(400).send({ error: "Invalid quality" });
  }

  const isAudio = format === "audio";
  const fileExt = isAudio ? "mp3" : "mp4";
  const fileId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const filename = `video_${fileId}.${fileExt}`;
  const outputPath = path.join(downloadsDir, filename);

  const ytArgs = [];
  if (isAudio) {
    ytArgs.push("--extract-audio", "--audio-format", "mp3");
  } else {
    ytArgs.push("--format", buildVideoFormat(quality), "--merge-output-format", "mp4");
  }

  if (fs.existsSync(cookiesPath)) {
    ytArgs.push("--cookies", cookiesPath);
  }

  ytArgs.push("-o", outputPath, videoUrl);

  const child = spawn("yt-dlp", ytArgs, { shell: false });
  let stdout = "";
  let stderr = "";
  let hasResponded = false;

  const replyOnce = (statusCode, payload) => {
    if (hasResponded) return;
    hasResponded = true;
    res.status(statusCode).send(payload);
  };

  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
    replyOnce(504, { error: "Download timed out" });
  }, DOWNLOAD_TIMEOUT_MS);

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  child.on("error", (err) => {
    clearTimeout(timeout);
    console.error("yt-dlp spawn error:", err.message);
    replyOnce(500, { error: "Downloader process failed to start" });
  });

  child.on("close", (code) => {
    clearTimeout(timeout);

    if (code !== 0) {
      const stderrText = stderr.toLowerCase();
      const isBotCheck =
        stderrText.includes("sign in to confirm you") &&
        stderrText.includes("not a bot");

      console.error("yt-dlp error code:", code);
      console.error("yt-dlp stderr:", stderr);
      console.error("yt-dlp stdout:", stdout);

      if (isBotCheck) {
        return replyOnce(403, {
          error:
            "YouTube is blocking downloads from this server (bot protection). This may work from your local network but not from this hosting provider.",
          details: stderr,
        });
      }

      return replyOnce(500, { error: "Download failed", details: stderr || stdout });
    }

    if (!fs.existsSync(outputPath)) {
      return replyOnce(500, { error: "File not found after download" });
    }

    const file = `/downloads/${path.basename(outputPath)}`;
    scheduleCleanup(outputPath);
    return replyOnce(200, { file });
  });
});

app.get("/force-download/:filename", (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(downloadsDir, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("File not found");
  }

  return res.download(filePath);
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
