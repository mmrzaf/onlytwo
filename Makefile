.PHONY: dev server client build test test-go test-client verify fmt clean

dev:
	@echo "Run 'make server' and 'make client' in separate terminals."

server:
	go run ./cmd/onlytwo-server

client:
	cd client && npm run dev

build:
	cd client && npm run build
	go build -o onlytwo-server ./cmd/onlytwo-server

test: test-go test-client

test-go:
	go test ./...

test-client:
	cd client && npm test -- --run

verify:
	cd client && npm ci
	cd client && npm test -- --run
	cd client && npm run build
	go test ./...
	go vet ./...
	go test -race ./internal/session ./internal/http ./internal/ws

fmt:
	gofmt -w cmd internal static.go
	cd client && npm run format

clean:
	rm -rf client/dist onlytwo-server coverage