/** A successful HTTP response may still contain a truncated generated WAV. */
export function assertWavComplete(response: Response, required = false): string | null {
  const raw = response.headers.get("x-speech-stop");
  if (raw === null) {
    if (required) throw Error("TTS WAV is missing X-Speech-Stop completion evidence");
    return null;
  }
  const stop = raw.trim();
  if (stop !== "complete") {
    const reason = /^[a-z_]{1,48}$/i.test(stop) ? stop : "unknown";
    throw Error("TTS generation incomplete: " + reason);
  }
  return stop;
}

export function wavInfo(bytes: Uint8Array, totalBytes = bytes.byteLength) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    b.length < 44 ||
    b.toString("ascii", 0, 4) !== "RIFF" ||
    b.toString("ascii", 8, 12) !== "WAVE"
  )
    throw Error("Invalid WAV");
  let fmt: any = null,
    dataOffset = 0,
    dataSize = 0;
  for (let at = 12; at + 8 <= b.length;) {
    const size = b.readUInt32LE(at + 4),
      kind = b.toString("ascii", at, at + 4);
    if (kind === "fmt ") {
      if (size < 16 || at + 24 > b.length) throw Error("Invalid WAV format");
      fmt = {
        format: b.readUInt16LE(at + 8),
        channels: b.readUInt16LE(at + 10),
        sampleRate: b.readUInt32LE(at + 12),
        bits: b.readUInt16LE(at + 22),
      };
      if (fmt.format === 0xfffe) {
        if (size < 40 || at + 48 > b.length)
          throw Error("Invalid extensible WAV");
        fmt.format = b.readUInt16LE(at + 32);
      }
    }
    if (kind === "data") {
      dataOffset = at + 8;
      dataSize = Math.min(size, totalBytes - dataOffset);
      break;
    }
    at += 8 + size + (size % 2);
  }
  if (
    !fmt ||
    !dataOffset ||
    ![1, 3].includes(fmt.format) ||
    !(fmt.format === 1 ? [16, 24, 32] : [32, 64]).includes(fmt.bits) ||
    fmt.channels < 1 ||
    fmt.channels > 8 ||
    fmt.sampleRate < 4000 ||
    fmt.sampleRate > 192000
  )
    throw Error("Unsupported WAV");
  const frames = Math.floor(dataSize / ((fmt.channels * fmt.bits) / 8));
  return {
    ...fmt,
    dataOffset,
    dataSize,
    frames,
    durationMs: (frames / fmt.sampleRate) * 1000,
  };
}
export function vocalEnvelope(bytes: Uint8Array) {
  const info = wavInfo(bytes),
    b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    window = Math.max(1, Math.round(info.sampleRate * 0.04)),
    samples: number[] = [];
  for (let frame = 0; frame < info.frames; frame += window) {
    let sum = 0,
      count = 0;
    for (let f = frame; f < Math.min(frame + window, info.frames); f++) {
      let sample = 0;
      for (let c = 0; c < info.channels; c++) {
        const offset =
          info.dataOffset + ((f * info.channels + c) * info.bits) / 8;
        sample +=
          info.format === 3
            ? info.bits === 64
              ? b.readDoubleLE(offset)
              : b.readFloatLE(offset)
            : info.bits === 16
              ? b.readInt16LE(offset) / 32768
              : info.bits === 24
                ? b.readIntLE(offset, 3) / 8388608
                : b.readInt32LE(offset) / 2147483648;
      }
      sample /= info.channels;
      if (!Number.isFinite(sample)) throw Error("Non-finite vocal audio");
      sum += sample * sample;
      count++;
    }
    samples.push(Math.min(1, Math.sqrt(sum / Math.max(1, count)) * 4));
  }
  return { stepMs: 40, samples };
}
