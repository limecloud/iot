package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gowebpki/jcs"
)

var ErrProductCapacity = errors.New("product_capacity_reached")

type Product struct {
	ID             string          `json:"product_id"`
	PrincipalID    string          `json:"principal_id"`
	Name           string          `json:"name"`
	Revision       string          `json:"revision"`
	DocumentDigest string          `json:"document_digest"`
	Model          json.RawMessage `json:"model"`
	Status         string          `json:"status"`
	Validation     string          `json:"validation"`
	Created        time.Time       `json:"created_at"`
	Updated        time.Time       `json:"updated_at"`
}
type ProductWrite struct {
	Key              string          `json:"request_key"`
	ExpectedRevision string          `json:"expected_revision,omitempty"`
	Name             string          `json:"name"`
	Model            json.RawMessage `json:"model"`
}
type ProductOperation struct {
	ID          string       `json:"operation_id"`
	PrincipalID string       `json:"principal_id"`
	Kind        string       `json:"kind"`
	ProductID   string       `json:"product_id"`
	Digest      string       `json:"request_digest"`
	Input       ProductWrite `json:"request"`
	Status      string       `json:"status"`
	Product     Product      `json:"product"`
	Created     time.Time    `json:"created_at"`
}
type ProductPage struct {
	Items []Product `json:"items"`
	Next  *string   `json:"next"`
}

// ProductDrafts 持有发布者私有草稿；不修改网关模型发布记录或设备绑定。
type ProductDrafts interface {
	WriteProduct(context.Context, ProductOperation) (ProductOperation, error)
	Products(context.Context, string, string) (ProductPage, error)
	Product(context.Context, string, string) (Product, error)
	ProductOperation(context.Context, string, string) (ProductOperation, error)
}

var productKey = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var productID = regexp.MustCompile(`^product-[a-f0-9]{64}$`)
var productRevision = regexp.MustCompile(`^prodrev-[a-f0-9]{64}$`)

// 这里只检查耐久草稿的JSON安全边界；模型语义须经发布校验，不能标为validated。
func productDocument(raw json.RawMessage) (json.RawMessage, string, error) {
	return boundedObjectDocument(raw, 8192, 16, 2048)
}
func boundedObjectDocument(raw json.RawMessage, maxBytes, maxDepth, maxNodes int) (json.RawMessage, string, error) {
	if len(raw) == 0 || len(raw) > maxBytes || !utf8.Valid(raw) {
		return nil, "", errors.New("invalid_draft_document")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if decoder.Decode(&value) != nil {
		return nil, "", errors.New("invalid_draft_document")
	}
	if _, ok := value.(map[string]any); !ok {
		return nil, "", errors.New("invalid_draft_document")
	}
	nodes := 0
	var valid func(any, int) bool
	valid = func(value any, depth int) bool {
		nodes++
		if depth > maxDepth || nodes > maxNodes {
			return false
		}
		switch v := value.(type) {
		case map[string]any:
			for _, child := range v {
				if !valid(child, depth+1) {
					return false
				}
			}
		case []any:
			for _, child := range v {
				if !valid(child, depth+1) {
					return false
				}
			}
		case json.Number:
			f, err := v.Float64()
			if err != nil || math.IsNaN(f) || math.IsInf(f, 0) || math.Trunc(f) == f && math.Abs(f) > 9007199254740991 {
				return false
			}
		}
		return true
	}
	if !valid(value, 0) {
		return nil, "", errors.New("invalid_draft_document")
	}
	canonical, err := jcs.Transform(raw)
	if err != nil || len(canonical) > maxBytes {
		return nil, "", errors.New("invalid_draft_document")
	}
	return canonical, "sha256:" + Hash(string(canonical)), nil
}
func validProductWrite(v ProductWrite, saving bool) bool {
	return productKey.MatchString(v.Key) && utf8.ValidString(v.Name) && strings.TrimSpace(v.Name) == v.Name &&
		utf8.RuneCountInString(v.Name) >= 1 && utf8.RuneCountInString(v.Name) <= 80 &&
		(saving && productRevision.MatchString(v.ExpectedRevision) || !saving && v.ExpectedRevision == "")
}
