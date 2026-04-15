set shell := ["bash", "-cu"]


dev:
    cd client && npm run build && cd ..
    go run ./cmd/onlytwo-server

run *args:
    go run ./cmd/onlytwo {{args}}


build:
    mkdir -p bin
    go build -o bin/onlytwo-server ./cmd/onlytwo-server

test:
    go test ./...

fmt:
    gofmt -w .

lint:
    golangci-lint run
