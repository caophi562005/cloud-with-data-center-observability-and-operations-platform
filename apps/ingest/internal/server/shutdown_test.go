package server

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"testing"
	"time"
)

func TestRunGracefullyDrainsInFlightRequest(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(entered); <-release; w.WriteHeader(204) })
	srv := New("127.0.0.1:0", handler, func(context.Context) error { return nil }, logger, time.Second)
	address := make(chan string, 1)
	srv.BaseContext = func(l net.Listener) context.Context { address <- l.Addr().String(); return context.Background() }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	defer once.Do(func() { close(release) })
	t.Cleanup(func() { srv.Close() })
	done := make(chan error, 1)
	go func() { done <- Run(ctx, srv, logger) }()
	var addr string
	select {
	case addr = <-address:
	case err := <-done:
		t.Fatalf("server failed: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatal("no listener")
	}
	client := &http.Client{Timeout: 2 * time.Second}
	defer client.CloseIdleConnections()
	requestDone := make(chan int, 1)
	go func() {
		resp, err := client.Post("http://"+addr+"/api/v1/write", "application/x-protobuf", nil)
		if err != nil {
			requestDone <- 0
			return
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		requestDone <- resp.StatusCode
	}()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("request not admitted")
	}
	cancel()
	select {
	case err := <-done:
		t.Fatalf("shutdown did not drain: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	once.Do(func() { close(release) })
	select {
	case status := <-requestDone:
		if status != 204 {
			t.Fatalf("in-flight response lost: %d", status)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("in-flight request not finished")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("shutdown not finished")
	}
}
