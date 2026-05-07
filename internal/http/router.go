package http

import (
	"net/http"

	onlytwo "github.com/mmrzaf/onlytwo"
	"github.com/mmrzaf/onlytwo/internal/config"
	"github.com/mmrzaf/onlytwo/internal/ws"
)

// NewRouter wires up all HTTP/WebSocket routes and wraps them with
// security headers required for the crypto worker's strict isolation.
func NewRouter(hub *ws.Hub, cfg config.Config) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", healthHandler)
	mux.Handle("/ws", ws.NewHandler(hub))
	mux.Handle("/", onlytwo.NewStaticHandler())

	return securityHeaders(mux)
}

// securityHeaders sets the HTTP response headers required by the blueprint:
//   - COOP + COEP enable SharedArrayBuffer and strict worker isolation.
//   - X-Content-Type-Options prevents MIME sniffing.
//   - X-Frame-Options prevents click-jacking.
//   - Referrer-Policy prevents leaking the session URL to third parties.
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Embedder-Policy", "require-corp")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}
