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

const fileCookiesPath = path.join(__dirname, "cookies.txt");
const runtimeCookiesPath = path.join(__dirname, ".cookies.runtime.txt");
const allowedQualities = new Set(["720p"]);

function bootstrapCookiesFromEnv() {
  const cookiesBase64 = process.env.YTDLP_COOKIES_B64;
  const cookiesRaw = process.env.YTDLP_COOKIES;

  if (!cookiesBase64 && !cookiesRaw) {
    return;
  }

  try {
    const content = cookiesBase64
      ? Buffer.from(cookiesBase64, "base64").toString("utf8")
      : cookiesRaw;

    fs.writeFileSync(runtimeCookiesPath, content, { encoding: "utf8", mode: 0o600 });
    console.log("Runtime cookies file prepared from environment.");
  } catch (err) {
    console.error("Failed to create runtime cookies file:", err.message);
  }
}

function resolveCookiesPath() {
  if (fs.existsSync(runtimeCookiesPath)) {
    return runtimeCookiesPath;
  }
  if (fs.existsSync(fileCookiesPath)) {
    return fileCookiesPath;
  }
  return null;
}

bootstrapCookiesFromEnv();

function normalizeVideoUrl(inputUrl) {
  try {
    const parsed = new URL(inputUrl);
    const host = parsed.hostname.toLowerCase();
    const segments = parsed.pathname.split("/").filter(Boolean);

    // Facebook share links often fail in yt-dlp as-is on hosted runtimes.
    // Convert common share forms to canonical URLs before download.
    if (host.endsWith("facebook.com")) {
      if (segments.length >= 3 && segments[0] === "share" && segments[1] === "v") {
        return `https://www.facebook.com/watch/?v=${encodeURIComponent(segments[2])}`;
      }

      if (segments.length >= 3 && segments[0] === "share" && segments[1] === "r") {
        return `https://www.facebook.com/reel/${encodeURIComponent(segments[2])}`;
      }
    }

    // Normalize x.com links to twitter.com canonical URLs.
    // yt-dlp can handle both, but twitter.com is often more stable.
    if (host === "x.com" || host === "www.x.com") {
      if (segments.length >= 3 && segments[0] === "i" && segments[1] === "status") {
        return `https://twitter.com/i/status/${encodeURIComponent(segments[2])}`;
      }
      return `https://twitter.com${parsed.pathname}${parsed.search}`;
    }
  } catch {
    return inputUrl;
  }

  return inputUrl;
}

function buildVideoUrlCandidates(inputUrl) {
  const candidates = [inputUrl];
  const normalized = normalizeVideoUrl(inputUrl);
  if (normalized !== inputUrl) {
    candidates.push(normalized);
  }
  return candidates;
}

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

function buildYtArgs({ isAudio, quality, outputPath, videoUrl }) {
  const ytArgs = [];

  if (isAudio) {
    ytArgs.push("--extract-audio", "--audio-format", "mp3");
  } else {
    ytArgs.push("--format", buildVideoFormat(quality), "--merge-output-format", "mp4");
  }

  const cookiesPath = resolveCookiesPath();
  if (cookiesPath) {
    ytArgs.push("--cookies", cookiesPath);
  }

  ytArgs.push("-o", outputPath, videoUrl);
  return ytArgs;
}

