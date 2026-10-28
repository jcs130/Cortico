/** Chunked WAV -> scheduled PCM; no SSE audio, no full-utterance wait. */
export async function playSpeech({
  url,
  context,
  signal,
  onStart,
  onEnd,
  onLevel,
  onStats,
  fetchAudio = fetch,
  volume = 1,
}) {
  const startClock = performance.now();
  const response = await fetchAudio(url, { signal });
  if (!response.ok || !response.body)
    throw Error("Speech stream HTTP " + response.status);
  const reader = response.body.getReader();
  let header = new Uint8Array(),
    ready = false,
    sampleRate = 0,
    byteTail = null,
    pending = [],
    pendingSamples = 0,
    started = false,
    finished = false,
    firstAt = 0,
    nextAt = 0,
    active = 0,
    totalSamples = 0,
    underruns = 0;
  const nodes = new Set();
  const gain = context.createGain?.(); if (gain) { gain.gain.value = volume; gain.connect(context.destination); }
  let killed = false,
    ended = false,
    firstLatencyMs = null,
    complete;
  const completion = new Promise((resolve) => {
    complete = resolve;
  });
  const stats = () => ({
    prebufferMs: 480,
    firstPlaybackMs: firstLatencyMs,
    samples: totalSamples,
    sampleRate,
    underruns,
  });
  function stop() {
    killed = true;
    pending = [];
    pendingSamples = 0;
    for (const node of nodes)
      try {
        node.stop();
      } catch {}
    nodes.clear();
    void reader.cancel().catch(() => {});
    onLevel?.(0);
    onStats?.({
      ...stats(),
      cancelled: true,
      activeSources: 0,
      bufferedSamples: 0,
    });
    complete(stats());
  }
  const finish = () => {
    if (finished && active === 0 && started && !killed && !ended) {
      ended = true;
      onLevel?.(0);
      onStats?.(stats());
      onEnd?.();
      complete(stats());
    }
  };
  signal.addEventListener("abort", stop, { once: true });
  const drain = () => {
    if (killed) return;
    if (!started && pendingSamples < Math.round(sampleRate * 0.48) && !finished)
      return;
    if (!started && pendingSamples) {
      started = true;
      firstAt = context.currentTime + 0.05;
      nextAt = firstAt;
      const wait = setInterval(() => {
        if (killed) {
          clearInterval(wait);
          return;
        }
        if (context.currentTime >= firstAt && context.state === "running") {
          clearInterval(wait);
          firstLatencyMs = performance.now() - startClock;
          onStart?.();
          onStats?.(stats());
        }
      }, 10);
    }
    while (started && pending.length) {
      const samples = pending.shift();
      pendingSamples -= samples.length;
      const buffer = context.createBuffer(1, samples.length, sampleRate);
      buffer.copyToChannel(samples, 0);
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.connect(gain ?? context.destination);
      if (nextAt < context.currentTime) {
        underruns++;
        nextAt = context.currentTime + 0.02;
      }
      const at = nextAt;
      nextAt += samples.length / sampleRate;
      active++;
      nodes.add(node);
      node.onended = () => {
        active--;
        nodes.delete(node);
        finish();
      };
      node.start(at);
      let rms = 0;
      for (const v of samples) rms += v * v;
      setTimeout(
        () => {
          if (!killed)
            onLevel?.(Math.min(1, Math.sqrt(rms / samples.length) * 4));
        },
        Math.max(0, (at - context.currentTime) * 1000),
      );
    }
    if (finished && !started && !killed)
      throw Error("Speech stream contained no samples");
    finish();
  };
  const pcm = (bytes) => {
    if (byteTail !== null) {
      const all = new Uint8Array(bytes.length + 1);
      all[0] = byteTail;
      all.set(bytes, 1);
      bytes = all;
      byteTail = null;
    }
    if (bytes.length % 2) {
      byteTail = bytes[bytes.length - 1];
      bytes = bytes.subarray(0, -1);
    }
    if (!bytes.length) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      samples = new Float32Array(bytes.length / 2);
    for (let i = 0; i < samples.length; i++)
      samples[i] = view.getInt16(i * 2, true) / 32768;
    pending.push(samples);
    pendingSamples += samples.length;
    totalSamples += samples.length;
    drain();
  };
  try {
    while (!signal.aborted) {
      const part = await reader.read();
      if (part.done) break;
      let bytes = part.value;
      if (!ready) {
        const all = new Uint8Array(header.length + bytes.length);
        all.set(header);
        all.set(bytes, header.length);
        header = all;
        if (header.length < 12) continue;
        const view = new DataView(header.buffer),
          ascii = (a, b) => String.fromCharCode(...header.subarray(a, b));
        if (ascii(0, 4) !== "RIFF" || ascii(8, 12) !== "WAVE")
          throw Error("TTS did not return RIFF WAV");
        let fmt = null,
          offset = -1;
        for (let at = 12; at + 8 <= header.length;) {
          const size = view.getUint32(at + 4, true),
            kind = ascii(at, at + 4);
          if (kind === "data") {
            offset = at + 8;
            break;
          }
          if (at + 8 + size > header.length) break;
          if (kind === "fmt ") {
            if (size < 16) throw Error("Invalid WAV format");
            fmt = {
              format: view.getUint16(at + 8, true),
              channels: view.getUint16(at + 10, true),
              sampleRate: view.getUint32(at + 12, true),
              bits: view.getUint16(at + 22, true),
            };
          }
          at += 8 + size + (size % 2);
        }
        if (offset < 0) {
          if (header.length > 65536) throw Error("Oversized WAV header");
          continue;
        }
        if (
          !fmt ||
          fmt.format !== 1 ||
          fmt.channels !== 1 ||
          fmt.bits !== 16 ||
          !Number.isInteger(fmt.sampleRate) ||
          fmt.sampleRate < 8000 ||
          fmt.sampleRate > 96000
        )
          throw Error("TTS requires 8–96kHz mono PCM16 WAV");
        sampleRate = fmt.sampleRate;
        ready = true;
        bytes = header.subarray(offset);
        header = new Uint8Array();
      }
      pcm(bytes);
    }
    if (signal.aborted) return stop();
    finished = true;
    drain();
    if (byteTail !== null) throw Error("Truncated PCM sample");
    return await completion;
  } catch (e) {
    stop();
    if (!signal.aborted) throw e;
  } finally {
    gain?.disconnect();
    signal.removeEventListener("abort", stop);
  }
}
