package control

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"os"
	"regexp"
	"strings"

	"github.com/gowebpki/jcs"
)

const modelReleaseSigningDomain = "LimeIoT Model Release v1\n"

var ErrReleaseSigner = errors.New("release_signer_unavailable")
var modelPublisherID = regexp.MustCompile(`^publisher-[a-f0-9]{64}$`)
var modelPublisherPrincipal = regexp.MustCompile(`^p-[a-f0-9]{64}$`)

type ModelPublisher struct {
	ID        string `json:"publisher_id"`
	Namespace string `json:"namespace"`
}

// ModelPublisherFor 分配实例内的公开身份，不公开OIDC subject，也不接受自报厂商命名空间。
func ModelPublisherFor(issuer, principal string) (ModelPublisher, error) {
	if !exactOrigin(issuer) || !modelPublisherPrincipal.MatchString(principal) {
		return ModelPublisher{}, ErrReleaseSigner
	}
	digest := Hash("LimeIoT Publisher v1\n" + issuer + "\n" + principal)
	return ModelPublisher{ID: "publisher-" + digest, Namespace: "p-" + digest[:30]}, nil
}

func validModelPublisher(value ModelPublisher) bool {
	return modelPublisherID.MatchString(value.ID) && value.Namespace == "p-"+value.ID[10:40]
}

type ModelReleaseBaseline struct {
	ReleaseID     string `json:"release_id"`
	ModelRevision string `json:"model_revision"`
	ModelVersion  string `json:"model_version"`
}
type ModelReleaseStatement struct {
	Issuer               string                `json:"issuer"`
	PublisherID          string                `json:"publisher_id"`
	Namespace            string                `json:"namespace"`
	ProductID            string                `json:"product_id"`
	ReleaseID            string                `json:"release_id"`
	SourceRevision       string                `json:"source_revision"`
	SourceDocumentDigest string                `json:"source_document_digest"`
	Visibility           string                `json:"visibility"`
	Validator            string                `json:"validator"`
	CompatibilityChecker string                `json:"compatibility_checker"`
	ModelRevision        string                `json:"model_revision"`
	Model                json.RawMessage       `json:"model"`
	Baseline             *ModelReleaseBaseline `json:"baseline"`
	PublishedAt          string                `json:"published_at"`
}
type ModelReleaseArtifact struct {
	Version      int                   `json:"version"`
	Algorithm    string                `json:"algorithm"`
	SigningKeyID string                `json:"signing_key_id"`
	Statement    ModelReleaseStatement `json:"statement"`
	Signature    string                `json:"signature"`
}
type ModelReleaseTrust struct {
	Version      int    `json:"version"`
	Issuer       string `json:"issuer"`
	PublisherID  string `json:"publisher_id"`
	Namespace    string `json:"namespace"`
	SigningKeyID string `json:"signing_key_id"`
	PublicKey    string `json:"public_key"`
}

// ModelReleaseSigner 只持有独立发布密钥。完整模型、命名空间和制品规则仍须由共享Rust校验。
type ModelReleaseSigner struct {
	issuer string
	key    ed25519.PrivateKey
	keyID  string
}

func loadModelReleaseSigner(issuer, path string) (*ModelReleaseSigner, error) {
	if path == "" {
		return nil, nil
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, ErrReleaseSigner
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 8192 || info.Mode().Perm()&0077 != 0 {
		return nil, ErrReleaseSigner
	}
	encoded, err := io.ReadAll(io.LimitReader(file, 8193))
	if err != nil {
		return nil, ErrReleaseSigner
	}
	defer clear(encoded)
	return NewModelReleaseSigner(issuer, encoded)
}

func NewModelReleaseSigner(issuer string, encoded []byte) (*ModelReleaseSigner, error) {
	if !exactOrigin(issuer) || len(encoded) == 0 || len(encoded) > 8192 {
		return nil, ErrReleaseSigner
	}
	if !strings.HasPrefix(strings.TrimSpace(string(encoded)), "-----BEGIN PRIVATE KEY-----") {
		return nil, ErrReleaseSigner
	}
	block, rest := pem.Decode(encoded)
	if block == nil || block.Type != "PRIVATE KEY" || len(block.Headers) != 0 || strings.TrimSpace(string(rest)) != "" {
		return nil, ErrReleaseSigner
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	key, ok := parsed.(ed25519.PrivateKey)
	if err != nil || !ok || len(key) != ed25519.PrivateKeySize {
		return nil, ErrReleaseSigner
	}
	// 使用自己的副本；调用者随后清理输入不会改变正在使用的签名身份。
	owned := append(ed25519.PrivateKey(nil), key...)
	return &ModelReleaseSigner{issuer: issuer, key: owned, keyID: "sha256:" + Hash(string(owned.Public().(ed25519.PublicKey)))}, nil
}

func (s *ModelReleaseSigner) Trust(publisher ModelPublisher) (ModelReleaseTrust, error) {
	if s == nil || !validModelPublisher(publisher) {
		return ModelReleaseTrust{}, ErrReleaseSigner
	}
	return ModelReleaseTrust{Version: 1, Issuer: s.issuer, PublisherID: publisher.ID, Namespace: publisher.Namespace, SigningKeyID: s.keyID, PublicKey: base64.StdEncoding.EncodeToString(s.key.Public().(ed25519.PublicKey))}, nil
}

func modelReleaseSigningMessage(artifact ModelReleaseArtifact) ([]byte, error) {
	raw, err := json.Marshal(struct {
		Version      int                   `json:"version"`
		Algorithm    string                `json:"algorithm"`
		SigningKeyID string                `json:"signing_key_id"`
		Statement    ModelReleaseStatement `json:"statement"`
	}{artifact.Version, artifact.Algorithm, artifact.SigningKeyID, artifact.Statement})
	if err != nil {
		return nil, ErrReleaseSigner
	}
	canonical, err := jcs.Transform(raw)
	if err != nil {
		return nil, ErrReleaseSigner
	}
	return append([]byte(modelReleaseSigningDomain), canonical...), nil
}

// Sign 构造签名，不将调用者的模型标记为已发布；后续必须验证并耐久提交整个原决定。
func (s *ModelReleaseSigner) Sign(statement ModelReleaseStatement) (ModelReleaseArtifact, error) {
	if s == nil || statement.Issuer != s.issuer || !validModelPublisher(ModelPublisher{ID: statement.PublisherID, Namespace: statement.Namespace}) {
		return ModelReleaseArtifact{}, ErrReleaseSigner
	}
	statement.Model = append(json.RawMessage(nil), statement.Model...)
	if statement.Baseline != nil {
		baseline := *statement.Baseline
		statement.Baseline = &baseline
	}
	artifact := ModelReleaseArtifact{Version: 1, Algorithm: "Ed25519", SigningKeyID: s.keyID, Statement: statement}
	message, err := modelReleaseSigningMessage(artifact)
	if err != nil {
		return ModelReleaseArtifact{}, err
	}
	artifact.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(s.key, message))
	return artifact, nil
}
