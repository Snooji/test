FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production PORT=2567 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 2567
CMD ["node", "server/index.js"]
