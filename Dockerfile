# ============================================
# Stage 1: Install dependencies
# ============================================
FROM node:20-alpine AS deps

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# ============================================
# Stage 2: Final image
# ============================================
FROM node:20-alpine

RUN apk add --no-cache \
    ca-certificates \
    && rm -rf /var/cache/apk/*

# Create non-root user
RUN adduser -D pptruser

WORKDIR /app

# Copy node_modules from deps stage
COPY --from=deps --chown=pptruser:pptruser /app/node_modules ./node_modules

# Copy runtime source code
COPY --chown=pptruser:pptruser package.json server.js ./
COPY --chown=pptruser:pptruser lib ./lib
COPY --chown=pptruser:pptruser public ./public

USER pptruser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]