function runYtDlp(ytArgs) {
  return new Promise((resolve) => {
    const child = spawn("yt-dlp", ytArgs, { shell: false });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, DOWNLOAD_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ code: -1, stdout, stderr, error, timedOut: false });
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        code: typeof code === "number" ? code : 1,
        stdout,
        stderr,
        error: null,
        timedOut,
      });
    });
  });
}

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "video-downloader-api" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/download", async (req, res) => {
  const { videoUrl, format, quality: requestedQuality } = req.body || {};

  if (!videoUrl || typeof videoUrl !== "string") {
    return res.status(400).send({ error: "Invalid or missing videoUrl" });
  }

  const urlCandidates = buildVideoUrlCandidates(videoUrl);
  if (urlCandidates.length > 1) {
    console.log("video URL candidates:", urlCandidates);
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

  if (requestedQuality && !allowedQualities.has(requestedQuality)) {
    return res.status(400).send({ error: "Invalid quality" });
  }

  const isAudio = format === "audio";
  const quality = isAudio ? undefined : "720p";
  const fileExt = isAudio ? "mp3" : "mp4";
  const fileId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const filename = `video_${fileId}.${fileExt}`;
  const outputPath = path.join(downloadsDir, filename);

  let warning;
  let result = null;
  let successfulCandidateUrl = null;
  let lastRequestedFormatUnavailable = false;

  for (const candidateUrl of urlCandidates) {
    result = await runYtDlp(
      buildYtArgs({ isAudio, quality, outputPath, videoUrl: candidateUrl }),
    );

    if (result.error) {
      console.error("yt-dlp spawn error:", result.error.message);
      return res.status(500).send({ error: "Downloader process failed to start" });
    }

    if (result.timedOut) {
      return res.status(504).send({ error: "Download timed out" });
    }

    if (result.code === 0) {
      successfulCandidateUrl = candidateUrl;
      break;
    }

    const stderrText = (result.stderr || "").toLowerCase();
    const requestedFormatUnavailable = stderrText.includes("requested format is not available");
    lastRequestedFormatUnavailable = requestedFormatUnavailable;

    // Some sources don't expose all requested heights.
    // Retry this candidate with best available quality before trying next candidate.
    if (!isAudio && quality && requestedFormatUnavailable) {
      const fallbackResult = await runYtDlp(
        buildYtArgs({ isAudio, quality: undefined, outputPath, videoUrl: candidateUrl }),
      );

      if (fallbackResult.error) {
        console.error("yt-dlp spawn error:", fallbackResult.error.message);
        return res.status(500).send({ error: "Downloader process failed to start" });
      }

      if (fallbackResult.timedOut) {
        return res.status(504).send({ error: "Download timed out" });
      }

      if (fallbackResult.code === 0) {
        warning = `Requested quality (${quality}) is not available for this video. Downloaded best available quality instead.`;
        result = fallbackResult;
        successfulCandidateUrl = candidateUrl;
        break;
      }

      result = fallbackResult;
    }
  }

  if (!result) {
    return res.status(500).send({ error: "Download failed: no downloader result" });
  }

  if (result.code !== 0) {
    const stderrText = (result.stderr || "").toLowerCase();
    const isBotCheck =
      stderrText.includes("sign in to confirm you") &&
      stderrText.includes("not a bot");
    const isDailymotionHostBlocked =
      stderrText.includes("[dailymotion]") &&
      (stderrText.includes("http error 403") ||
        stderrText.includes("forbidden") ||
        stderrText.includes("access denied") ||
        stderrText.includes("unable to download webpage"));
    const isGeoRestricted =
      stderrText.includes("geo restricted") ||
      stderrText.includes("geo-restricted") ||
      stderrText.includes("not available in your country") ||
      stderrText.includes("not available from your location");
    const isExtractorMismatch =
      stderrText.includes("unable to extract") ||
      stderrText.includes("unsupported url") ||
      stderrText.includes("please report this issue");
    const isInstagramRateLimited =
      stderrText.includes("[instagram]") &&
      (stderrText.includes("rate-limit reached") ||
        stderrText.includes("login required") ||
        stderrText.includes("requested content is not available") ||
        stderrText.includes("use --cookies"));

    console.error("yt-dlp error code:", result.code);
    console.error("yt-dlp stderr:", result.stderr);
    console.error("yt-dlp stdout:", result.stdout);

    if (isBotCheck) {
      return res.status(403).send({
        error:
          "YouTube is blocking downloads from this server (bot protection). This may work from your local network but not from this hosting provider.",
        details: result.stderr,
      });
    }

    if (isDailymotionHostBlocked) {
      return res.status(403).send({
        error:
          "Dailymotion is blocking this request from the hosted server IP. This may work locally but fail on cloud hosting.",
        details: result.stderr,
        code: "DAILYMOTION_HOST_BLOCK",
      });
    }

    if (isGeoRestricted) {
      return res.status(451).send({
        error:
          "This video is geo-restricted for the current server location. Try another video or deploy backend in a different region.",
        details: result.stderr,
        code: "GEO_RESTRICTED",
      });
    }

    if (isInstagramRateLimited) {
      return res.status(429).send({
        error:
          "Instagram blocked this request on the hosted server (rate-limit/login required). Configure authenticated cookies for yt-dlp or try again later.",
        details: result.stderr,
        code: "INSTAGRAM_AUTH_REQUIRED",
      });
    }

    if (isExtractorMismatch) {
      return res.status(502).send({
        error:
          "Extractor/runtime mismatch on hosted backend. Update yt-dlp and redeploy backend image.",
        details: result.stderr,
        code: "EXTRACTOR_MISMATCH",
      });
    }

    const details = result.stderr || result.stdout;
    const extraNote =
      lastRequestedFormatUnavailable && quality
        ? ` Requested quality (${quality}) is unavailable.`
        : "";
    return res.status(500).send({
      error: `Download failed.${extraNote}`,
      details,
      triedUrls: urlCandidates,
    });
  }

  if (!fs.existsSync(outputPath)) {
    return res.status(500).send({ error: "File not found after download" });
  }

  if (successfulCandidateUrl && successfulCandidateUrl !== videoUrl) {
    warning = warning || "Original share URL was converted to a canonical URL for download.";
  }

  const file = `/downloads/${path.basename(outputPath)}`;
  scheduleCleanup(outputPath);
  return res.status(200).send({ file, warning });
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
