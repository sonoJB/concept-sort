import type { Metadata } from "next";
import { Geist, Geist_Mono, Noto_Sans_KR, Noto_Sans_JP } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Self-hosted CJK fonts, served by the app itself — participant rendering
// must not depend on the OS having a suitable Hangul/kana/kanji fallback
// font installed. Only the weights Tailwind's font-* utilities actually use
// across participant-facing UI are requested (normal/medium/semibold/bold).
const notoSansKR = Noto_Sans_KR({
  variable: "--font-noto-kr",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  preload: false,
});

const notoSansJP = Noto_Sans_JP({
  variable: "--font-noto-jp",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  preload: false,
});

export const metadata: Metadata = {
  title: "유사성 분류 · 개념도 연구 도구",
  description: "카드 소팅으로 유사성을 분류하고 개념도를 시각화하는 도구",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ko"
      className={`${geistSans.variable} ${geistMono.variable} ${notoSansKR.variable} ${notoSansJP.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-slate-50 text-slate-900">
        {children}
      </body>
    </html>
  );
}
