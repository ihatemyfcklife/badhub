package badhub_test

import (
	"bytes"
	"crypto/rand"
	"io"
	"testing"

	"github.com/ihatemyfcklife/badhub"
)

func TestBlossom_BufferRoundTrip(t *testing.T) {
	const dataSize = 2*1024*1024 + 12345 // ~2.01 MB
	plain := make([]byte, dataSize)
	_, _ = io.ReadFull(rand.Reader, plain)

	passphrase := "my-super-secret-blossom-key"
	fileName := "report-archive.zip"

	blob, err := badhub.EncryptBlossomBuffer(fileName, plain, passphrase)
	if err != nil {
		t.Fatalf("EncryptBlossomBuffer failed: %v", err)
	}

	meta, decrypted, err := badhub.DecryptBlossomBuffer(blob, passphrase)
	if err != nil {
		t.Fatalf("DecryptBlossomBuffer failed: %v", err)
	}

	if meta.Name != fileName {
		t.Errorf("Metadata name mismatch: expected %s, got %s", fileName, meta.Name)
	}
	if meta.Size != uint64(len(plain)) {
		t.Errorf("Metadata size mismatch: expected %d, got %d", len(plain), meta.Size)
	}
	if !bytes.Equal(plain, decrypted) {
		t.Fatal("Decrypted payload does not match original plain data!")
	}
}

func TestBlossom_WrongPassphraseRejection(t *testing.T) {
	plain := []byte("confidential decentralized storage payload")
	blob, err := badhub.EncryptBlossomBuffer("secret.txt", plain, "correct-horse-battery-staple")
	if err != nil {
		t.Fatalf("EncryptBlossomBuffer failed: %v", err)
	}

	_, _, err = badhub.DecryptBlossomBuffer(blob, "wrong-password")
	if err == nil {
		t.Fatal("Expected error when decrypting with wrong passphrase, but got nil")
	}
}

func TestBlossom_StreamingChunks(t *testing.T) {
	const chunkSize = 256 * 1024
	const totalChunks = 5
	const dataSize = chunkSize * totalChunks

	source := make([]byte, dataSize)
	_, _ = io.ReadFull(rand.Reader, source)

	passphrase := "stream-key-2026"
	meta := badhub.BlossomMetadata{
		Name:     "video.mov",
		Size:     uint64(dataSize),
		Checksum: "", // will be calculated if needed
	}

	// Compute checksum for metadata
	enc, header, err := badhub.NewBlossomEncryptor(meta, passphrase)
	if err != nil {
		t.Fatalf("NewBlossomEncryptor failed: %v", err)
	}

	var sealedChunks [][]byte
	for i := 0; i < totalChunks; i++ {
		chunkPlain := source[i*chunkSize : (i+1)*chunkSize]
		sealedChunkWithLen, err := enc.EncryptChunk(chunkPlain)
		if err != nil {
			t.Fatalf("EncryptChunk %d failed: %v", i, err)
		}
		// Strip the 4-byte length prefix to test DecryptChunk directly
		sealedChunks = append(sealedChunks, sealedChunkWithLen[4:])
	}

	// Receiver side
	dec, decMeta, headerConsumed, err := badhub.NewBlossomDecryptor(header, passphrase)
	if err != nil {
		t.Fatalf("NewBlossomDecryptor failed: %v", err)
	}
	if headerConsumed != len(header) {
		t.Fatalf("Header consumed mismatch: got %d, expected %d", headerConsumed, len(header))
	}
	if decMeta.Name != meta.Name {
		t.Errorf("Name mismatch: got %s, expected %s", decMeta.Name, meta.Name)
	}

	var reconstructed bytes.Buffer
	for i, sc := range sealedChunks {
		plainChunk, err := dec.DecryptChunk(sc)
		if err != nil {
			t.Fatalf("DecryptChunk %d failed: %v", i, err)
		}
		reconstructed.Write(plainChunk)
	}

	if !bytes.Equal(source, reconstructed.Bytes()) {
		t.Fatal("Streaming reconstructed bytes do not match source!")
	}
}

func TestBlossom_CorruptedEnvelopeRejection(t *testing.T) {
	plain := []byte("integrity test")
	blob, err := badhub.EncryptBlossomBuffer("test.dat", plain, "key123")
	if err != nil {
		t.Fatalf("EncryptBlossomBuffer failed: %v", err)
	}

	// Corrupt magic
	corruptMagic := make([]byte, len(blob))
	copy(corruptMagic, blob)
	corruptMagic[0] = 'X'
	_, _, err = badhub.DecryptBlossomBuffer(corruptMagic, "key123")
	if err != badhub.ErrInvalidMagic {
		t.Errorf("Expected ErrInvalidMagic, got %v", err)
	}

	// Tamper ciphertext
	tampered := make([]byte, len(blob))
	copy(tampered, blob)
	tampered[len(tampered)-5] ^= 0xFF
	_, _, err = badhub.DecryptBlossomBuffer(tampered, "key123")
	if err == nil {
		t.Error("Expected error for tampered ciphertext, got nil")
	}
}
