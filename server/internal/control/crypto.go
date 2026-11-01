package control

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
)

func Random() string {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		panic(err)
	}
	return hex.EncodeToString(value)
}
func Hash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
func seal(key []byte, purpose, value string) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return nil, err
	}
	return aead.Seal(nonce, nonce, []byte(value), []byte(purpose)), nil
}
func open(key []byte, purpose string, value []byte) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(value) < aead.NonceSize() {
		return "", ErrIdentity
	}
	clear, err := aead.Open(nil, value[:aead.NonceSize()], value[aead.NonceSize():], []byte(purpose))
	return string(clear), err
}
func identifier(value string) bool {
	if len(value) < 1 || len(value) > 128 {
		return false
	}
	for _, c := range value {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}
func PairingProof(origin string, pairing Pairing, claim Claim) string {
	return strings.Join([]string{"LIMEIOT-PAIR-1", origin, pairing.ID, pairing.Challenge, pairing.SpaceID, claim.GatewayID, claim.LocalSpaceID, pairing.Principal.ID, claim.PublicKey, strconv.FormatInt(pairing.Expires.Unix(), 10)}, "\n")
}
func verifyClaim(origin string, pairing Pairing, claim Claim) error {
	key, err := base64.StdEncoding.DecodeString(claim.PublicKey)
	if err != nil || len(key) != ed25519.PublicKeySize || base64.StdEncoding.EncodeToString(key) != claim.PublicKey || !identifier(claim.LocalSpaceID) || claim.GatewayID != "gw-"+Hash(string(key)) {
		return ErrIdentity
	}
	signature, err := base64.StdEncoding.DecodeString(claim.Signature)
	if err != nil || !ed25519.Verify(key, []byte(PairingProof(origin, pairing, claim)), signature) {
		return ErrIdentity
	}
	return nil
}
func secretPurpose(audience, hash string) string {
	return fmt.Sprintf("limeiot-control:%s:%s", audience, hash)
}
