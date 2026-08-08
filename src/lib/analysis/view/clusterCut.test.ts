import { describe, it, expect } from "vitest";
import { cutClusters, computeCentroids } from "./clusterCut";
import { wardHierarchicalClustering, type WardResult } from "@/lib/conceptAnalysis";

// A small, well-separated synthetic point set (no PII) — 6 points forming
// two obvious clusters, so cutting to k=2 has an unambiguous correct answer.
const points: [number, number][] = [
  [0, 0],
  [0.1, 0.1],
  [0.2, -0.1],
  [10, 10],
  [10.1, 9.9],
  [9.9, 10.2],
];
const statementIds = ["s0", "s1", "s2", "s3", "s4", "s5"];
let ward: WardResult;

function getWard(): WardResult {
  if (!ward) ward = wardHierarchicalClustering(points);
  return ward;
}

describe("cutClusters", () => {
  it("assigns exactly one cluster (1..k) to every statement", () => {
    const assignments = cutClusters(getWard(), statementIds, 2);
    expect(assignments).toHaveLength(6);
    const indices = new Set(assignments.map((a) => a.clusterIndex));
    expect(indices).toEqual(new Set([1, 2]));
  });

  it("groups the two obvious synthetic clusters correctly at k=2", () => {
    const assignments = cutClusters(getWard(), statementIds, 2);
    const byId = new Map(assignments.map((a) => [a.statementId, a.clusterIndex]));
    expect(byId.get("s0")).toBe(byId.get("s1"));
    expect(byId.get("s1")).toBe(byId.get("s2"));
    expect(byId.get("s3")).toBe(byId.get("s4"));
    expect(byId.get("s4")).toBe(byId.get("s5"));
    expect(byId.get("s0")).not.toBe(byId.get("s3"));
  });

  it("is deterministic: repeated calls with the same linkage+k produce the same result", () => {
    const a = cutClusters(getWard(), statementIds, 3);
    const b = cutClusters(getWard(), statementIds, 3);
    expect(a).toEqual(b);
  });

  it("numbers clusters 1..k, ordered by first appearance in statement order", () => {
    const assignments = cutClusters(getWard(), statementIds, 2);
    expect(assignments[0].clusterIndex).toBe(1); // s0 is first in order -> always cluster 1
  });

  it("rejects k < 2", () => {
    expect(() => cutClusters(getWard(), statementIds, 1)).toThrow(RangeError);
  });

  it("rejects k > statementCount", () => {
    expect(() => cutClusters(getWard(), statementIds, 7)).toThrow(RangeError);
  });

  it("accepts k close to statementCount", () => {
    const assignments = cutClusters(getWard(), statementIds, 5);
    expect(new Set(assignments.map((a) => a.clusterIndex)).size).toBe(5);
  });
});

describe("computeCentroids", () => {
  it("computes the arithmetic mean of member coordinates per cluster", () => {
    const assignments = cutClusters(getWard(), statementIds, 2);
    const coordMap = new Map(statementIds.map((id, i) => [id, points[i]]));
    const centroids = computeCentroids(assignments, coordMap);
    expect(centroids).toHaveLength(2);
    for (const c of centroids) {
      const members = assignments.filter((a) => a.clusterIndex === c.clusterIndex);
      const expectedX = members.reduce((s, a) => s + coordMap.get(a.statementId)![0], 0) / members.length;
      const expectedY = members.reduce((s, a) => s + coordMap.get(a.statementId)![1], 0) / members.length;
      expect(c.x).toBeCloseTo(expectedX, 10);
      expect(c.y).toBeCloseTo(expectedY, 10);
      expect(c.memberCount).toBe(members.length);
    }
  });
});
