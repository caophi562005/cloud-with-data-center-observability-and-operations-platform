package remotewrite

import (
	"bytes"
	"errors"
	"github.com/golang/snappy"
	"github.com/prometheus/prometheus/prompb"
	"google.golang.org/protobuf/encoding/protowire"
	"testing"
)

func wireMessageField(field protowire.Number, body []byte) []byte {
	return protowire.AppendBytes(protowire.AppendTag(nil, field, protowire.BytesType), body)
}
func TestPreflightBoundsNestedRecordsAndHistogramBuckets(t *testing.T) {
	for _, wire := range [][]byte{
		bytes.Repeat([]byte{0x1a, 0x00}, maxMessages+1),                                                     // metadata
		wireMessageField(1, bytes.Repeat([]byte{0x12, 0x00}, maxMessages)),                                  // samples
		wireMessageField(1, bytes.Repeat([]byte{0x1a, 0x00}, maxMessages)),                                  // exemplars
		wireMessageField(1, bytes.Repeat([]byte{0x22, 0x00}, maxMessages)),                                  // histograms
		wireMessageField(1, wireMessageField(4, bytes.Repeat([]byte{0x42, 0x00}, maxMessages))),             // spans
		wireMessageField(1, wireMessageField(4, wireMessageField(9, make([]byte, maxScalarFields+1)))),      // packed buckets
		wireMessageField(1, wireMessageField(4, wireMessageField(10, make([]byte, 8*(maxScalarFields+1))))), // packed fixed64 buckets
	} {
		if err := preflight(wire); !errors.Is(err, ErrTooLarge) {
			t.Fatalf("nested budget bypassed: %v", err)
		}
	}
}
func TestMetadataHistogramAndExemplarRoundtrip(t *testing.T) {
	r := sampleRequest()
	r.Metadata = []prompb.MetricMetadata{{MetricFamilyName: "test_metric", Help: "test help"}}
	r.Timeseries[0].Histograms = []prompb.Histogram{{Timestamp: 1720000000000, PositiveSpans: []prompb.BucketSpan{{Offset: 0, Length: 1}}, PositiveDeltas: []int64{1}}}
	r.Timeseries[0].Exemplars = []prompb.Exemplar{{Labels: []prompb.Label{{Name: "trace_id", Value: "safe"}}, Value: 1, Timestamp: 1720000000000}}
	b, err := Encode(r)
	if err != nil {
		t.Fatal(err)
	}
	out, err := Decode(b, 4096)
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Metadata) != 1 || len(out.Timeseries[0].Histograms) != 1 || len(out.Timeseries[0].Exemplars) != 1 {
		t.Fatal("official protobuf data lost")
	}
}

// A byte cap alone permits millions of tiny repeated protobuf messages to allocate GiB.
func TestDecodeRejectsRepeatedMessageAmplification(t *testing.T) {
	for _, wire := range [][]byte{
		bytes.Repeat([]byte{0x0a, 0x00}, 10001),
		append([]byte{0x0a, 0xca, 0x01}, bytes.Repeat([]byte{0x0a, 0x00}, 101)...),
	} {
		if _, err := Decode(snappy.Encode(nil, wire), 1<<20); !errors.Is(err, ErrTooLarge) {
			t.Fatalf("protobuf amplification not rejected before allocation: %v", err)
		}
	}
}
