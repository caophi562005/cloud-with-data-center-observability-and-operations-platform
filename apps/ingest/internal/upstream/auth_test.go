package upstream

import (
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func TestParseMode(t *testing.T) {
	for _, tc := range []struct {
		name, raw string
		want      Mode
		invalid   bool
	}{
		{"absent", "", ModeBasic, false},
		{"blank", " \t\r\n", ModeBasic, false},
		{"none", "none", ModeNone, false},
		{"basic", "basic", ModeBasic, false},
		{"bearer", "bearer", ModeBearer, false},
		{"normalized", " \tBeArEr\n", ModeBearer, false},
		{"unicode surrounding whitespace", "\u2003BASIC\u2003", ModeBasic, false},
		{"unknown secret", "SECRET_MARKER_unknown", "", true},
		{"internal whitespace", "ba sic", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseMode(tc.raw)
			if tc.invalid {
				assertValidationError(t, err, "mode")
				if got != "" {
					t.Fatal("invalid mode returned usable selection")
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("mode = %q, err = %v; want %q", got, err, tc.want)
			}
		})
	}
}

func TestNewAuthSelectedCredentials(t *testing.T) {
	for _, tc := range []struct {
		name            string
		mode            Mode
		username, token string
		field           string
	}{
		{"none discards invalid credentials", ModeNone, "SECRET_MARKER:\x00", "SECRET_MARKER\r\n", ""},
		{"basic", ModeBasic, "user", "pass", ""},
		{"basic preserves spaces", ModeBasic, " user ", " pass ", ""},
		{"basic unicode bytes", ModeBasic, "用户", "päss 密码", ""},
		{"basic token colon", ModeBasic, "user", "pass:word", ""},
		{"basic empty username", ModeBasic, "", "pass", "username"},
		{"basic blank username", ModeBasic, " \u2003 ", "pass", "username"},
		{"basic username colon", ModeBasic, "SECRET_MARKER:user", "pass", "username"},
		{"basic empty token", ModeBasic, "user", "", "token"},
		{"basic blank token", ModeBasic, "user", " \u2003 ", "token"},
		{"bearer discards invalid username", ModeBearer, "SECRET_MARKER:\r\n", "abc.DEF_-/+=~", ""},
		{"bearer empty token", ModeBearer, "", "", "token"},
		{"bearer blank token", ModeBearer, "", " ", "token"},
		{"bearer leading space", ModeBearer, "", " SECRET_MARKER", "token"},
		{"bearer trailing space", ModeBearer, "", "SECRET_MARKER ", "token"},
		{"bearer interior space", ModeBearer, "", "SECRET_MARKER word", "token"},
		{"bearer unicode", ModeBearer, "", "SECRET_MARKERé", "token"},
		{"bearer unicode whitespace", ModeBearer, "", "SECRET_MARKER\u2003", "token"},
		{"unknown", Mode("SECRET_MARKER_unknown"), "user", "pass", "mode"},
		{"zero mode", "", "user", "pass", "mode"},
		{"constructor does not normalize", Mode(" BASIC "), "user", "pass", "mode"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, err := NewAuth(tc.mode, tc.username, tc.token)
			if tc.field != "" {
				assertValidationError(t, err, tc.field)
				if a != (Auth{}) {
					t.Fatal("failed construction retained credentials or mode")
				}
				return
			}
			if err != nil || a.Mode() != tc.mode {
				t.Fatalf("construction failed: %v", err)
			}
			switch tc.mode {
			case ModeNone:
				if a.username != "" || a.token != "" {
					t.Fatal("none retained irrelevant credentials")
				}
			case ModeBasic:
				if a.username != tc.username || a.token != tc.token {
					t.Fatal("basic credential bytes altered")
				}
			case ModeBearer:
				if a.username != "" || a.token != tc.token {
					t.Fatal("bearer retained username or altered token")
				}
			}
		})
	}
}

func TestCredentialCharacterBoundaries(t *testing.T) {
	// Every ASCII control, including DEL, must fail in each used credential.
	for b := 0; b <= 127; b++ {
		if b >= 32 && b != 127 {
			continue
		}
		for _, field := range []string{"basic username", "basic token", "bearer token"} {
			t.Run(fmt.Sprintf("%s/%02x", field, b), func(t *testing.T) {
				mode, username, token, wantField := ModeBasic, "user", "pass", "token"
				bad := "SECRET_MARKER" + string(rune(b))
				switch field {
				case "basic username":
					username, wantField = bad, "username"
				case "basic token":
					token = bad
				case "bearer token":
					mode, token = ModeBearer, bad
				}
				_, err := NewAuth(mode, username, token)
				assertValidationError(t, err, wantField)
			})
		}
	}
	t.Run("bearer all printable nonwhitespace ASCII", func(t *testing.T) {
		var token strings.Builder
		for b := 33; b <= 126; b++ {
			token.WriteByte(byte(b))
		}
		a, err := NewAuth(ModeBearer, "", token.String())
		if err != nil || a.token != token.String() {
			t.Fatalf("printable ASCII rejected or changed: %v", err)
		}
	})
	t.Run("bearer non ASCII byte", func(t *testing.T) {
		_, err := NewAuth(ModeBearer, "", "SECRET_MARKER\xff")
		assertValidationError(t, err, "token")
	})
	t.Run("basic non UTF8 password bytes", func(t *testing.T) {
		a, err := NewAuth(ModeBasic, "user", "pass\xff")
		if err != nil {
			t.Fatal(err)
		}
		req := newTestRequest(t)
		if err := a.Apply(req); err != nil {
			t.Fatal(err)
		}
		user, password, ok := req.BasicAuth()
		if !ok || user != "user" || password != "pass\xff" {
			t.Fatal("basic non UTF8 bytes not preserved")
		}
	})
}

