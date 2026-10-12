package remotewrite

import (
	"errors"
	"github.com/golang/snappy"
	"github.com/prometheus/prometheus/prompb"
	"testing"
)

func sampleRequest() *prompb.WriteRequest {
	return &prompb.WriteRequest{Timeseries: []prompb.TimeSeries{{Labels: []prompb.Label{{Name: "__name__", Value: "test_metric"}, {Name: "job", Value: "node"}}, Samples: []prompb.Sample{{Value: 1, Timestamp: 1720000000000}}}}}
}

// Detects accepting corrupt input or allocating an unbounded Snappy expansion.
func TestCodecRoundtrip(t *testing.T) {
	b, err := Encode(sampleRequest())
	if err != nil {
		t.Fatal(err)
	}
	r, err := Decode(b, 4096)
	if err != nil || len(r.Timeseries) != 1 || r.Timeseries[0].Samples[0].Value != 1 {
		t.Fatalf("roundtrip: %v", err)
	}
}
func TestCodecMalformed(t *testing.T) {
	for _, b := range [][]byte{[]byte("not-snappy"), snappy.Encode(nil, []byte{0xff}), snappy.Encode(nil, nil)} {
		if _, err := Decode(b, 4096); !errors.Is(err, ErrInvalidPayload) {
			t.Fatalf("want invalid payload got %v", err)
		}
	}
}
func TestCodecSizeBeforeDecode(t *testing.T) {
	b := snappy.Encode(nil, make([]byte, 8192))
	if _, err := Decode(b, 4096); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("decoded limit: %v", err)
	}
	if _, err := Decode(make([]byte, 4097), 4096); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("compressed limit: %v", err)
	}
}
func FuzzDecode(f *testing.F) {
	f.Add([]byte("invalid"))
	b, _ := sampleRequest().Marshal()
	f.Add(snappy.Encode(nil, b))
	f.Fuzz(func(t *testing.T, b []byte) { _, _ = Decode(b, 65536) })
}
