/** Server-side render of the on-screen MapFigure to SVG (for visual QA and rasterisation), from a stored bundle. */
import { writeFileSync, readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { MapFigure } from "../../src/components/analysis/MapFigure";

const [bundleFile, outFile, kArg] = process.argv.slice(2);
const res = JSON.parse(readFileSync(bundleFile, "utf8"));
const bundle = res.bundle;
const proposal = bundle.naming.status === "ATTACHED" ? bundle.naming.proposal : null;
const k = Number(kArg ?? proposal?.recommendedK ?? 5);
const solution = bundle.analysis.solutions.find((s: { k: number }) => s.k === k);
const names = proposal && proposal.solution.k === k ? proposal.solution.clusters : null;
const markup = renderToStaticMarkup(
  createElement(MapFigure, {
    coordinates: bundle.analysis.primary.coordinates,
    solution,
    names,
    showQuadrants: true,
    showNumbers: true,
    showBoundaries: true,
    highlightCluster: null,
    title: `${bundle.meta.scope} k=${k}`,
  })
);
const vb = markup.match(/viewBox="0 0 (\d+) (\d+)"/)!;
writeFileSync(outFile, `<?xml version="1.0" encoding="UTF-8"?>
${markup.replace(/width="100%"/, `width="${vb[1]}" height="${vb[2]}"`)}`);