func TestApplyReplacesAuthorization(t *testing.T) {
	for _, tc := range []struct {
		name            string
		mode            Mode
		username, token string
		want            string
	}{
		{"none", ModeNone, "unused:bad", "unused\r\nsecret", ""},
		{"basic", ModeBasic, "user", "pass", "Basic dXNlcjpwYXNz"},
		{"basic spaces", ModeBasic, " user ", " pass ", "Basic IHVzZXIgOiBwYXNzIA=="},
		{"bearer", ModeBearer, "unused:bad\r\n", "abc.DEF_-/+=~", "Bearer abc.DEF_-/+=~"},
	} {
		for _, nilHeader := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/nilHeader=%t", tc.name, nilHeader), func(t *testing.T) {
				req := newTestRequest(t)
				if nilHeader {
					req.Header = nil
				} else {
					req.Header = http.Header{
						"Authorization": {"Bearer stale-secret", "Basic stale"},
						"authorization": {"lowercase stale"},
						"aUtHoRiZaTiOn": {"mixed stale"},
						"X-Unrelated":   {"first", "second"},
						"x-other":       {"unchanged"},
					}
				}
				a, err := NewAuth(tc.mode, tc.username, tc.token)
				if err != nil {
					t.Fatal(err)
				}
				for i := 0; i < 2; i++ {
					if err := a.Apply(req); err != nil {
						t.Fatal(err)
					}
					authKeys := 0
					for key, values := range req.Header {
						if strings.EqualFold(key, "Authorization") {
							authKeys++
							if key != "Authorization" || len(values) != 1 || values[0] != tc.want {
								t.Fatal("authorization was not canonically replaced")
							}
						}
					}
					wantKeys := 1
					if tc.mode == ModeNone {
						wantKeys = 0
					}
					if authKeys != wantKeys {
						t.Fatalf("authorization key count = %d; want %d", authKeys, wantKeys)
					}
					wantHeader := http.Header{}
					if !nilHeader {
						wantHeader["X-Unrelated"] = []string{"first", "second"}
						wantHeader["x-other"] = []string{"unchanged"}
					}
					if wantKeys == 1 {
						wantHeader["Authorization"] = []string{tc.want}
					}
					if len(req.Header) != len(wantHeader) {
						t.Fatal("unexpected header added or removed")
					}
					for key, values := range wantHeader {
						if !reflect.DeepEqual(req.Header[key], values) {
							t.Fatal("header values changed unexpectedly")
						}
					}
				}
			})
		}
	}
	t.Run("basic unicode password", func(t *testing.T) {
		a, err := NewAuth(ModeBasic, "用户", " päss 密码 ")
		if err != nil {
			t.Fatal(err)
		}
		req := newTestRequest(t)
		if err := a.Apply(req); err != nil {
			t.Fatal(err)
		}
		username, password, ok := req.BasicAuth()
		if !ok || username != "用户" || password != " päss 密码 " {
			t.Fatal("basic unicode credential bytes changed")
		}
	})
}

func TestAuthZeroValueFailsClosed(t *testing.T) {
	for _, tc := range []struct {
		name  string
		auth  Auth
		field string
	}{
		{"zero", Auth{}, "mode"},
		{"unknown", Auth{mode: Mode("SECRET_MARKER_unknown")}, "mode"},
		{"invalid basic username", Auth{mode: ModeBasic, username: "SECRET_MARKER:user", token: "pass"}, "username"},
		{"missing basic token", Auth{mode: ModeBasic, username: "user"}, "token"},
		{"invalid bearer", Auth{mode: ModeBearer, token: "SECRET_MARKER\r\n"}, "token"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := newTestRequest(t)
			req.Header.Set("Authorization", "Bearer stale-secret")
			before := req.Header.Clone()
			err := tc.auth.Apply(req)
			assertValidationError(t, err, tc.field)
			if !reflect.DeepEqual(req.Header, before) {
				t.Fatal("invalid auth mutated request instead of failing closed")
			}
		})
	}
	if (Auth{}).Mode() != "" {
		t.Fatal("zero Auth became a usable default")
	}
}

func TestApplyNilRequest(t *testing.T) {
	for _, mode := range []Mode{ModeNone, ModeBasic, ModeBearer} {
		t.Run(string(mode), func(t *testing.T) {
			a, err := NewAuth(mode, "user", "pass")
			if err != nil {
				t.Fatal(err)
			}
			err = a.Apply(nil)
			if err == nil || err.Error() == "" || strings.Contains(err.Error(), "pass") {
				t.Fatal("nil request must return a fixed nonsecret error")
			}
			if again := a.Apply(nil); again == nil || again.Error() != err.Error() {
				t.Fatal("nil request error is not fixed")
			}
		})
	}
}

func assertValidationError(t *testing.T, err error, field string) {
	t.Helper()
	var validation *ValidationError
	if !errors.As(err, &validation) || validation == nil || validation.Field != field {
		t.Fatalf("expected validation error for %s, got %v", field, err)
	}
	if err.Error() == "" || !strings.Contains(err.Error(), field) || strings.Contains(err.Error(), "SECRET_MARKER") {
		t.Fatal("validation error lacks field/reason or reveals invalid input")
	}
	if !reflect.DeepEqual(validation, &ValidationError{Field: field}) || err.Error() != (&ValidationError{Field: field}).Error() {
		t.Fatal("validation error retained raw input or used a variable reason")
	}
}

func newTestRequest(t *testing.T) *http.Request {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, "http://127.0.0.1/query", nil)
	if err != nil {
		t.Fatal(err)
	}
	return req
}
