FROM node:20-slim

# Install ffmpeg, Python and yt-dlp from Debian repos
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg python3 yt-dlp && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --only=production

COPY . .

RUN mkdir -p server/downloads

ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000

CMD ["node", "index.js"]