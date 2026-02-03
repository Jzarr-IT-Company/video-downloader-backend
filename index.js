const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/downloads', express.static(path.join(__dirname, 'downloads')));

// Ensure downloads directory exists
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}

app.post('/download', (req, res) => {
  const { videoUrl, format, quality } = req.body;
  if (!videoUrl || typeof videoUrl !== "string") {
    return res.status(400).send({ error: "Invalid or missing videoUrl" });
  }
  if (!["audio", "video"].includes(format)) {
    return res.status(400).send({ error: "Invalid format" });
  }

  // Validate quality if provided
  const allowedQualities = ["480p", "720p", "1080p", "max1080p"];
  let selectedQuality = null;
  if (quality) {
    if (!allowedQualities.includes(quality)) {
      return res.status(400).send({ error: "Invalid quality" });
    }
    selectedQuality = quality;
  }

  const isAudio = format === 'audio';
  const timestamp = Date.now();
  const ext = isAudio ? 'mp3' : 'mp4';
  const output = `downloads/video_${timestamp}.${ext}`;

  let options = '';
  if (isAudio) {
    options = '--extract-audio --audio-format mp3';
  } else {
    let formatString = '';
    if (selectedQuality === "480p") {
      formatString = 'bestvideo[height<=480]+bestaudio/best[height<=480]';
    } else if (selectedQuality === "720p") {
      formatString = 'bestvideo[height<=720]+bestaudio/best[height<=720]';
    } else if (selectedQuality === "1080p" || selectedQuality === "max1080p") {
      formatString = 'bestvideo[height<=1080]+bestaudio/best[height<=1080]';
    } else {
      formatString = 'bestvideo+bestaudio/best';
    }
    options = `--format "${formatString}" --merge-output-format mp4`;
  }

  const ytDlp = 'yt-dlp';
  const ffmpeg = 'ffmpeg';

  const cookies = '--cookies cookies.txt';
  const jsRuntime = '--js-runtime node';
  const command = `${ytDlp} --ffmpeg-location ${ffmpeg} ${options} ${cookies} ${jsRuntime} -o "${output}" "${videoUrl}"`;

  exec(command, (err, stdout, stderr) => {
    console.log('yt-dlp stdout:', stdout);
    console.log('yt-dlp stderr:', stderr);
    if (err) {
      console.error('yt-dlp error:', err);
      return res.status(500).send({ error: 'Download failed', details: stderr });
    }

    // List files in downloads folder for debugging
    fs.readdir(path.join(__dirname, 'downloads'), (err, files) => {
      if (err) {
        console.error('Error reading downloads folder:', err);
      } else {
        console.log('Files in downloads:', files);
      }
    });

    // Check if file exists
    console.log('Output filePath:', output);
    if (!fs.existsSync(output)) {
      return res.status(500).send({ error: 'File not found after download' });
    }

    // Return the file path for download
    const file = `/downloads/${path.basename(output)}`;
    res.send({ file });
  });
});

app.get('/force-download/:filename', (req, res) => {
  const filename = path.basename(req.params.filename); // Prevent directory traversal
  const filePath = path.join(__dirname, 'downloads', filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }
  res.download(filePath);
});

app.listen(5000, () => console.log('🚀 Server running on http://localhost:5000'));
