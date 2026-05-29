export function floatToPcm16(input: Float32Array): Uint8Array {
  const out = new Uint8Array(input.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return out;
}
export function pcm16ToFloat(input: Uint8Array): Float32Array<ArrayBuffer> {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const out = new Float32Array(input.byteLength / 2);
  for (let i = 0; i < out.length; i += 1)
    out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}
