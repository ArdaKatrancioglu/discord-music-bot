FROM node:22-bookworm

WORKDIR /app

RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-venv \
    python3-pip \
    build-essential \
    curl \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/yt-dlp \
  && /opt/yt-dlp/bin/pip install --upgrade pip \
  && /opt/yt-dlp/bin/pip install --upgrade yt-dlp bgutil-ytdlp-pot-provider \
  && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp

COPY package*.json ./

RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY . .

CMD ["node", "index.js"]