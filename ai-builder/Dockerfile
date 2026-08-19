FROM node:22-alpine

# No npm dependencies at all - RCON, the web panel and the OpenAI-compatible
# HTTP calls are implemented directly. Nothing to audit, nothing to patch.
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY test ./test
COPY public ./public

# World-readable so the container can run as ANY uid. compose sets the uid to
# match the owner of the mounted state directory (see PUID/PGID) - if it
# doesn't match, state writes fail with EACCES and undo silently stops working
# across restarts.
RUN mkdir -p /state && chmod -R a+rX /app && chmod 777 /state

ENV NODE_ENV=production
CMD ["node", "src/index.js"]
