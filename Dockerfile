# ============================================
# Stage 1: Install dependencies
# ============================================
FROM node:20-alpine AS deps

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

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

# Copy source code
COPY --chown=pptruser:pptruser . .

USER pptruser

EXPOSE 3000

CMD ["node", "server.js"]