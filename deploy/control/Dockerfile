FROM node:24.21.0-bookworm-slim AS web
WORKDIR /source
COPY package.json package-lock.json ./
COPY packages/cli/package.json packages/cli/package.json
COPY packages/control-ui packages/control-ui
COPY packages/protocol packages/protocol
COPY apps/home/package.json apps/home/package.json
COPY apps/console apps/console
COPY apps/admin apps/admin
RUN npm ci --ignore-scripts && npm run build:control

FROM golang:1.26.10-bookworm AS api
WORKDIR /source
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server .
RUN CGO_ENABLED=0 go build -p 1 -tags=nomsgpack -trimpath -o /output/limeiot-control ./cmd/api && \
    CGO_ENABLED=0 go build -p 1 -tags=nomsgpack -trimpath -o /output/limeiot-migrate ./cmd/migrate

FROM rust:1.93.1-bookworm AS validator
WORKDIR /source
COPY Cargo.toml Cargo.lock ./
COPY gateway gateway
COPY tools/simulator tools/simulator
COPY tools/model-validator tools/model-validator
COPY contracts contracts
RUN cargo build -j 1 --release --locked -p limeiot-model-validator

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/limeiot
COPY --from=api /output/ /usr/local/bin/
COPY --from=validator /source/target/release/limeiot-model-validator /usr/local/bin/limeiot-model-validator
COPY --from=web /source/apps/console/dist web/console
COPY --from=web /source/apps/admin/dist web/admin
COPY LICENSE ./LICENSE
ENV PORT=8080 LIMEIOT_CONSOLE_WEB_DIR=/opt/limeiot/web/console LIMEIOT_ADMIN_WEB_DIR=/opt/limeiot/web/admin
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["limeiot-control"]
