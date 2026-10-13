// Package remotewrite handles Prometheus Remote Write v1 wire data.
package remotewrite

import (
	"errors"
	"github.com/golang/snappy"
	"github.com/prometheus/prometheus/prompb"
)

var (
	ErrInvalidPayload = errors.New("invalid remote write payload")
	ErrTooLarge       = errors.New("remote write payload too large")
)

// Decode checks BOTH compressed and decoded sizes before Snappy allocates output.
func Decode(body []byte, maxBytes int64) (*prompb.WriteRequest, error) {
	if int64(len(body)) > maxBytes {
		return nil, ErrTooLarge
	}
	size, err := snappy.DecodedLen(body)
	if err != nil {
		return nil, ErrInvalidPayload
	}
	if int64(size) > maxBytes {
		return nil, ErrTooLarge
	}
	decoded, err := snappy.Decode(nil, body)
	if err != nil {
		return nil, ErrInvalidPayload
	}
	if err = preflight(decoded); err != nil {
		return nil, err
	}
	var req prompb.WriteRequest
	if err = req.Unmarshal(decoded); err != nil || len(req.Timeseries) == 0 {
		return nil, ErrInvalidPayload
	}
	return &req, nil
}
func Encode(req *prompb.WriteRequest) ([]byte, error) {
	b, err := req.Marshal()
	if err != nil {
		return nil, ErrInvalidPayload
	}
	return snappy.Encode(nil, b), nil
}
