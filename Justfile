default: dev

dev: build server

server:
    go run ./cmd/onlytwo-server

client:
    cd client && npm run dev

build:
    cd client && npm run build
    go build -o onlytwo-server ./cmd/onlytwo-server

test:
    go test ./...
    cd client && npm test -- --run
verify:
    cd client && npm ci
    cd client && npm test -- --run
    cd client && npm run build
    go test ./...
    go vet ./...
    go test -race ./internal/session ./internal/http ./internal/ws
