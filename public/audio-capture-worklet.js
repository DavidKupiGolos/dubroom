class DubroomPcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.remainingFrames = 0;
    this.buffer = new Float32Array(2048);
    this.bufferedFrames = 0;
    this.port.onmessage = (event) => {
      if (event.data?.type === "start") {
        this.recording = true;
        this.remainingFrames = Math.max(1, Number(event.data.frames) || 1);
        this.bufferedFrames = 0;
      } else if (event.data?.type === "stop") {
        this.finish();
      }
    };
  }

  flush() {
    if (!this.bufferedFrames) return;
    const chunk = this.buffer.slice(0, this.bufferedFrames);
    this.port.postMessage({ type: "chunk", samples: chunk }, [chunk.buffer]);
    this.bufferedFrames = 0;
  }

  finish() {
    if (!this.recording) return;
    this.flush();
    this.recording = false;
    this.remainingFrames = 0;
    this.port.postMessage({ type: "stopped", sampleRate });
  }

  process(inputs, outputs) {
    const output = outputs[0]?.[0];
    if (output) output.fill(0);
    if (!this.recording) return true;
    const input = inputs[0]?.[0];
    if (!input) return true;
    let offset = 0;
    while (offset < input.length && this.remainingFrames > 0) {
      const count = Math.min(input.length - offset, this.buffer.length - this.bufferedFrames, this.remainingFrames);
      this.buffer.set(input.subarray(offset, offset + count), this.bufferedFrames);
      this.bufferedFrames += count;
      this.remainingFrames -= count;
      offset += count;
      if (this.bufferedFrames === this.buffer.length) this.flush();
    }
    if (this.remainingFrames <= 0) this.finish();
    return true;
  }
}

registerProcessor("dubroom-pcm-recorder", DubroomPcmRecorder);
