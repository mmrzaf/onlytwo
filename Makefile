.PHONY: all build client server test clean fmt lint dev docker-build docker-run help


GO            := go
CLIENT_DIR    := client
BINARY_NAME   := onlytwo-server
BUILD_DIR     := bin
GOFLAGS       ?=
NPM           := cd $(CLIENT_DIR) && npm


all: build


client:
	#@echo "==> Installing client dependencies..."
	#$(NPM) install
	@echo "==> Building client assets..."
	$(NPM) run build

server: client
	@echo "==> Building Go server..."
	@mkdir -p $(BUILD_DIR)
	$(GO) build $(GOFLAGS) -o $(BUILD_DIR)/$(BINARY_NAME) ./cmd/onlytwo-server

build: server

test:
	$(GO) test ./...

fmt:
	$(GO) fmt ./...

lint:
	@command -v golangci-lint >/dev/null 2>&1 || { echo "golangci-lint not found, skipping lint"; exit 1; }
	golangci-lint run

dev: client
	@echo "==> Starting development server..."
	$(GO) run ./cmd/onlytwo-server

clean:
	rm -rf $(BUILD_DIR)
	rm -rf $(CLIENT_DIR)/dist
	rm -rf $(CLIENT_DIR)/node_modules

docker-build:
	docker build -t onlytwo:latest .

docker-run:
	docker run --rm -p 8080:8080 onlytwo:latest

.PHONY: test
test: test-go test-client

.PHONY: test-go
test-go:
	go test -race -cover ./...

.PHONY: test-client
test-client:
	cd client && npm run test

.PHONY: test-watch
test-watch:
	cd client && npm run test:watch

help:
	@echo "OnlyTwo Makefile"
	@echo ""
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@echo "  all          Build the server binary (default)"
	@echo "  build        Build the server binary (same as 'all')"
	@echo "  client       Build the client assets (TypeScript → dist)"
	@echo "  server       Build the Go server (depends on client)"
	@echo "  test         Run Go unit tests"
	@echo "  fmt          Format Go source files"
	@echo "  lint         Run golangci-lint (requires installation)"
	@echo "  dev          Build client and start server with 'go run'"
	@echo "  clean        Remove build artifacts and node_modules"
	@echo "  docker-build Build Docker image (requires a Dockerfile)"
	@echo "  docker-run   Run the Docker container"
	@echo "  test              Run all tests"
	@echo "  test-go           Run Go tests"
	@echo "  test-client       Run client tests"
	@echo "  test-watch        Run client tests in watch mode"
