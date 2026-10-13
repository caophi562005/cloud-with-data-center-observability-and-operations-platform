package remotewrite

import "google.golang.org/protobuf/encoding/protowire"

// Allocation guard, NOT a second protobuf codec. Field numbers follow upstream
// prompb/remote.proto and types.proto; the official decoder still validates data.
// Byte caps alone cannot bound Go slices for millions of tiny repeated messages.
const (
	maxSeries       = 10000
	maxLabels       = 100
	maxMessages     = 200000
	maxScalarFields = 1000000
)

type messageKind uint8

const (
	writeMessage messageKind = iota
	seriesMessage
	exemplarMessage
	histogramMessage
	leafMessage
)

type wireBudget struct{ messages, scalars int }

func preflight(body []byte) error { return (&wireBudget{}).scan(body, writeMessage) }
func (b *wireBudget) scan(body []byte, kind messageKind) error {
	series, labels := 0, 0
	for len(body) > 0 {
		field, typ, n := protowire.ConsumeTag(body)
		if n < 0 {
			return ErrInvalidPayload
		}
		body = body[n:]
		b.scalars++
		if b.scalars > maxScalarFields {
			return ErrTooLarge
		}
		if typ == protowire.StartGroupType || typ == protowire.EndGroupType {
			return ErrInvalidPayload
		} // no groups in Remote Write v1
		if typ != protowire.BytesType {
			n = protowire.ConsumeFieldValue(field, typ, body)
			if n < 0 {
				return ErrInvalidPayload
			}
			body = body[n:]
			continue
		}
		value, n := protowire.ConsumeBytes(body)
		if n < 0 {
			return ErrInvalidPayload
		}
		body = body[n:]
		child, nested := leafMessage, false
		switch kind {
		case writeMessage:
			if field == 1 {
				series++
				if series > maxSeries {
					return ErrTooLarge
				}
				child, nested = seriesMessage, true
			} else if field == 3 {
				nested = true
			}
		case seriesMessage:
			switch field {
			case 1:
				labels++
				if labels > maxLabels {
					return ErrTooLarge
				}
				nested = true
			case 2:
				nested = true
			case 3:
				child, nested = exemplarMessage, true
			case 4:
				child, nested = histogramMessage, true
			}
		case exemplarMessage:
			if field == 1 {
				labels++
				if labels > maxLabels {
					return ErrTooLarge
				}
				nested = true
			}
		case histogramMessage:
			switch field {
			case 8, 11:
				nested = true
			case 9, 12:
				for len(value) > 0 {
					_, k := protowire.ConsumeVarint(value)
					if k < 0 {
						return ErrInvalidPayload
					}
					value = value[k:]
					b.scalars++
					if b.scalars > maxScalarFields {
						return ErrTooLarge
					}
				}
			case 10, 13, 16:
				if len(value)%8 != 0 {
					return ErrInvalidPayload
				}
				b.scalars += len(value) / 8
				if b.scalars > maxScalarFields {
					return ErrTooLarge
				}
			}
		}
		if nested {
			b.messages++
			if b.messages > maxMessages {
				return ErrTooLarge
			}
			if err := b.scan(value, child); err != nil {
				return err
			}
		}
	}
	return nil
}
