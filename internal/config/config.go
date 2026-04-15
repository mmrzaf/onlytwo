package config

import "os"

type Config struct {
	Port       string
	StaticDir  string
	SessionTTL int64 // seconds
}

func Load() Config {
	port := os.Getenv("ONLYTWO_PORT")
	if port == "" {
		port = "8080"
	}

	staticDir := os.Getenv("ONLYTWO_STATIC_DIR")
	if staticDir == "" {
		staticDir = "client/dist"
	}

	return Config{
		Port:       port,
		StaticDir:  staticDir,
		SessionTTL: 24 * 60 * 60, // 24h
	}
}
