import { describe, it, expect } from "vitest";
import { assignQuadrant } from "./quadrant";

describe("assignQuadrant", () => {
  it("assigns the four open quadrants correctly", () => {
    expect(assignQuadrant(1, 1)).toBe("Q1");
    expect(assignQuadrant(-1, 1)).toBe("Q2");
    expect(assignQuadrant(-1, -1)).toBe("Q3");
    expect(assignQuadrant(1, -1)).toBe("Q4");
  });

  it("boundary policy: zero is always grouped with the positive side", () => {
    expect(assignQuadrant(0, 1)).toBe("Q1"); // x=0 -> right
    expect(assignQuadrant(0, -1)).toBe("Q4"); // x=0 -> right, y<0 -> lower
    expect(assignQuadrant(1, 0)).toBe("Q1"); // y=0 -> upper
    expect(assignQuadrant(-1, 0)).toBe("Q2"); // y=0 -> upper, x<0 -> left
    expect(assignQuadrant(0, 0)).toBe("Q1"); // both zero -> right+upper
  });
});
