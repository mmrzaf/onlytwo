set shell := ["bash", "-cu"]

# Build client then start server in dev mode
dev:
    cd client && npm run build && cd ..
    go run ./cmd/onlytwo-server

# Build client only
build-client:
    cd client && npm install && npm run build

# Build server binary
build:
    mkdir -p bin
    go build -o bin/onlytwo-server ./cmd/onlytwo-server

# Build both client and server
build-all: build-client build

# Run tests
test:
    go test ./...

# Format Go code
fmt:
    gofmt -w .

# Run linter
lint:
    golangci-lint run

# Download Go dependencies
tidy:
    go mod tidy
