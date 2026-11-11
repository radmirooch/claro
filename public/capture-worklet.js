class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.position = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input)
      for (const value of input) {
        this.buffer[this.position++] = value;
        if (this.position === this.buffer.length) {
          this.port.postMessage(this.buffer, [this.buffer.buffer]);
          this.buffer = new Float32Array(2048);
          this.position = 0;
        }
      }
    return true;
  }
}
registerProcessor('capture', Capture);
