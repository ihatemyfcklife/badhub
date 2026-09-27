//go:build js && wasm

package main

import (
	"bytes"
	"encoding/hex"
	"fmt"
	"sync"
	"syscall/js"

	"github.com/ihatemyfcklife/badsharing"
)

type activeSenderState struct {
	sender *badsharing.Sender
	meta   *badsharing.FileMetadata
	key    [32]byte
}

type activeReceiverState struct {
	receiver *badsharing.Receiver
	meta     *badsharing.FileMetadata
	destBuf  *bytes.Buffer
	key      [32]byte
}

var (
	stateMu        sync.Mutex
	currentSender  *activeSenderState
	currentRecv    *activeReceiverState
)

func safeJsFunc(fn func(this js.Value, args []js.Value) any) js.Func {
	return js.FuncOf(func(this js.Value, args []js.Value) (res any) {
		defer func() {
			if r := recover(); r != nil {
				res = jsError(fmt.Sprintf("panic: %v", r))
			}
		}()
		return fn(this, args)
	})
}

func main() {
	hub := js.Global().Get("Object").New()

	hub.Set("version", "1.0.0")
	hub.Set("ready", true)
	hub.Set("initSender", safeJsFunc(jsInitSender))
	hub.Set("nextSenderFrame", safeJsFunc(jsNextSenderFrame))
	hub.Set("getSenderStats", safeJsFunc(jsGetSenderStats))
	hub.Set("initReceiver", safeJsFunc(jsInitReceiver))
	hub.Set("ingestReceiverFrame", safeJsFunc(jsIngestReceiverFrame))
	hub.Set("finalizeReceiver", safeJsFunc(jsFinalizeReceiver))
	hub.Set("resetSession", safeJsFunc(jsResetSession))
	hub.Set("deriveKeyHex", safeJsFunc(jsDeriveKeyHex))

	js.Global().Set("BadHub", hub)

	// Keep WebAssembly event loop running
	select {}
}

// jsInitSender(fileName, fileBytesUint8Array, passphrase, redundancyRatio, windowSize)
func jsInitSender(this js.Value, args []js.Value) any {
	if len(args) < 3 {
		return jsError("initSender requires fileName, fileBytes, and passphrase")
	}

	fileName := args[0].String()
	jsBytes := args[1]
	passphrase := args[2].String()

	redundancy := 0.30
	if len(args) > 3 && !args[3].IsNull() && !args[3].IsUndefined() {
		redundancy = args[3].Float()
	}

	windowSize := 32
	if len(args) > 4 && !args[4].IsNull() && !args[4].IsUndefined() {
		windowSize = args[4].Int()
	}

	fileLen := jsBytes.Get("length").Int()
	if fileLen <= 0 {
		return jsError("file is empty")
	}
	fileData := make([]byte, fileLen)
	js.CopyBytesToGo(fileData, jsBytes)

	meta, err := badsharing.NewFileMetadata(fileName, bytes.NewReader(fileData))
	if err != nil {
		return jsError(fmt.Sprintf("failed to create metadata: %v", err))
	}

	key := badsharing.DeriveKeyFromPassphrase(passphrase)

	cfg := badsharing.SessionConfig{
		SessionID:       meta.SessionID,
		SharedKey:       key,
		WindowSize:      windowSize,
		RedundancyRatio: redundancy,
	}

	sender, err := badsharing.NewSender(meta, bytes.NewReader(fileData), cfg)
	if err != nil {
		return jsError(fmt.Sprintf("failed to create sender: %v", err))
	}

	encMetaBytes, err := meta.MarshalEncrypted(key)
	if err != nil {
		return jsError(fmt.Sprintf("failed to seal encrypted metadata: %v", err))
	}

	rawMetaBytes, err := meta.MarshalBinary()
	if err != nil {
		return jsError(fmt.Sprintf("failed to marshal raw metadata: %v", err))
	}

	stateMu.Lock()
	if currentSender != nil {
		currentSender.sender = nil
		currentSender.meta = nil
	}
	currentSender = &activeSenderState{
		sender: sender,
		meta:   meta,
		key:    key,
	}
	stateMu.Unlock()

	jsEncMeta := js.Global().Get("Uint8Array").New(len(encMetaBytes))
	js.CopyBytesToJS(jsEncMeta, encMetaBytes)

	jsRawMeta := js.Global().Get("Uint8Array").New(len(rawMetaBytes))
	js.CopyBytesToJS(jsRawMeta, rawMetaBytes)

	res := js.Global().Get("Object").New()
	res.Set("success", true)
	res.Set("sessionID", fmt.Sprintf("%016x", meta.SessionID))
	res.Set("name", meta.Name)
	res.Set("size", float64(meta.Size))
	res.Set("checksum", hex.EncodeToString(meta.Checksum[:]))
	res.Set("chunkSize", int(meta.ChunkSize))
	res.Set("totalChunks", float64(meta.TotalChunks))
	res.Set("encryptedMetadata", jsEncMeta)
	res.Set("rawMetadata", jsRawMeta)

	return res
}

