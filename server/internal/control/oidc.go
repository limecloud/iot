package control

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// OIDC 只提供认证证明；家庭成员与平台运营权限由 IoT 自己检查。
type OIDC struct {
	Config   LoginConfig
	Audience string
	Client   *http.Client
}

func NewOIDC(cfg LoginConfig, audience string) *OIDC {
	return &OIDC{Config: cfg, Audience: audience, Client: &http.Client{Transport: oidcTransport{}, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

type metadata struct {
	Issuer        string `json:"issuer"`
	Authorization string `json:"authorization_endpoint"`
	Token         string `json:"token_endpoint"`
	UserInfo      string `json:"userinfo_endpoint"`
	JWKS          string `json:"jwks_uri"`
	Revocation    string `json:"revocation_endpoint"`
}

func (p *OIDC) discovery(ctx context.Context) (*oidc.Provider, metadata, context.Context, error) {
	ctx = oidc.ClientContext(ctx, p.Client)
	provider, err := oidc.NewProvider(ctx, p.Config.Issuer)
	if err != nil {
		return nil, metadata{}, ctx, ErrProvider
	}
	var m metadata
	if provider.Claims(&m) != nil || m.Issuer != p.Config.Issuer {
		return nil, m, ctx, ErrProvider
	}
	issuer, _ := url.Parse(p.Config.Issuer)
	for _, endpoint := range []string{m.Authorization, m.Token, m.UserInfo, m.JWKS} {
		u, err := url.Parse(endpoint)
		if err != nil || u.Scheme != issuer.Scheme || u.Host != issuer.Host || u.User != nil || u.Fragment != "" {
			return nil, m, ctx, ErrProvider
		}
	}
	if m.Revocation != "" {
		u, err := url.Parse(m.Revocation)
		if err != nil || u.Scheme != issuer.Scheme || u.Host != issuer.Host || u.User != nil || u.Fragment != "" {
			return nil, m, ctx, ErrProvider
		}
	}
	return provider, m, ctx, nil
}
func (p *OIDC) oauth(m metadata) oauth2.Config {
	scopes := []string{"openid", "profile"}
	if p.Config.CloudEnvironment != "" {
		scopes = append(scopes, "email")
	}
	return oauth2.Config{ClientID: p.Config.ClientID, ClientSecret: p.Config.ClientSecret, RedirectURL: p.Config.Origin + "/api/" + p.Audience + "/v1/auth/callback", Scopes: scopes, Endpoint: oauth2.Endpoint{AuthURL: m.Authorization, TokenURL: m.Token, AuthStyle: oauth2.AuthStyleInHeader}}
}
func (p *OIDC) Authorize(ctx context.Context, state, nonce, verifier string) (string, error) {
	_, m, _, err := p.discovery(ctx)
	if err != nil {
		return "", err
	}
	cfg := p.oauth(m)
	options := []oauth2.AuthCodeOption{oauth2.S256ChallengeOption(verifier), oauth2.SetAuthURLParam("nonce", nonce)}
	if p.Config.InstallationID != "" {
		options = append(options, oauth2.SetAuthURLParam("installation_id", p.Config.InstallationID), oauth2.SetAuthURLParam("space_id", p.Config.SpaceID))
	}
	return cfg.AuthCodeURL(state, options...), nil
}
func (p *OIDC) Exchange(ctx context.Context, code, verifier, nonce string) (Identity, error) {
	provider, m, ctx, err := p.discovery(ctx)
	if err != nil {
		return Identity{}, err
	}
	cfg := p.oauth(m)
	token, err := cfg.Exchange(ctx, code, oauth2.VerifierOption(verifier))
	if err != nil {
		return Identity{}, ErrIdentity
	}
	identity := Identity{Issuer: p.Config.Issuer, AccessToken: token.AccessToken, Expires: token.Expiry}
	if token.AccessToken == "" || len(token.AccessToken) > 8192 || !strings.EqualFold(token.TokenType, "bearer") || !token.Expiry.After(time.Now()) || token.Expiry.After(time.Now().Add(24*time.Hour)) {
		return identity, ErrIdentity
	}
	raw, ok := token.Extra("id_token").(string)
	if !ok {
		return identity, ErrIdentity
	}
	algorithms := []string{"RS256", "ES256", "EdDSA"}
	if p.Config.CloudEnvironment != "" {
		algorithms = []string{"RS256"}
	}
	id, err := provider.VerifierContext(ctx, &oidc.Config{ClientID: p.Config.ClientID, SupportedSigningAlgs: algorithms}).Verify(ctx, raw)
	if err != nil || id.Nonce != nonce || id.Subject == "" || len(id.Subject) > 255 || id.IssuedAt.IsZero() || id.IssuedAt.After(time.Now().Add(10*time.Second)) || id.IssuedAt.Before(time.Now().Add(-10*time.Minute)) {
		return identity, ErrIdentity
	}
	var claims struct {
		AZP  string `json:"azp"`
		Name string `json:"name"`
	}
	if id.Claims(&claims) != nil || (claims.AZP != "" && claims.AZP != p.Config.ClientID) || (len(id.Audience) > 1 && claims.AZP != p.Config.ClientID) {
		return identity, ErrIdentity
	}
	identity.Subject = id.Subject
	identity.Name = strings.TrimSpace(claims.Name)
	var allClaims map[string]any
	if id.Claims(&allClaims) != nil {
		return identity, ErrIdentity
	}
	authorization, err := p.cloudContext(allClaims)
	if err != nil {
		return identity, err
	}
	subject, err := p.current(ctx, m.UserInfo, token.AccessToken, authorization)
	if err != nil {
		return identity, err
	}
	if subject != id.Subject {
		return identity, ErrIdentity
	}
	credential, err := p.encodeCredential(token.AccessToken, authorization)
	if err != nil {
		return identity, err
	}
	identity.AccessToken = credential
	return identity, nil
}
func (p *OIDC) current(ctx context.Context, endpoint, token string, expected map[string]any) (string, error) {
	request, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		return "", ErrProvider
	}
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := p.Client.Do(request)
	if err != nil {
		return "", ErrProvider
	}
	defer response.Body.Close()
	if response.StatusCode == 401 || response.StatusCode == 403 {
		return "", ErrIdentity
	}
	if response.StatusCode != 200 {
		return "", ErrProvider
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 16385))
	if err != nil || len(body) > 16384 {
		return "", ErrProvider
	}
	var claims struct {
		Subject string `json:"sub"`
	}
	if json.Unmarshal(body, &claims) != nil || claims.Subject == "" || len(claims.Subject) > 255 {
		return "", ErrIdentity
	}
	if p.Config.CloudEnvironment != "" {
		var allClaims map[string]any
		if json.Unmarshal(body, &allClaims) != nil {
			return "", ErrIdentity
		}
		current, err := p.cloudContext(allClaims)
		if err != nil || !reflect.DeepEqual(current, expected) {
			return "", ErrIdentity
		}
	}
	return claims.Subject, nil
}
func (p *OIDC) Current(ctx context.Context, token string) (string, error) {
	credential, err := p.decodeCredential(token)
	if err != nil {
		return "", err
	}
	_, m, ctx, err := p.discovery(ctx)
	if err != nil {
		return "", err
	}
	return p.current(ctx, m.UserInfo, credential.Token, credential.Context)
}
func (p *OIDC) Revoke(ctx context.Context, token string) error {
	if strings.HasPrefix(token, cloudCredentialPrefix) {
		credential, err := p.decodeCredential(token)
		if err != nil {
			return err
		}
		token = credential.Token
	}
	_, m, ctx, err := p.discovery(ctx)
	if err != nil {
		return err
	}
	if m.Revocation == "" {
		return nil
	}
	values := url.Values{"token": {token}, "token_type_hint": {"access_token"}}
	request, err := http.NewRequestWithContext(ctx, "POST", m.Revocation, strings.NewReader(values.Encode()))
	if err != nil {
		return ErrProvider
	}
	request.SetBasicAuth(p.Config.ClientID, p.Config.ClientSecret)
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := p.Client.Do(request)
	if err != nil {
		return ErrProvider
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return ErrProvider
	}
	return nil
}
