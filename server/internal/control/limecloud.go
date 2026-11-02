package control

import (
	"encoding/base64"
	"encoding/json"
	"math"
	"regexp"
	"strings"
)

var cloudIdentifier = regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}$`)

// 安装上下文随访问令牌一起加密保存；每次 UserInfo 重验原上下文。
type cloudCredential struct {
	Token       string         `json:"access_token"`
	Environment string         `json:"environment"`
	Application string         `json:"application_id"`
	Context     map[string]any `json:"authorization"`
}

const cloudCredentialPrefix = "limecloud:v1:"

func (p *OIDC) cloudContext(claims map[string]any) (map[string]any, error) {
	result := map[string]any{}
	if p.Config.CloudEnvironment == "" {
		return result, nil
	}
	for _, key := range []string{"lime_authorization_source", "lime_test_approval_id", "lime_test_space_id", "lime_test_approval_expires_at"} {
		if _, exists := claims[key]; exists {
			return nil, ErrIdentity
		}
	}
	if environment, exists := claims["lime_environment"]; exists && environment != p.Config.CloudEnvironment {
		return nil, ErrIdentity
	}
	if application, exists := claims["lime_application_id"]; exists && application != p.Config.ApplicationID {
		return nil, ErrIdentity
	}
	keys := []string{"lime_installation_id", "lime_space_id", "lime_release_id", "lime_installation_generation"}
	if p.Config.CloudEnvironment == "sandbox" {
		for _, key := range keys {
			if _, exists := claims[key]; exists {
				return nil, ErrIdentity
			}
		}
		return result, nil
	}
	for _, key := range keys[:3] {
		value, ok := claims[key].(string)
		if !ok || !cloudIdentifier.MatchString(value) {
			return nil, ErrIdentity
		}
		result[key] = value
	}
	if p.Config.InstallationID != "" && (result["lime_installation_id"] != p.Config.InstallationID || result["lime_space_id"] != p.Config.SpaceID) {
		return nil, ErrIdentity
	}
	generation, ok := claims[keys[3]].(float64)
	if !ok || math.IsNaN(generation) || math.IsInf(generation, 0) || generation <= 0 || generation > 9007199254740991 || math.Trunc(generation) != generation {
		return nil, ErrIdentity
	}
	result[keys[3]] = generation
	return result, nil
}

func (p *OIDC) encodeCredential(token string, context map[string]any) (string, error) {
	if p.Config.CloudEnvironment == "" {
		return token, nil
	}
	data, err := json.Marshal(cloudCredential{Token: token, Environment: p.Config.CloudEnvironment, Application: p.Config.ApplicationID, Context: context})
	if err != nil {
		return "", err
	}
	return cloudCredentialPrefix + base64.RawURLEncoding.EncodeToString(data), nil
}

func (p *OIDC) decodeCredential(value string) (cloudCredential, error) {
	if p.Config.CloudEnvironment == "" {
		if strings.HasPrefix(value, cloudCredentialPrefix) {
			return cloudCredential{}, ErrIdentity
		}
		return cloudCredential{Token: value}, nil
	}
	if !strings.HasPrefix(value, cloudCredentialPrefix) || len(value) > 20000 {
		return cloudCredential{}, ErrIdentity
	}
	data, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(value, cloudCredentialPrefix))
	var credential cloudCredential
	if err != nil || json.Unmarshal(data, &credential) != nil || credential.Token == "" || len(credential.Token) > 8192 || credential.Environment != p.Config.CloudEnvironment || credential.Application != p.Config.ApplicationID || credential.Context == nil {
		return credential, ErrIdentity
	}
	// 重验保存的上下文本身，不能接受缺字段或跨环境的旧凭据。
	if _, err := p.cloudContext(credential.Context); err != nil {
		return credential, err
	}
	return credential, nil
}
