FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=9595 \
    DATA_DIR=/data

WORKDIR /app

# dépendances (ws + three.js r128, servi localement : pas de CDN nécessaire)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server.js ./
COPY public ./public

# dossier des records, accessible en écriture par l'utilisateur non-root « node »
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 9595
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9595)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
