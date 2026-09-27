package badhub

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"

	"github.com/ihatemyfcklife/badcrypt"
	"github.com/ihatemyfcklife/badsharing"
)

var (
	// BlossomMagic defines the 4-byte envelope header for BadHub Blossom containers ("BHB1").
	BlossomMagic = [4]byte{'B', 'H', 'B', '1'}

	// ErrInvalidMagic is returned when a blossom envelope does not begin with BlossomMagic.
	ErrInvalidMagic = errors.New("badhub: invalid blossom envelope magic header")

	// ErrIncompleteHeader is returned when the provided header bytes are too short.
	ErrIncompleteHeader = errors.New("badhub: incomplete blossom header")

	// ErrCorruptBlob is returned when an envelope has invalid chunk framing or lengths.
	ErrCorruptBlob = errors.New("badhub: corrupt blossom blob envelope")

	// ErrChecksumFail is returned when decrypted content does not match the metadata SHA-256.
	ErrChecksumFail = errors.New("badhub: blossom payload SHA-256 verification failed")
)

// BlossomMetadata encapsulates file attributes stored inside the encrypted envelope.
type BlossomMetadata struct {
	Name     string `json:"name"`
	Size     uint64 `json:"size"`
	Checksum string `json:"checksum"`
}

// BlossomEncryptor provides streaming ChaCha20-Poly1305 encryption for decentralized Blossom storage.
type BlossomEncryptor struct {
	meta      BlossomMetadata
	aead      *badcrypt.ShardAEAD
	sessionID uint64
}

// BlossomDecryptor provides streaming decryption and integrity verification for Blossom blobs.
type BlossomDecryptor struct {
	meta      BlossomMetadata
	aead      *badcrypt.ShardAEAD
	sessionID uint64
	hasher    hash.Hash
	bytesRead uint64
}

// NewBlossomEncryptor initializes a streaming encryptor and generates the sealed envelope header.
func NewBlossomEncryptor(meta BlossomMetadata, passphrase string) (*BlossomEncryptor, []byte, error) {
	if meta.Size == 0 && meta.Checksum == "" {
		h := sha256.Sum256(nil)
		meta.Checksum = hex.EncodeToString(h[:])
	}

	key := badsharing.DeriveKeyFromPassphrase(passphrase)
	aeadKey := badcrypt.DeriveAEADKeyFromSecret(key[:])
	sessionID := badsharing.GenerateSessionID()

	aead, err := badcrypt.NewShardAEADWithSession(aeadKey, sessionID)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to create AEAD: %w", err)
	}

	metaJSON, err := json.Marshal(meta)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to marshal metadata: %w", err)
	}

	sealedMeta, err := aead.Seal(nil, metaJSON, []byte("blossom-meta"))
	if err != nil {
		return nil, nil, fmt.Errorf("failed to seal metadata: %w", err)
	}

	// Envelope Header format:
	// [4B Magic: 'BHB1'] [4B uint32: sealedMetaLen] [sealedMeta]
	header := make([]byte, 8+len(sealedMeta))
	copy(header[:4], BlossomMagic[:])
	binary.BigEndian.PutUint32(header[4:8], uint32(len(sealedMeta)))
	copy(header[8:], sealedMeta)

	enc := &BlossomEncryptor{
		meta:      meta,
		aead:      aead,
		sessionID: sessionID,
	}

	return enc, header, nil
}

// EncryptChunk encrypts a plaintext chunk and prefixes it with a 4-byte big-endian length.
func (e *BlossomEncryptor) EncryptChunk(plainChunk []byte) ([]byte, error) {
	if e == nil || e.aead == nil {
		return nil, errors.New("badhub: nil encryptor")
	}

	sealed, err := e.aead.Seal(nil, plainChunk, []byte("blossom-chunk"))
	if err != nil {
		return nil, fmt.Errorf("failed to seal chunk: %w", err)
	}

	out := make([]byte, 4+len(sealed))
	binary.BigEndian.PutUint32(out[:4], uint32(len(sealed)))
	copy(out[4:], sealed)
	return out, nil
}

