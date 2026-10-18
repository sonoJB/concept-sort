"""Unit tests for the package builder's text handling (run: python -X utf8 -m unittest test_report_escaping -v from this folder).
Replaces the removed HTML/SVG escaping tests for the old export code."""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402

from common import canonical_hash, derive  # noqa: E402
from report import number_figs, render_html, render_md  # noqa: E402
from tables import matrix_rows  # noqa: E402

XSS = '<script>alert("x")</script>'


class ReportEscaping(unittest.TestCase):
    def test_html_never_contains_a_live_script_tag(self):
        blocks = [("h1", XSS), ("p", XSS), ("note", XSS), ("ul", [XSS]), ("table", [XSS], [[XSS]]), ("fig", "08_그림/a.png", XSS), ("refs", [{"apa": XSS, "access": XSS, "accessNoteKo": XSS}])]
        html = render_html(blocks)
        self.assertNotIn("<script>", html)
        self.assertIn("&lt;script&gt;", html)

    def test_markdown_table_cells_cannot_break_the_table(self):
        md = render_md([("table", ["a|b"], [["x|y\nz"]])])
        self.assertIn("x\\|y z", md)

    def test_figures_are_numbered_in_order_of_appearance(self):
        out = number_figs([("fig", "a.png", "그림 5. 첫째"), ("p", "x"), ("fig", "b.png", "그림 2. 둘째"), ("fig", "c.png", "셋째")])
        self.assertEqual([b[2] for b in out if b[0] == "fig"], ["그림 1. 첫째", "그림 2. 둘째", "그림 3. 셋째"])


class MatrixAndHash(unittest.TestCase):
    def test_derived_matrices_follow_the_stated_formulas(self):
        S = np.array([[4, 3, 0], [3, 4, 1], [0, 1, 4]], dtype=float)
        P, D, delta = derive(S, 4)
        self.assertTrue((np.diag(P) == 1).all() and (np.diag(D) == 0).all() and (np.diag(delta) == 0).all())
        self.assertAlmostEqual(delta[0, 1], 0.25)
        self.assertEqual(D[0, 2], 4)
        h, rows = matrix_rows(P)
        self.assertEqual(h[0], "문항")
        self.assertEqual(rows[1][1], 0.75)

    def test_canonical_hash_matches_the_javascript_rules(self):
        # keys sorted, integers without a decimal point, -0 canonicalised to 0, strings JSON-escaped
        self.assertEqual(canonical_hash({"b": 1, "a": [1.0, -0.0, "한"]}), canonical_hash({"a": [1, 0, "한"], "b": 1}))
        with self.assertRaises(ValueError):
            canonical_hash({"a": float("nan")})


if __name__ == "__main__":
    unittest.main()
