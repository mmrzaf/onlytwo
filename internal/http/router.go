package http

import (
	"net/http"

	onlytwo "github.com/mmrzaf/onlytwo"
	"github.com/mmrzaf/onlytwo/internal/config"
	"github.com/mmrzaf/onlytwo/internal/ws"
)

func NewRouter(hub *ws.Hub, cfg config.Config) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", HealthHandler)
	mux.Handle("/ws", ws.NewHandler(hub))
	mux.Handle("/api/rooms", RoomsHandler(hub))
	mux.Handle("/api/rooms/", RoomsHandler(hub))
	mux.Handle("/", onlytwo.NewStaticHandler())
	return securityHeaders(cfg, mux)
}

func securityHeaders(cfg config.Config, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "microphone=(self)")
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		if cfg.ContentSecurityPolicy != "" {
			w.Header().Set("Content-Security-Policy", cfg.ContentSecurityPolicy)
		}
		next.ServeHTTP(w, r)
	})
}