// jsNextSenderFrame() -> { frame: Uint8Array, eof: bool, error: string }
func jsNextSenderFrame(this js.Value, args []js.Value) any {
	stateMu.Lock()
	s := currentSender
	stateMu.Unlock()

	if s == nil || s.sender == nil {
		return jsError("sender is not initialized")
	}

	frame, eof, err := s.sender.NextFrame()
	if err != nil {
		return jsError(fmt.Sprintf("NextFrame error: %v", err))
	}

	res := js.Global().Get("Object").New()
	res.Set("eof", eof)

	if frame != nil {
		jsFrame := js.Global().Get("Uint8Array").New(len(frame))
		js.CopyBytesToJS(jsFrame, frame)
		res.Set("frame", jsFrame)
	} else {
		res.Set("frame", js.Null())
	}

	return res
}

// jsGetSenderStats() -> { dataPackets: number, parityPackets: number }
func jsGetSenderStats(this js.Value, args []js.Value) any {
	stateMu.Lock()
	s := currentSender
	stateMu.Unlock()

	if s == nil || s.sender == nil {
		return jsError("sender is not initialized")
	}

	dataPackets, parityPackets := s.sender.Stats()
	res := js.Global().Get("Object").New()
	res.Set("dataPackets", float64(dataPackets))
	res.Set("parityPackets", float64(parityPackets))
	return res
}

// jsInitReceiver(metadataUint8Array, passphrase) -> { name, size, checksum, totalChunks, sessionID }
func jsInitReceiver(this js.Value, args []js.Value) any {
	if len(args) < 2 {
		return jsError("initReceiver requires metadataBytes and passphrase")
	}

	jsMetaBytes := args[0]
	passphrase := args[1].String()

	metaLen := jsMetaBytes.Get("length").Int()
	if metaLen <= 0 {
		return jsError("metadata is empty")
	}
	metaBytes := make([]byte, metaLen)
	js.CopyBytesToGo(metaBytes, jsMetaBytes)

	key := badsharing.DeriveKeyFromPassphrase(passphrase)
	var meta badsharing.FileMetadata

	// Attempt encrypted unmarshaling first; fallback to plaintext
	if bytes.HasPrefix(metaBytes, badsharing.MagicEncryptedHeader[:]) {
		if err := meta.UnmarshalEncrypted(metaBytes, key); err != nil {
			return jsError(fmt.Sprintf("failed to decrypt metadata (wrong passphrase or corrupted): %v", err))
		}
	} else if bytes.HasPrefix(metaBytes, badsharing.MagicHeader[:]) {
		if err := meta.UnmarshalBinary(metaBytes); err != nil {
			return jsError(fmt.Sprintf("failed to parse metadata: %v", err))
		}
	} else {
		return jsError("invalid metadata header format")
	}

	destBuf := &bytes.Buffer{}
	cfg := badsharing.SessionConfig{
		SessionID:  meta.SessionID,
		SharedKey:  key,
		WindowSize: 32,
	}

	receiver, err := badsharing.NewReceiver(&meta, destBuf, cfg)
	if err != nil {
		return jsError(fmt.Sprintf("failed to initialize receiver: %v", err))
	}

	stateMu.Lock()
	if currentRecv != nil {
		if currentRecv.destBuf != nil {
			currentRecv.destBuf.Reset()
			currentRecv.destBuf = nil
		}
		currentRecv.receiver = nil
		currentRecv.meta = nil
	}
	currentRecv = &activeReceiverState{
		receiver: receiver,
		meta:     &meta,
		destBuf:  destBuf,
		key:      key,
	}
	stateMu.Unlock()

	res := js.Global().Get("Object").New()
	res.Set("success", true)
	res.Set("sessionID", fmt.Sprintf("%016x", meta.SessionID))
	res.Set("name", meta.Name)
	res.Set("size", float64(meta.Size))
	res.Set("checksum", hex.EncodeToString(meta.Checksum[:]))
	res.Set("totalChunks", float64(meta.TotalChunks))

	return res
}

