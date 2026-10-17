// Thin wrapper around an <audio> element that supports a playback region.

export class Player {
  constructor() {
    this.audio = new Audio();
    this.region = null; // { start, end } in seconds
    this.loop = false;
    this.onTick = () => {};
  }

  load(url) {
    this.audio.src = url;
    this.region = null;
  }

  get duration() { return this.audio.duration || 0; }
  get time() { return this.audio.currentTime; }
  get playing() { return !this.audio.paused; }

  play() {
    // If outside the region, jump to its start.
    if (this.region && (this.time < this.region.start || this.time >= this.region.end)) {
      this.audio.currentTime = this.region.start;
    }
    this.audio.play();
    requestAnimationFrame(this.#tick);
  }

  pause() { this.audio.pause(); }
  toggle() { this.playing ? this.pause() : this.play(); }

  stop() {
    this.pause();
    this.seek(this.region ? this.region.start : 0);
  }

  seek(seconds) {
    this.audio.currentTime = seconds;
    this.onTick(this.time);
  }

  setRegion(region) { this.region = region; }

  // Animation-frame loop: updates UI and enforces region end/loop.
  #tick = () => {
    if (this.region && this.time >= this.region.end) {
      if (this.loop) this.audio.currentTime = this.region.start;
      else { this.pause(); this.audio.currentTime = this.region.end; }
    }
    this.onTick(this.time);
    if (this.playing) requestAnimationFrame(this.#tick);
  };
}
