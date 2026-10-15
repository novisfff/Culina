FROM golang:1.21.13-alpine AS build

ARG GOPROXY=https://proxy.golang.org,direct

# RELEASE.2023-11-06T22-26-08Z, matching the existing deployed server version.
# Build the immutable official source because the public images are unavailable.
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    GOPROXY="${GOPROXY}" CGO_ENABLED=0 GOBIN=/out go install -p 2 github.com/minio/minio@754f7a8a395e87a744050476d8b16c16af50a800 \
    && cp /go/pkg/mod/github.com/minio/minio@*/LICENSE /out/LICENSE

FROM alpine:3.20

RUN apk add --no-cache ca-certificates

COPY --from=build /out/minio /usr/local/bin/minio
COPY --from=build /out/LICENSE /licenses/minio/LICENSE

EXPOSE 9000 9001

ENTRYPOINT ["minio"]