// jsIngestReceiverFrame(frameUint8Array) -> { completed, bytesReceived, totalBytes, percent, framesReceived, framesDropped }
func jsIngestReceiverFrame(this js.Value, args []js.Value) any {
	if len(args) < 1 {
		return jsError("ingestReceiverFrame requires frame bytes")
	}

	stateMu.Lock()
	r := currentRecv
	stateMu.Unlock()

	if r == nil || r.receiver == nil {
		return jsError("receiver is not initialized")
	}

	jsFrame := args[0]
	frameLen := jsFrame.Get("length").Int()
	if frameLen == 0 {
		return jsError("frame is empty")
	}
	frame := make([]byte, frameLen)
	js.CopyBytesToGo(frame, jsFrame)

	completed, err := r.receiver.IngestFrame(frame)
	rxFrames, dropFrames := r.receiver.Stats()
	bytesReceived, totalBytes, percent := r.receiver.Progress()

	res := js.Global().Get("Object").New()
	res.Set("completed", completed)
	res.Set("bytesReceived", float64(bytesReceived))
	res.Set("totalBytes", float64(totalBytes))
	res.Set("percent", percent)
	res.Set("framesReceived", float64(rxFrames))
	res.Set("framesDropped", float64(dropFrames))

	if err != nil {
		res.Set("error", err.Error())
	} else {
		res.Set("error", js.Null())
	}

	return res
}

// jsFinalizeReceiver() -> { success: bool, data: Uint8Array, name: string, size: number, checksum: string }
func jsFinalizeReceiver(this js.Value, args []js.Value) any {
	stateMu.Lock()
	r := currentRecv
	stateMu.Unlock()

	if r == nil || r.receiver == nil {
		return jsError("receiver is not initialized")
	}

	if err := r.receiver.Close(); err != nil {
		return jsError(fmt.Sprintf("file verification failed: %v", err))
	}

	fileBytes := r.destBuf.Bytes()
	jsFile := js.Global().Get("Uint8Array").New(len(fileBytes))
	js.CopyBytesToJS(jsFile, fileBytes)

	res := js.Global().Get("Object").New()
	res.Set("success", true)
	res.Set("name", r.meta.Name)
	res.Set("size", float64(r.meta.Size))
	res.Set("checksum", hex.EncodeToString(r.meta.Checksum[:]))
	res.Set("data", jsFile)

	// Release internal buffer memory to let GC collect
	r.destBuf.Reset()

	return res
}

// jsResetSession()
func jsResetSession(this js.Value, args []js.Value) any {
	stateMu.Lock()
	if currentSender != nil {
		currentSender.sender = nil
		currentSender.meta = nil
		currentSender = nil
	}
	if currentRecv != nil {
		if currentRecv.destBuf != nil {
			currentRecv.destBuf.Reset()
			currentRecv.destBuf = nil
		}
		currentRecv.receiver = nil
		currentRecv.meta = nil
		currentRecv = nil
	}
	stateMu.Unlock()

	res := js.Global().Get("Object").New()
	res.Set("success", true)
	return res
}

// jsDeriveKeyHex(passphrase) -> hex string
func jsDeriveKeyHex(this js.Value, args []js.Value) any {
	if len(args) < 1 {
		return jsError("deriveKeyHex requires passphrase")
	}
	passphrase := args[0].String()
	key := badsharing.DeriveKeyFromPassphrase(passphrase)
	return hex.EncodeToString(key[:])
}

func jsError(msg string) js.Value {
	res := js.Global().Get("Object").New()
	res.Set("success", false)
	res.Set("error", msg)
	return res
}
