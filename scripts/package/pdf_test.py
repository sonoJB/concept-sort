import sys
import pymupdf

font_dir = "C:/Windows/Fonts"
html = """
<h1>시험 보고서 — 한국어와 日本語</h1>
<p>한국어 문장입니다. 日本語の文章です。ネットいじめ、虚偽・歪曲情報の拡散と評判の毀損。 Ⅰ Ⅱ Ⅲ Ⅳ σ₁ δ = 1 − S/N</p>
<table border="1" cellpadding="3"><tr><th>지표</th><th>값</th></tr><tr><td>Stress-1</td><td>0.3025</td></tr></table>
"""
css = """
@font-face { font-family: 'MG'; src: url('malgun.ttf'); }
@font-face { font-family: 'MG'; font-weight: bold; src: url('malgunbd.ttf'); }
body { font-family: 'MG'; font-size: 10pt; }
h1 { font-size: 16pt; }
table { border-collapse: collapse; } td, th { border: 0.5pt solid #444; padding: 3pt; }
"""
arch = pymupdf.Archive(font_dir)
story = pymupdf.Story(html=html, user_css=css, archive=arch)
w = pymupdf.DocumentWriter(sys.argv[1])
mediabox = pymupdf.paper_rect("a4")
where = mediabox + (50, 50, -50, -50)
more = True
while more:
    dev = w.begin_page(mediabox)
    more, _ = story.place(where)
    story.draw(dev)
    w.end_page()
w.close()
doc = pymupdf.open(sys.argv[1])
print(doc.page_count, repr(doc[0].get_text()[:120]))
print([f[3] for f in doc[0].get_fonts()])
