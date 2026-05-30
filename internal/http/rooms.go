package http

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/mmrzaf/onlytwo/internal/session"
	"github.com/mmrzaf/onlytwo/internal/ws"
)

type createRoomRequest struct {
	ProfileID string `json:"profileId"`
}

func RoomsHandler(hub *ws.Hub) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/rooms":
			createRoom(w, r, hub)
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/rooms/"):
			getRoom(w, r, hub)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
}

func createRoom(w http.ResponseWriter, r *http.Request, hub *ws.Hub) {
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var request createRoomRequest
	if err := decoder.Decode(&request); err != nil {
		http.Error(w, "invalid room request", http.StatusBadRequest)
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		http.Error(w, "invalid room request", http.StatusBadRequest)
		return
	}
	room, err := hub.CreateRoom(request.ProfileID, hub.ClientIP(r))
	if err != nil {
		switch {
		case errors.Is(err, session.ErrInvalidProfile):
			http.Error(w, "invalid transport profile", http.StatusBadRequest)
		case errors.Is(err, session.ErrTooManySessions):
			http.Error(w, "too many active rooms", http.StatusTooManyRequests)
		default:
			http.Error(w, "could not create room", http.StatusInternalServerError)
		}
		return
	}
	writeJSON(w, http.StatusCreated, room)
}

func getRoom(w http.ResponseWriter, r *http.Request, hub *ws.Hub) {
	code := strings.TrimPrefix(r.URL.Path, "/api/rooms/")
	if !session.ValidCode(code) {
		http.Error(w, "invalid room code", http.StatusBadRequest)
		return
	}
	room, ok := hub.RoomInfo(code)
	if !ok {
		http.Error(w, "room not found", http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, room)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
