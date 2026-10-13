package opsgrid

import (
	"github.com/influxdata/telegraf/config"
	"github.com/influxdata/telegraf/plugins/outputs/heartbeat"
	nativehttp "github.com/influxdata/telegraf/plugins/outputs/http"
)

func secretEquals(secret *config.Secret, expected string) bool {
	if secret == nil {
		return false
	}
	buffer, err := secret.Get()
	if err != nil {
		return false
	}
	defer buffer.Destroy()
	return buffer.TemporaryString() == expected
}

// BindCredential touches only actual native config.Secret fields, never the TOML
// bytes, environment, command arguments, serializer or persistent config mirrors.
func BindCredential(cfg *config.Config, credential []byte) error {
	if cfg == nil || !validToken(string(credential), "AGT_") {
		return failure("CREDENTIAL_BIND_FAILED")
	}
	var httpOutput *nativehttp.HTTP
	var heartbeatOutput *heartbeat.Heartbeat
	for _, output := range cfg.Outputs {
		switch p := output.Output.(type) {
		case *nativehttp.HTTP:
			if httpOutput != nil || !secretEquals(p.Headers["Authorization"], "Bearer "+CredentialMarker) {
				return failure("CREDENTIAL_BIND_FAILED")
			}
			httpOutput = p
		case *heartbeat.Heartbeat:
			if heartbeatOutput != nil || !secretEquals(&p.Token, CredentialMarker) {
				return failure("CREDENTIAL_BIND_FAILED")
			}
			heartbeatOutput = p
		default:
			return failure("CREDENTIAL_BIND_FAILED")
		}
	}
	if httpOutput == nil || heartbeatOutput == nil {
		return failure("CREDENTIAL_BIND_FAILED")
	}
	bearer := append([]byte("Bearer "), credential...)
	defer wipe(bearer)
	httpOutput.Headers["Authorization"].Destroy()
	authorization := config.NewSecret(bearer)
	httpOutput.Headers["Authorization"] = &authorization
	heartbeatOutput.Token.Destroy()
	heartbeatOutput.Token = config.NewSecret(credential)
	return nil
}

func bindIdentity(cfg *config.Config, identity Identity) error {
	if !validIdentity(identity) {
		return failure("IDENTITY_BIND_FAILED")
	}
	for _, output := range cfg.Outputs {
		if p, ok := output.Output.(*heartbeat.Heartbeat); ok {
			if p.InstanceID != AgentIDMarker {
				return failure("IDENTITY_BIND_FAILED")
			}
			p.InstanceID = identity.AgentID
			return nil
		}
	}
	return failure("IDENTITY_BIND_FAILED")
}

func wipe(data []byte) {
	for i := range data {
		data[i] = 0
	}
}

// Explicitly release our bound native secrets after fully stopping the runtime.
// Input secrets remain owned by upstream plugin/config lifetimes.
func destroyBinding(cfg *config.Config) {
	if cfg == nil {
		return
	}
	for _, output := range cfg.Outputs {
		switch p := output.Output.(type) {
		case *nativehttp.HTTP:
			if value := p.Headers["Authorization"]; value != nil {
				value.Destroy()
			}
		case *heartbeat.Heartbeat:
			p.Token.Destroy()
		}
	}
}
