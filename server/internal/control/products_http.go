package control

import (
	"bytes"
	"encoding/json"
	"github.com/gin-gonic/gin"
	"github.com/gowebpki/jcs"
)

func productBody(c *gin.Context, target any) bool {
	var raw json.RawMessage
	if !body(c, &raw) {
		return false
	}
	if _, err := jcs.Transform(raw); err != nil {
		fail(c, 400, "invalid_draft_document")
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		fail(c, 400, "invalid_request")
		return false
	}
	return true
}

func (s *Server) products(c *gin.Context) {
	session, _, ok := s.authenticated(c, "console")
	if !ok {
		return
	}
	after := c.Query("after")
	if after != "" && !productID.MatchString(after) {
		fail(c, 400, "invalid_request")
		return
	}
	v, err := s.productsStore.Products(c.Request.Context(), session.Principal.ID, after)
	result(c, v, err)
}
func (s *Server) product(c *gin.Context) {
	session, _, ok := s.authenticated(c, "console")
	if !ok {
		return
	}
	if !productID.MatchString(c.Param("product")) {
		fail(c, 400, "invalid_request")
		return
	}
	v, err := s.productsStore.Product(c.Request.Context(), session.Principal.ID, c.Param("product"))
	result(c, v, err)
}
func (s *Server) writeProduct(c *gin.Context) {
	session, _, ok := s.authenticated(c, "console")
	if !ok {
		return
	}
	saving := c.Param("product") != ""
	var input ProductWrite
	if saving {
		if !productBody(c, &input) {
			return
		}
	} else {
		var create struct {
			Key   string          `json:"request_key"`
			Name  string          `json:"name"`
			Model json.RawMessage `json:"model"`
		}
		if !productBody(c, &create) {
			return
		}
		input = ProductWrite{Key: create.Key, Name: create.Name, Model: create.Model}
	}
	if !validProductWrite(input, saving) || saving && !productID.MatchString(c.Param("product")) {
		fail(c, 400, "invalid_request")
		return
	}
	model, _, err := productDocument(input.Model)
	if err != nil {
		fail(c, 400, "invalid_draft_document")
		return
	}
	input.Model = model
	kind := "products.create"
	if saving {
		kind = "products.save"
	}
	digest, err := CanonicalDigest(struct {
		Kind      string       `json:"kind"`
		ProductID string       `json:"product_id"`
		Input     ProductWrite `json:"request"`
	}{kind, c.Param("product"), input})
	if err != nil {
		fail(c, 400, "invalid_draft_document")
		return
	}
	v, err := s.productsStore.WriteProduct(c.Request.Context(), ProductOperation{ID: "prodop-" + Random(), PrincipalID: session.Principal.ID, Kind: kind, ProductID: c.Param("product"), Digest: digest, Input: input})
	// revision冲突也是耐久的原决定；200不表示草稿已保存，消费者必须读status。
	result(c, v, err)
}
func (s *Server) productOperation(c *gin.Context) {
	session, _, ok := s.authenticated(c, "console")
	if !ok {
		return
	}
	if !productKey.MatchString(c.Param("key")) {
		fail(c, 400, "invalid_request")
		return
	}
	v, err := s.productsStore.ProductOperation(c.Request.Context(), session.Principal.ID, c.Param("key"))
	result(c, v, err)
}
