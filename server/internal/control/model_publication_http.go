package control

import (
	"bytes"
	"encoding/json"
	"errors"
	"regexp"

	"github.com/gin-gonic/gin"
)

var modelReleaseID = regexp.MustCompile(`^release-[a-f0-9]{64}$`)

func (s *Server) publisher(c *gin.Context) {
	session, _, ok := s.authenticated(c, "console")
	if !ok {
		return
	}
	publisher, err := ModelPublisherFor(s.cfg.Origin, session.Principal.ID)
	if err != nil {
		fail(c, 503, "release_signer_unavailable")
		return
	}
	var trust *ModelReleaseTrust
	if s.releaseSigner != nil {
		value, err := s.releaseSigner.Trust(publisher)
		if err != nil {
			fail(c, 503, "release_signer_unavailable")
			return
		}
		trust = &value
	}
	c.JSON(200, gin.H{"issuer": s.cfg.Origin, "publisher_id": publisher.ID, "namespace": publisher.Namespace, "trust": trust})
}
func (s *Server) publicationStore(c *gin.Context) bool {
	if s.publications == nil {
		fail(c, 503, "publication_store_unavailable")
		return false
	}
	return true
}
func (s *Server) publishModel(c *gin.Context) {
	session, _, ok := s.authenticated(c, "console")
	if !ok || !s.publicationStore(c) {
		return
	}
	var raw json.RawMessage
	if !productBody(c, &raw) {
		return
	}
	var fields map[string]json.RawMessage
	var input ModelPublishInput
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if json.Unmarshal(raw, &fields) != nil || len(fields) != 4 || fields["expected_release_id"] == nil || decoder.Decode(&input) != nil ||
		!productID.MatchString(c.Param("product")) || !productKey.MatchString(input.Key) || !productRevision.MatchString(input.ExpectedRevision) ||
		input.Visibility != "public" || input.ExpectedReleaseID != nil && !modelReleaseID.MatchString(*input.ExpectedReleaseID) {
		fail(c, 400, "invalid_request")
		return
	}
	digest, err := CanonicalDigest(struct {
		Kind      string            `json:"kind"`
		ProductID string            `json:"product_id"`
		Input     ModelPublishInput `json:"request"`
	}{"releases.create", c.Param("product"), input})
	if err != nil {
		fail(c, 400, "invalid_request")
		return
	}
	// 已提交决定优先于当前签名器/校验器状态；重试不会重签、换基线或再次发布。
	old, err := s.publications.ModelPublishOperation(c.Request.Context(), session.Principal.ID, input.Key)
	if err == nil {
		if old.Digest != digest {
			result(c, nil, ErrConflict)
		} else {
			result(c, old, nil)
		}
		return
	}
	if !errors.Is(err, ErrMissing) {
		result(c, nil, err)
		return
	}
	if !s.allowed(c, "models.validate") {
		return
	}
	product, err := s.productsStore.Product(c.Request.Context(), session.Principal.ID, c.Param("product"))
	if err != nil {
		result(c, nil, err)
		return
	}
	head, err := s.publications.ModelPublicationHead(c.Request.Context(), session.Principal.ID, product.ID)
	if err != nil {
		result(c, nil, err)
		return
	}
	operation, err := s.preparePublication(c.Request.Context(), ModelPublishOperation{
		ID: "relop-" + Random(), PrincipalID: session.Principal.ID, ProductID: product.ID, Digest: digest, Input: input,
	}, product, head)
	if err != nil {
		if errors.Is(err, ErrReleaseSigner) {
			fail(c, 503, "release_signer_unavailable")
		} else {
			fail(c, 503, "validator_unavailable")
		}
		return
	}
	value, err := s.publications.CommitModelPublication(c.Request.Context(), operation)
	result(c, value, err)
}
func (s *Server) modelPublications(c *gin.Context) {
	session, _, ok := s.authenticated(c, "console")
	if !ok || !s.publicationStore(c) {
		return
	}
	after := c.Query("after")
	if !productID.MatchString(c.Param("product")) || after != "" && !modelReleaseID.MatchString(after) {
		fail(c, 400, "invalid_request")
		return
	}
	value, err := s.publications.ModelPublications(c.Request.Context(), session.Principal.ID, c.Param("product"), after)
	result(c, value, err)
}
func (s *Server) modelPublicationHead(c *gin.Context) {
	session, _, ok := s.authenticated(c, "console")
	if !ok || !s.publicationStore(c) {
		return
	}
	if !productID.MatchString(c.Param("product")) {
		fail(c, 400, "invalid_request")
		return
	}
	if _, err := s.productsStore.Product(c.Request.Context(), session.Principal.ID, c.Param("product")); err != nil {
		result(c, nil, err)
		return
	}
	value, err := s.publications.ModelPublicationHead(c.Request.Context(), session.Principal.ID, c.Param("product"))
	result(c, gin.H{"release": value}, err)
}
func (s *Server) modelPublishOperation(c *gin.Context) {
	session, _, ok := s.authenticated(c, "console")
	if !ok || !s.publicationStore(c) {
		return
	}
	if !productKey.MatchString(c.Param("key")) {
		fail(c, 400, "invalid_request")
		return
	}
	value, err := s.publications.ModelPublishOperation(c.Request.Context(), session.Principal.ID, c.Param("key"))
	result(c, value, err)
}
func (s *Server) publicModelPublication(c *gin.Context) {
	if !s.publicationStore(c) {
		return
	}
	if !modelReleaseID.MatchString(c.Param("release")) {
		fail(c, 400, "invalid_request")
		return
	}
	value, err := s.publications.PublicModelPublication(c.Request.Context(), c.Param("release"))
	result(c, value, err)
}
