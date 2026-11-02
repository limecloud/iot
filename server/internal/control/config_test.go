package control

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestConfigurationBoundaries(t *testing.T) {
	for _, value := range []string{"http://192.168.1.2", "http://localhost", "https://host/path", "https://host?", "https://host#fragment", "https://user:pass@host"} {
		if exactOrigin(value) {
			t.Errorf("unsafe origin accepted: %s", value)
		}
	}
	for _, value := range []string{"https://iot.example", "http://127.0.0.1:1234", "http://[::1]:1234"} {
		if !exactOrigin(value) {
			t.Errorf("origin rejected: %s", value)
		}
	}
	if !validIssuer("https://identity.example/oidc") || validIssuer("https://identity.example/oidc?next=x") {
		t.Fatal("issuer path handling")
	}
	cfg := Config{Origin: "https://iot.example", Mode: "private", Key: make([]byte, 32), Logins: map[string]LoginConfig{"console": {Origin: "https://iot.example", LocalToken: Random()}, "admin": {Origin: "https://iot.example", LocalToken: Random()}}}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	l := cfg.Logins["admin"]
	l.LocalToken = cfg.Logins["console"].LocalToken
	cfg.Logins["admin"] = l
	if cfg.Validate() == nil {
		t.Fatal("shared credentials accepted")
	}
	cfg.Mode = "cloud"
	if cfg.Validate() == nil {
		t.Fatal("cloud local identity accepted")
	}
}
func TestEnvironmentPortAndIndependentCredentials(t *testing.T) {
	directory := t.TempDir()
	for name, value := range map[string]string{"LIMEIOT_CONTROL_KEY_FILE": Random(), "LIMEIOT_CONSOLE_TOKEN_FILE": Random(), "LIMEIOT_ADMIN_TOKEN_FILE": Random()} {
		path := filepath.Join(directory, name)
		if err := os.WriteFile(path, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
		t.Setenv(name, path)
	}
	for _, name := range []string{"LIMEIOT_CONTROL_LISTEN", "LIMEIOT_CONTROL_EDGE_TOKEN_FILE", "LIMEIOT_CONSOLE_ORIGIN", "LIMEIOT_ADMIN_ORIGIN", "LIMEIOT_CONSOLE_OIDC_ISSUER", "LIMEIOT_ADMIN_OIDC_ISSUER", "LIMEIOT_CONSOLE_OIDC_CLIENT_ID", "LIMEIOT_ADMIN_OIDC_CLIENT_ID", "LIMEIOT_CONSOLE_OIDC_SECRET_FILE", "LIMEIOT_ADMIN_OIDC_SECRET_FILE"} {
		t.Setenv(name, "")
	}
	t.Setenv("LIMEIOT_CONTROL_MODE", "private")
	t.Setenv("LIMEIOT_CONTROL_ORIGIN", "https://iot.example")
	t.Setenv("PORT", "19000")
	cfg, err := FromEnv()
	if err != nil || cfg.Address != "0.0.0.0:19000" {
		t.Fatal("platform port not applied")
	}
	t.Setenv("PORT", "0")
	if _, err = FromEnv(); err == nil {
		t.Fatal("invalid platform port accepted")
	}
	t.Setenv("LIMEIOT_CONTROL_LISTEN", "127.0.0.1:17890")
	cfg, err = FromEnv()
	if err != nil || cfg.Address != "127.0.0.1:17890" {
		t.Fatal("explicit listen address not respected")
	}
}

func TestCloudInstallationSelectionConfiguration(t *testing.T) {
	for _, test := range []struct {
		environment, installation, space string
		valid                            bool
	}{
		{"production", "", "", true},
		{"production", "ins_fixture", "sp_fixture", true},
		{"production", "ins_fixture", "", false},
		{"production", "", "sp_fixture", false},
		{"production", "ins_fixture?other=x", "sp_fixture", false},
		{"sandbox", "ins_fixture", "sp_fixture", false},
		{"", "ins_fixture", "sp_fixture", false},
	} {
		cfg := Config{Origin: "https://iot.example", Mode: "private", Key: make([]byte, 32), Logins: map[string]LoginConfig{
			"console": {Origin: "https://iot.example", LocalToken: "console-private-token-with-32-characters"},
			"admin":   {Origin: "https://iot.example", LocalToken: "admin-private-token-with-32-characters", Issuer: "https://identity.example", ClientID: "app_fixture", ClientSecret: "fixture", CloudEnvironment: test.environment, ApplicationID: "app_fixture", InstallationID: test.installation, SpaceID: test.space},
		}}
		if err := cfg.Validate(); (err == nil) != test.valid {
			t.Errorf("environment=%q installation=%q space=%q valid=%v: %v", test.environment, test.installation, test.space, test.valid, err)
		}
	}
}
func TestNodeGeneratedPairingVector(t *testing.T) {
	raw, err := os.ReadFile("../../../contracts/examples/control-pairing-proof.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Seed    string  `json:"test_seed_hex"`
		Origin  string  `json:"control_origin"`
		Pairing Pairing `json:"pairing"`
		Claim   Claim   `json:"claim"`
		Proof   string  `json:"proof"`
	}
	if err = json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if proof := PairingProof(v.Origin, v.Pairing, v.Claim); proof != v.Proof {
		t.Fatal("proof byte sequence differs from Node fixture")
	}
	if verifyClaim(v.Origin, v.Pairing, v.Claim) != nil {
		t.Fatal("Node signature not accepted")
	}
	seed, err := hex.DecodeString(v.Seed)
	if err != nil || len(seed) != 32 {
		t.Fatal("invalid test seed")
	}
	signature := base64.StdEncoding.EncodeToString(ed25519.Sign(ed25519.NewKeyFromSeed(seed), []byte(v.Proof)))
	if signature != v.Claim.Signature {
		t.Fatal("Go signature differs from Node fixture")
	}
}
func TestPairingProofAndCredentialBinding(t *testing.T) {
	key := make([]byte, 32)
	rand.Read(key)
	sealed, err := seal(key, "console:one", "external-secret")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = open(key, "admin:one", sealed); err == nil {
		t.Fatal("credential audience swap accepted")
	}
	if value, err := open(key, "console:one", sealed); err != nil || value != "external-secret" {
		t.Fatal("seal roundtrip")
	}
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	pair := Pairing{ID: "pair-one", Challenge: Random(), SpaceID: "cloud-space", Principal: Principal{ID: "owner"}, Expires: time.Unix(1800000000, 0)}
	claim := Claim{GatewayID: "gw-" + Hash(string(public)), LocalSpaceID: "local-space", PublicKey: base64.StdEncoding.EncodeToString(public)}
	claim.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(private, []byte(PairingProof("https://iot.example", pair, claim))))
	if verifyClaim("https://iot.example", pair, claim) != nil {
		t.Fatal("valid proof rejected")
	}
	if verifyClaim("https://other.example", pair, claim) == nil {
		t.Fatal("cross-control proof accepted")
	}
	pair.Principal.ID = "different"
	if verifyClaim("https://iot.example", pair, claim) == nil {
		t.Fatal("proof owner swap accepted")
	}
}
