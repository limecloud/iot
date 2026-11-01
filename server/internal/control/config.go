package control

import (
	"encoding/hex"
	"errors"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
)

type LoginConfig struct {
	Origin, Issuer, ClientID, ClientSecret, LocalToken string
	Operators                                          map[string]bool
}
type Config struct {
	Address, Mode, Origin, EdgeToken string
	Key                              []byte
	Logins                           map[string]LoginConfig
}

func secretFile(name string, minimum int) (string, error) {
	path := os.Getenv(name)
	if path == "" {
		return "", nil
	}
	value, err := os.ReadFile(path)
	if err != nil {
		return "", errors.New("secret_file_unreadable")
	}
	text := strings.TrimSpace(string(value))
	if len(text) < minimum || len(text) > 4096 {
		return "", errors.New("invalid_secret_file")
	}
	return text, nil
}
func exactOrigin(value string) bool {
	u, err := url.Parse(value)
	if err != nil || u.Hostname() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.String() != value || len(value) > 400 {
		return false
	}
	ip := net.ParseIP(u.Hostname())
	return u.Scheme == "https" || (u.Scheme == "http" && ip != nil && ip.IsLoopback())
}
func validIssuer(value string) bool {
	u, err := url.Parse(value)
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || len(value) > 512 {
		return false
	}
	copy := *u
	copy.Path = ""
	copy.RawPath = ""
	return exactOrigin(copy.String())
}
func FromEnv() (Config, error) {
	cfg := Config{Address: os.Getenv("LIMEIOT_CONTROL_LISTEN"), Mode: os.Getenv("LIMEIOT_CONTROL_MODE"), Origin: os.Getenv("LIMEIOT_CONTROL_ORIGIN"), Logins: map[string]LoginConfig{}}
	if cfg.Address == "" {
		cfg.Address = "127.0.0.1:17890"
		if value := os.Getenv("PORT"); value != "" {
			port, err := strconv.Atoi(value)
			if err != nil || port < 1 || port > 65535 {
				return cfg, errors.New("invalid_platform_port")
			}
			cfg.Address = net.JoinHostPort("0.0.0.0", value)
		}
	}
	if cfg.Mode == "" {
		cfg.Mode = "private"
	}
	key, err := secretFile("LIMEIOT_CONTROL_KEY_FILE", 64)
	if err != nil {
		return cfg, err
	}
	cfg.Key, err = hex.DecodeString(key)
	if err != nil || len(cfg.Key) != 32 {
		return cfg, errors.New("invalid_control_key")
	}
	cfg.EdgeToken, err = secretFile("LIMEIOT_CONTROL_EDGE_TOKEN_FILE", 32)
	if err != nil {
		return cfg, err
	}
	for _, audience := range []string{"console", "admin"} {
		prefix := "LIMEIOT_" + strings.ToUpper(audience) + "_"
		local, err := secretFile(prefix+"TOKEN_FILE", 32)
		if err != nil {
			return cfg, err
		}
		clientSecret, err := secretFile(prefix+"OIDC_SECRET_FILE", 1)
		if err != nil {
			return cfg, err
		}
		login := LoginConfig{Origin: os.Getenv(prefix + "ORIGIN"), Issuer: os.Getenv(prefix + "OIDC_ISSUER"), ClientID: os.Getenv(prefix + "OIDC_CLIENT_ID"), ClientSecret: clientSecret, LocalToken: local, Operators: map[string]bool{}}
		if login.Origin == "" {
			login.Origin = cfg.Origin
		}
		for _, subject := range strings.Split(os.Getenv(prefix+"OPERATOR_SUBJECTS"), ",") {
			if value := strings.TrimSpace(subject); value != "" {
				login.Operators[value] = true
			}
		}
		cfg.Logins[audience] = login
	}
	return cfg, cfg.Validate()
}
func (cfg Config) Validate() error {
	if !exactOrigin(cfg.Origin) || len(cfg.Key) != 32 || (cfg.Mode != "private" && cfg.Mode != "cloud") {
		return errors.New("invalid_control_configuration")
	}
	if cfg.EdgeToken != "" && (len(cfg.EdgeToken) < 32 || len(cfg.EdgeToken) > 4096) {
		return errors.New("invalid_edge_credential")
	}
	for _, audience := range []string{"console", "admin"} {
		login := cfg.Logins[audience]
		if !exactOrigin(login.Origin) {
			return errors.New("invalid_login_origin")
		}
		if login.Issuer != "" && (!validIssuer(login.Issuer) || login.ClientID == "" || len(login.ClientID) > 512 || login.ClientSecret == "" || len(login.ClientSecret) > 4096) {
			return errors.New("invalid_oidc_configuration")
		}
		if cfg.Mode == "private" && len(login.LocalToken) < 32 {
			return errors.New("local_credentials_required")
		}
		if cfg.Mode == "cloud" && (login.LocalToken != "" || login.Issuer == "" || (audience == "admin" && len(login.Operators) == 0)) {
			return errors.New("cloud_identity_required")
		}
	}
	if cfg.Logins["console"].LocalToken != "" && cfg.Logins["console"].LocalToken == cfg.Logins["admin"].LocalToken {
		return errors.New("audiences_require_distinct_credentials")
	}
	if cfg.Logins["console"].ClientID != "" && cfg.Logins["console"].ClientID == cfg.Logins["admin"].ClientID {
		return errors.New("audiences_require_distinct_clients")
	}
	return nil
}
