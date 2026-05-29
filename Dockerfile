FROM node:24 AS client-builder

WORKDIR /src/client

COPY client/package*.json ./
RUN npm ci

COPY client/ ./
RUN npm run build


FROM golang:1.26 AS builder

WORKDIR /src

COPY go.mod ./
RUN GOTOOLCHAIN=local go mod download

COPY . .
COPY --from=client-builder /src/client/dist ./client/dist

RUN CGO_ENABLED=0 GOTOOLCHAIN=local go build \
    -trimpath \
    -ldflags="-s -w" \
    -o /out/onlytwo-server \
    ./cmd/onlytwo-server

FROM scratch

COPY --from=builder /out/onlytwo-server /usr/local/bin/onlytwo-server

USER 1000:1000
WORKDIR /data

ENV TMPDIR=/tmp
ENV ONLYTWO_PORT=8080

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/onlytwo-server"]