// NewBlossomDecryptor parses the sealed envelope header and initializes the decryptor.
// It returns the decryptor, the extracted metadata, the number of bytes consumed from headerBytes,
// or an error if magic is invalid or authentication fails (e.g. wrong passphrase).
func NewBlossomDecryptor(headerBytes []byte, passphrase string) (*BlossomDecryptor, *BlossomMetadata, int, error) {
	if len(headerBytes) < 8 {
		return nil, nil, 0, ErrIncompleteHeader
	}

	if !bytes.Equal(headerBytes[:4], BlossomMagic[:]) {
		return nil, nil, 0, ErrInvalidMagic
	}

	metaLen := int(binary.BigEndian.Uint32(headerBytes[4:8]))
	totalHeaderLen := 8 + metaLen
	if len(headerBytes) < totalHeaderLen {
		return nil, nil, 0, ErrIncompleteHeader
	}

	sealedMeta := headerBytes[8:totalHeaderLen]
	if len(sealedMeta) < 8 {
		return nil, nil, 0, ErrCorruptBlob
	}

	sessionID := binary.BigEndian.Uint64(sealedMeta[:8])
	key := badsharing.DeriveKeyFromPassphrase(passphrase)
	aeadKey := badcrypt.DeriveAEADKeyFromSecret(key[:])

	aead, err := badcrypt.NewShardAEADWithSession(aeadKey, sessionID)
	if err != nil {
		return nil, nil, 0, fmt.Errorf("failed to create AEAD: %w", err)
	}

	plainMetaJSON, err := aead.Open(nil, sealedMeta, []byte("blossom-meta"))
	if err != nil {
		return nil, nil, 0, fmt.Errorf("metadata decryption failed (wrong passphrase or tampered header): %w", err)
	}

	var meta BlossomMetadata
	if err := json.Unmarshal(plainMetaJSON, &meta); err != nil {
		return nil, nil, 0, fmt.Errorf("corrupt metadata JSON: %w", err)
	}

	dec := &BlossomDecryptor{
		meta:      meta,
		aead:      aead,
		sessionID: sessionID,
		hasher:    sha256.New(),
		bytesRead: 0,
	}

	return dec, &meta, totalHeaderLen, nil
}

// DecryptChunk authenticates and decrypts a sealed chunk.
func (d *BlossomDecryptor) DecryptChunk(sealedChunk []byte) ([]byte, error) {
	if d == nil || d.aead == nil {
		return nil, errors.New("badhub: nil decryptor")
	}

	plain, err := d.aead.Open(nil, sealedChunk, []byte("blossom-chunk"))
	if err != nil {
		return nil, fmt.Errorf("chunk decryption failed: %w", err)
	}

	d.hasher.Write(plain)
	d.bytesRead += uint64(len(plain))
	return plain, nil
}

// Finalize verifies that total decrypted bytes match expected size and checksum.
func (d *BlossomDecryptor) Finalize() error {
	if d == nil {
		return errors.New("badhub: nil decryptor")
	}
	if d.bytesRead != d.meta.Size {
		return fmt.Errorf("size mismatch: decrypted %d bytes, expected %d", d.bytesRead, d.meta.Size)
	}
	sum := hex.EncodeToString(d.hasher.Sum(nil))
	if sum != d.meta.Checksum {
		return fmt.Errorf("%w: computed %s, expected %s", ErrChecksumFail, sum, d.meta.Checksum)
	}
	return nil
}

// BytesRead returns the total number of plaintext bytes decrypted so far.
func (d *BlossomDecryptor) BytesRead() uint64 {
	if d == nil {
		return 0
	}
	return d.bytesRead
}

// TotalSize returns the expected total plaintext size from metadata.
func (d *BlossomDecryptor) TotalSize() uint64 {
	if d == nil {
		return 0
	}
	return d.meta.Size
}

// EncryptBlossomBuffer encrypts a complete in-memory buffer into a self-contained Blossom envelope.
func EncryptBlossomBuffer(name string, plain []byte, passphrase string) ([]byte, error) {
	h := sha256.Sum256(plain)
	meta := BlossomMetadata{
		Name:     name,
		Size:     uint64(len(plain)),
		Checksum: hex.EncodeToString(h[:]),
	}

	enc, header, err := NewBlossomEncryptor(meta, passphrase)
	if err != nil {
		return nil, err
	}

	var buf bytes.Buffer
	buf.Write(header)

	const chunkSize = 1024 * 1024 // 1 MB chunks
	for offset := 0; offset < len(plain); offset += chunkSize {
		end := offset + chunkSize
		if end > len(plain) {
			end = len(plain)
		}
		chunk, err := enc.EncryptChunk(plain[offset:end])
		if err != nil {
			return nil, err
		}
		buf.Write(chunk)
	}

	return buf.Bytes(), nil
}

// DecryptBlossomBuffer parses and decrypts a complete Blossom envelope buffer.
func DecryptBlossomBuffer(blob []byte, passphrase string) (*BlossomMetadata, []byte, error) {
	dec, meta, headerLen, err := NewBlossomDecryptor(blob, passphrase)
	if err != nil {
		return nil, nil, err
	}

	var out bytes.Buffer
	offset := headerLen

	for offset < len(blob) {
		if offset+4 > len(blob) {
			return nil, nil, ErrCorruptBlob
		}
		chunkLen := int(binary.BigEndian.Uint32(blob[offset : offset+4]))
		offset += 4

		if offset+chunkLen > len(blob) {
			return nil, nil, ErrCorruptBlob
		}
		sealedChunk := blob[offset : offset+chunkLen]
		offset += chunkLen

		plain, err := dec.DecryptChunk(sealedChunk)
		if err != nil {
			return nil, nil, err
		}
		out.Write(plain)
	}

	if err := dec.Finalize(); err != nil {
		return nil, nil, err
	}

	return meta, out.Bytes(), nil
}
