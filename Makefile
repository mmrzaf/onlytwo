.PHONY: dev server client build test test-go test-client fmt clean

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

fmt:
	gofmt -w cmd internal static.go
	cd client && npm run format

clean:
	rm -rf client/dist onlytwo-server coverage
