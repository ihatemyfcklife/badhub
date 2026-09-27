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

func TestBadHub_PacketLossResilience(t *testing.T) {
	const payloadSize = 64 * 1024
	sourceData := make([]byte, payloadSize)
	_, _ = io.ReadFull(rand.Reader, sourceData)

	meta, err := badsharing.NewFileMetadata("loss-test.bin", bytes.NewReader(sourceData))
	if err != nil {
		t.Fatalf("NewFileMetadata failed: %v", err)
	}

	passphrase := "resilience-test-password"
	key := badsharing.DeriveKeyFromPassphrase(passphrase)

	cfg := badsharing.SessionConfig{
		SessionID:       meta.SessionID,
		SharedKey:       key,
		WindowSize:      32,
		RedundancyRatio: 0.50, // 50% parity overhead
	}

	sender, err := badsharing.NewSender(meta, bytes.NewReader(sourceData), cfg)
	if err != nil {
		t.Fatalf("NewSender failed: %v", err)
	}

	encMeta, err := meta.MarshalEncrypted(key)
	if err != nil {
		t.Fatalf("MarshalEncrypted failed: %v", err)
	}

	var parsedMeta badsharing.FileMetadata
	if err := parsedMeta.UnmarshalEncrypted(encMeta, key); err != nil {
		t.Fatalf("UnmarshalEncrypted failed: %v", err)
	}

	var destBuf bytes.Buffer
	receiver, err := badsharing.NewReceiver(&parsedMeta, &destBuf, cfg)
	if err != nil {
		t.Fatalf("NewReceiver failed: %v", err)
	}

	totalEmitted := 0
	droppedFrames := 0
	receivedFrames := 0

	for {
		frame, eof, err := sender.NextFrame()
		if err != nil {
			t.Fatalf("NextFrame failed: %v", err)
		}
		if eof {
			break
		}
		totalEmitted++

		// Drop 1 out of every 5 frames (20% loss rate)
		if totalEmitted%5 == 0 {
			droppedFrames++
			continue
		}

		receivedFrames++
		done, err := receiver.IngestFrame(frame)
		if err != nil {
			t.Fatalf("IngestFrame failed on valid frame: %v", err)
		}
		if done {
			break
		}
	}

	if err := receiver.Close(); err != nil {
		t.Fatalf("receiver.Close failed after loss recovery: %v", err)
	}

	if !bytes.Equal(destBuf.Bytes(), sourceData) {
		t.Fatalf("reconstructed data does not match original under 20%% loss")
	}

	t.Logf("Loss Resilience Test Passed: Emitted=%d, Dropped=%d, Ingested=%d", totalEmitted, droppedFrames, receivedFrames)
}

func TestBadHub_WrongPassphraseRejection(t *testing.T) {
	sourceData := []byte("secret content to protect with encryption")
	meta, err := badsharing.NewFileMetadata("auth.txt", bytes.NewReader(sourceData))
	if err != nil {
		t.Fatalf("NewFileMetadata failed: %v", err)
	}

	correctKey := badsharing.DeriveKeyFromPassphrase("correct-password")
	wrongKey := badsharing.DeriveKeyFromPassphrase("wrong-password")

	encMeta, err := meta.MarshalEncrypted(correctKey)
	if err != nil {
		t.Fatalf("MarshalEncrypted failed: %v", err)
	}

	var parsedMeta badsharing.FileMetadata
	err = parsedMeta.UnmarshalEncrypted(encMeta, wrongKey)
	if err == nil {
		t.Fatalf("Expected UnmarshalEncrypted to fail with wrong passphrase, but it succeeded")
	}
}

func TestBadHub_CorruptedFrameSafety(t *testing.T) {
	sourceData := []byte("testing corrupted packet rejection")
	meta, err := badsharing.NewFileMetadata("corrupt.txt", bytes.NewReader(sourceData))
	if err != nil {
		t.Fatalf("NewFileMetadata failed: %v", err)
	}

	key := badsharing.DeriveKeyFromPassphrase("safe-corrupt-pass")
	cfg := badsharing.SessionConfig{
		SessionID:  meta.SessionID,
		SharedKey:  key,
		WindowSize: 32,
	}

	var destBuf bytes.Buffer
	receiver, err := badsharing.NewReceiver(meta, &destBuf, cfg)
	if err != nil {
		t.Fatalf("NewReceiver failed: %v", err)
	}

	// Ingest garbage frame of wrong size
	garbageFrame := []byte{0x00, 0x01, 0x02, 0x03}
	done, err := receiver.IngestFrame(garbageFrame)
	if err == nil && done {
		t.Fatalf("Expected ingest of garbage frame to fail or not complete")
	}

	// Ingest garbage frame of exact 1380 bytes
	garbage1380 := make([]byte, 1380)
	_, _ = io.ReadFull(rand.Reader, garbage1380)
	done, err = receiver.IngestFrame(garbage1380)
	if done {
		t.Fatalf("IngestFrame unexpectedly completed on random noise")
	}

	rx, dropped := receiver.Stats()
	t.Logf("Corrupted frames handled safely: rx=%d, dropped=%d", rx, dropped)
}
