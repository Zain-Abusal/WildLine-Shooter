# Realtime multiplayer server only (the static client is served by Vercel).
# Works on any container host with WebSocket support: Render, Railway, Fly.io, etc.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY server ./server
ENV NODE_ENV=production
EXPOSE 8787
CMD ["npm", "run", "multiplayer"]
