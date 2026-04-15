package http

import (
	"net/http"

	"github.com/mmrzaf/onlytwo"
	"github.com/mmrzaf/onlytwo/internal/config"
	"github.com/mmrzaf/onlytwo/internal/ws"
)

func NewRouter(hub *ws.Hub, cfg config.Config) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", healthHandler)

	mux.Handle("/ws", ws.NewHandler(hub))
	fileServer := onlytwo.NewStaticHandler()
	mux.Handle("/", fileServer)

	return mux
}
