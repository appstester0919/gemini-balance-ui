/**
 * Client-side audio helpers.
 *
 * Why this file exists:
 * - Gemini TTS returns raw L16 PCM at 24kHz, base64-encoded. Browsers can't
 *   play raw PCM via <audio>, so we wrap it in a WAV header on the fly.
 * - MediaRecorder gives us a Blob (webm/opus). We need it as base64 to send
 *   to the backend.
 * - Uploaded files need to be base64 too.
 */

/**
 * Wrap raw L16 PCM (base64-encoded) in a minimal WAV header so the browser
 * can play it via an <audio> element with a Blob URL.
 *
 * PCM is little-endian, 16-bit signed. Default sample rate is 24000 Hz,
 * which is what the Deno proxy returns for Gemini TTS.
 */
export function wrapPcmInWav(pcmBase64: string, sampleRate = 24000): Blob {
  const bytes = base64ToBytes(pcmBase64);

  // WAV header layout (44 bytes for PCM mono):
  //   0..3   "RIFF"
  //   4..7   file size - 8 (uint32 LE)
  //   8..11  "WAVE"
  //  12..15  "fmt "
  //  16..19  subchunk1 size = 16 (uint32 LE)
  //  20..21  audio format = 1 (PCM) (uint16 LE)
  //  22..23  num channels = 1 (uint16 LE)
  //  24..27  sample rate (uint32 LE)
  //  28..31  byte rate = sampleRate * numChannels * bitsPerSample/8 (uint32 LE)
  //  32..33  block align = numChannels * bitsPerSample/8 (uint16 LE)
  //  34..35  bits per sample = 16 (uint16 LE)
  //  36..39  "data"
  //  40..43  data size (uint32 LE)
  //  44..    raw PCM samples
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = bytes.byteLength;
  const fileSize = 36 + dataSize;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // Helper: write 4 ASCII chars at offset (for "RIFF", "WAVE", "fmt ", "data").
  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  // RIFF chunk descriptor
  writeAscii(0, "RIFF");
  view.setUint32(4, fileSize, true);
  writeAscii(8, "WAVE");

  // fmt sub-chunk
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);            // subchunk1 size for PCM
  view.setUint16(20, 1, true);             // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data sub-chunk
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  // PCM samples
  new Uint8Array(buffer, 44).set(bytes);

  return new Blob([buffer], { type: "audio/wav" });
}

/** Decode base64 string (no data URL prefix) to a Uint8Array. */
export function base64ToBytes(b64: string): Uint8Array {
  // atob is available in both browser and modern Node; works in 'use client' pages.
  const binary = atob(b64);
  const len = binary.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/** Convert a Blob (from MediaRecorder or file input) to a base64 string. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // Chunk to avoid call-stack overflow on large audio files.
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk)),
    );
  }
  return btoa(binary);
}

/** Convert a File (from <input type=file>) to a base64 string. */
export async function fileToBase64(file: File): Promise<string> {
  return blobToBase64(file);
}

/** Convert a File to a {data, mimeType} pair for the proxy payload. */
export async function fileToAudioPayload(
  file: File,
): Promise<{ data: string; mimeType: string }> {
  const data = await fileToBase64(file);
  return { data, mimeType: file.type || "audio/webm" };
}

/** Browser support check for MediaRecorder (used by <AudioRecorder>). */
export function isMediaRecorderSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia
  );
}
