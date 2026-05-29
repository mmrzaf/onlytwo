package config

import (
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Addr                  string
	AllowedOrigins        []string
	SessionTTL            time.Duration
	MaxFrameBytes         int64
	SendBufferSize        int
	RateLimitPerMinute    int
	MaxSessionsPerIP      int
	MaxConnectionsPerIP   int
	WriteWait             time.Duration
	PongWait              time.Duration
	ContentSecurityPolicy string
}

func FromEnv() Config {
	return Config{
		Addr:                envString("ONLYTWO_ADDR", ":8080"),
		AllowedOrigins:      envList("ONLYTWO_ALLOWED_ORIGINS", nil),
		SessionTTL:          time.Duration(envInt("ONLYTWO_SESSION_TTL_SECONDS", 3600)) * time.Second,
		MaxFrameBytes:       int64(envInt("ONLYTWO_MAX_FRAME_BYTES", 256*1024)),
		SendBufferSize:      envInt("ONLYTWO_SEND_BUFFER_SIZE", 128),
		RateLimitPerMinute:  envInt("ONLYTWO_RATE_LIMIT_PER_MINUTE", 600),
		MaxSessionsPerIP:    envInt("ONLYTWO_MAX_SESSIONS_PER_IP", 64),
		MaxConnectionsPerIP: envInt("ONLYTWO_MAX_CONNECTIONS_PER_IP", 128),
		WriteWait:           time.Duration(envInt("ONLYTWO_WRITE_WAIT_SECONDS", 10)) * time.Second,
		PongWait:            time.Duration(envInt("ONLYTWO_PONG_WAIT_SECONDS", 60)) * time.Second,
		ContentSecurityPolicy: envString("ONLYTWO_CSP", strings.Join([]string{
			"default-src 'self'",
			"script-src 'self' blob:",
			"script-src-elem 'self' blob:",
			"worker-src 'self' blob:",
			"connect-src 'self' ws: wss:",
			"img-src 'self' blob: data:",
			"media-src 'self' blob:",
			"style-src 'self' 'unsafe-inline'",
			"object-src 'none'",
			"base-uri 'none'",
			"frame-ancestors 'none'",
			"form-action 'none'",
		}, "; ")),
	}
}

func envString(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(v)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func envList(key string, fallback []string) []string {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return fallback
	}
	return out
}
