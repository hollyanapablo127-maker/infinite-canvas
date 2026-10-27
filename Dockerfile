ARG NODE_IMAGE=node:20-bookworm-slim
FROM ${NODE_IMAGE}
WORKDIR /app
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources && apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json .npmrc ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build
RUN mkdir -p /app/data && chown node:node /app/data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4010
EXPOSE 4010
USER node
CMD ["npm","start"]
