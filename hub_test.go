package badhub_test

import (
	"bytes"
	"crypto/rand"
	"io"
	"testing"

	"github.com/ihatemyfcklife/badsharing"
)

func TestBadHub_EndToEndP2PWorkflow(t *testing.T) {
	const payloadSize = 64 * 1024 // 64 KB
	sourceData := make([]byte, payloadSize)
	_, _ = io.ReadFull(rand.Reader, sourceData)

	meta, err := badsharing.NewFileMetadata("test-payload.bin", bytes.NewReader(sourceData))
	if err != nil {
		t.Fatalf("NewFileMetadata failed: %v", err)
	}

	passphrase := "badhub-integration-secret-test"
	key := badsharing.DeriveKeyFromPassphrase(passphrase)

	cfg := badsharing.SessionConfig{
		SessionID:       meta.SessionID,
		SharedKey:       key,
		WindowSize:      32,
		RedundancyRatio: 0.30,
	}

	// 1. Sender setup
	sender, err := badsharing.NewSender(meta, bytes.NewReader(sourceData), cfg)
	if err != nil {
		t.Fatalf("NewSender failed: %v", err)
	}

	// 2. Encrypt metadata
	encMeta, err := meta.MarshalEncrypted(key)
	if err != nil {
		t.Fatalf("MarshalEncrypted failed: %v", err)
	}

	// 3. Receiver setup from encrypted metadata
	var parsedMeta badsharing.FileMetadata
	if err := parsedMeta.UnmarshalEncrypted(encMeta, key); err != nil {
		t.Fatalf("UnmarshalEncrypted failed: %v", err)
	}

	if parsedMeta.SessionID != meta.SessionID {
		t.Fatalf("SessionID mismatch: expected %x, got %x", meta.SessionID, parsedMeta.SessionID)
	}

	var destBuf bytes.Buffer
	receiver, err := badsharing.NewReceiver(&parsedMeta, &destBuf, cfg)
	if err != nil {
		t.Fatalf("NewReceiver failed: %v", err)
	}

	// 4. Stream frames from sender to receiver
	totalFrames := 0
	for {
		frame, eof, err := sender.NextFrame()
		if err != nil {
			t.Fatalf("NextFrame failed: %v", err)
		}
		if eof {
			break
		}
		totalFrames++
		done, err := receiver.IngestFrame(frame)
		if err != nil {
			t.Fatalf("IngestFrame error: %v", err)
		}
		if done {
			break
		}
	}

	// 5. Finalize receiver
	if err := receiver.Close(); err != nil {
		t.Fatalf("receiver.Close failed: %v", err)
	}

	if !bytes.Equal(destBuf.Bytes(), sourceData) {
		t.Fatalf("reconstructed data does not match original source data")
	}

	t.Logf("BadHub P2P Pipeline Verified: TotalFrames=%d, BitExact=100%%", totalFrames)
}
