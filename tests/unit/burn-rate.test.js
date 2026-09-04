import { describe, it, expect } from "vitest";
import {
  computeBurnRate,
  formatBurnRateLabel,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

describe("computeBurnRate", () => {
  it("returns null for non-positive remaining (unlimited/∞)", () => {
    expect(computeBurnRate(0, [1, 2, 3])).toBeNull();
    expect(computeBurnRate(null, [1, 2, 3])).toBeNull();
    expect(computeBurnRate("∞", [1, 2, 3])).toBeNull();
  });

  it("flags insufficient data when fewer than 3 active days", () => {
    const b = computeBurnRate(100, [0, 0, 5]);
    expect(b.insufficientData).toBe(true);
    expect(b.activeDays).toBe(1);
  });

  it("flags insufficient data on an empty window", () => {
    const b = computeBurnRate(100, []);
    expect(b.insufficientData).toBe(true);
  });

  it("computes a stable single value when daily rate is constant", () => {
    const b = computeBurnRate(100, [10, 10, 10, 10, 10]);
    expect(b.insufficientData).toBe(false);
    expect(b.low).toBe(10);
    expect(b.high).toBe(10);
    expect(b.median).toBe(10);
  });

  it("returns a widening range for volatile daily usage", () => {
    const b = computeBurnRate(100, [5, 10, 15, 20]);
    expect(b.insufficientData).toBe(false);
    expect(b.low).toBeLessThanOrEqual(b.high);
    // p75 = 16.25 → low = round(100/16.25) = 6
    // p25 = 8.75  → high = round(100/8.75) = 11
    expect(b.low).toBe(6);
    expect(b.high).toBe(11);
  });

  it("never returns a day range below 1", () => {
    const b = computeBurnRate(1, [100, 100, 100]);
    expect(b.low).toBe(1);
    expect(b.high).toBe(1);
  });
});

describe("formatBurnRateLabel", () => {
  it("renders a dash for insufficient data", () => {
    expect(formatBurnRateLabel({ insufficientData: true })).toBe("—");
    expect(formatBurnRateLabel(null)).toBe("—");
  });

  it("renders a range", () => {
    expect(formatBurnRateLabel({ low: 5, high: 20, insufficientData: false })).toBe("≈ 5–20 days");
  });

  it("renders a single day when low equals high", () => {
    expect(formatBurnRateLabel({ low: 10, high: 10, insufficientData: false })).toBe("≈ 10 days");
  });

  it("renders singular day", () => {
    expect(formatBurnRateLabel({ low: 1, high: 1, insufficientData: false })).toBe("≈ 1 day");
  });
});
