.PHONY: all build serve test clean

all: build

build:
	@chmod +x scripts/build.sh
	@./scripts/build.sh

serve: build
	@chmod +x scripts/serve.sh
	@./scripts/serve.sh 8080

test:
	@go test -v ./...
	@GOOS=js GOARCH=wasm go build -o /dev/null ./cmd/wasm

clean:
	@rm -f web/main.wasm
