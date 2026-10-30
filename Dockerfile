# RainReady container for the AWS course demo (Amazon ECS Express Mode + Amazon RDS).
# Build on your PC:   docker build -t rainready:latest .
# The image holds no secrets: passwords and keys come from AWS Secrets Manager at run time.
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

# Dependencies first, so code changes do not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY backend ./backend
COPY frontend ./frontend

# Amazon RDS certificate bundle, so the database connection is verified (RAINREADY_DB_SSL=verify-full).
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/certs/rds-global-bundle.pem
RUN chmod 0644 /app/certs/rds-global-bundle.pem \
 && rm -rf /app/backend/data && mkdir -p /app/backend/data && chown node:node /app/backend/data

# Run as the unprivileged "node" user, listening on all addresses inside the container.
USER node
ENV PORT=8787 RAINREADY_HOST=0.0.0.0 RAINREADY_DEPLOYMENT=course-demo RAINREADY_DB_SSL_CA=/app/certs/rds-global-bundle.pem
EXPOSE 8787
CMD ["node", "backend/server.mjs"]
