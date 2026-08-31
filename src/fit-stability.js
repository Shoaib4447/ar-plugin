export class LowPassMeasurement {
  constructor({ alpha = 0.16, maxRelativeStep = 0.08, minStep = 0.0001 } = {}) {
    this.alpha = alpha;
    this.maxRelativeStep = maxRelativeStep;
    this.minStep = minStep;
    this.value = null;
  }

  update(nextValue) {
    if (!Number.isFinite(nextValue)) return this.value;
    if (this.value === null) {
      this.value = nextValue;
      return this.value;
    }

    const maxStep = Math.max(Math.abs(this.value) * this.maxRelativeStep, this.minStep);
    const delta = Math.max(-maxStep, Math.min(maxStep, nextValue - this.value));
    this.value += delta * this.alpha;
    return this.value;
  }

  reset() {
    this.value = null;
  }
}

export class StableFitState {
  constructor({ enterMm = 8, exitMm = 4, holdMs = 360, displayStepMm = 2 } = {}) {
    this.enterMm = enterMm;
    this.exitMm = exitMm;
    this.holdMs = holdMs;
    this.displayStepMm = displayStepMm;
    this.reset();
  }

  desiredState(differenceMm) {
    if (this.fit === "narrow") {
      return differenceMm >= -this.exitMm ? "balanced" : "narrow";
    }
    if (this.fit === "wide") {
      return differenceMm <= this.exitMm ? "balanced" : "wide";
    }
    if (differenceMm < -this.enterMm) return "narrow";
    if (differenceMm > this.enterMm) return "wide";
    return "balanced";
  }

  update(differenceMm, nowMs) {
    if (!Number.isFinite(differenceMm)) return null;
    const desired = this.desiredState(differenceMm);

    if (this.fit === null) {
      this.fit = desired;
    } else if (desired === this.fit) {
      this.pendingFit = null;
    } else if (this.pendingFit !== desired) {
      this.pendingFit = desired;
      this.pendingSince = nowMs;
    } else if (nowMs - this.pendingSince >= this.holdMs) {
      this.fit = desired;
      this.pendingFit = null;
    }

    const absoluteDifference = Math.abs(differenceMm);
    if (this.displayDifferenceMm === null) {
      this.displayDifferenceMm =
        Math.round(absoluteDifference / this.displayStepMm) * this.displayStepMm;
    } else if (
      Math.abs(absoluteDifference - this.displayDifferenceMm) >=
      this.displayStepMm * 1.25
    ) {
      this.displayDifferenceMm =
        Math.round(absoluteDifference / this.displayStepMm) * this.displayStepMm;
    }

    return { fit: this.fit, differenceMm: this.displayDifferenceMm };
  }

  reset() {
    this.fit = null;
    this.pendingFit = null;
    this.pendingSince = 0;
    this.displayDifferenceMm = null;
  }
}
