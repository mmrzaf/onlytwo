package config

import (
	"os"
	"strconv"
	"time"
)

type Config struct {
	Port            string
	SessionTTL      int64
	CleanupInterval time.Duration
}

func Load() Config {
	cfg := Config{
		Port:            ":8080",
		SessionTTL:      24 * 60 * 60,
		CleanupInterval: 5 * time.Minute,
	}

	if v := os.Getenv("PORT"); v != "" {
		cfg.Port = ":" + v
	}

	if v := os.Getenv("SESSION_TTL"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			cfg.SessionTTL = n
		}
	}

	return cfg
}
