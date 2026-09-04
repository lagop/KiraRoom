# Production Dockerfile for Kira Studio Backend
FROM node:20-alpine AS builder

# Install dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

# Copy source code
COPY prisma ./prisma/
COPY tsconfig.json ./
COPY src ./src/

# Generate Prisma client
RUN npx prisma generate

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine AS production

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Copy built application
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package*.json ./

# Generate Prisma client in production
RUN npx prisma generate

# Copy the entrypoint that runs `prisma migrate deploy` before the
# application starts (rev 3 deploy safety: see docs/saas-admin-runbook.md §11).
COPY --chown=nodejs:nodejs docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3001

# Expose port
EXPOSE 3001

# Change to non-root user
USER nodejs

# Run migrations then start the app. The entrypoint is the only
# thing that enforces pre-deploy `prisma migrate deploy`.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
