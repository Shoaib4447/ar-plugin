import assert from "node:assert/strict";
import { LowPassMeasurement, StableFitState } from "../src/fit-stability.js";

const measurement = new LowPassMeasurement({ alpha: 0.2, maxRelativeStep: 0.1 });
assert.equal(measurement.update(100), 100);
assert.equal(measurement.update(200), 102);
assert.ok(measurement.update(101) < 102);

const state = new StableFitState({ enterMm: 8, exitMm: 4, holdMs: 360 });
assert.equal(state.update(5, 0).fit, "balanced");
for (const [difference, time] of [[9, 50], [7, 150], [9, 250], [7, 350]]) {
  assert.equal(state.update(difference, time).fit, "balanced");
}
assert.equal(state.update(10, 500).fit, "balanced");
assert.equal(state.update(10, 900).fit, "wide");
assert.equal(state.update(6, 1000).fit, "wide");
assert.equal(state.update(3, 1100).fit, "wide");
assert.equal(state.update(3, 1500).fit, "balanced");

const displayState = new StableFitState();
assert.equal(displayState.update(9.1, 0).differenceMm, 10);
assert.equal(displayState.update(8.8, 100).differenceMm, 10);
assert.equal(displayState.update(9.4, 200).differenceMm, 10);

console.log("Fit stability tests passed.");
