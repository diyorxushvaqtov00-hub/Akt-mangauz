import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title:"AI Manga Translator", description:"Translate manga chapters with AI — PDF in, translated PDF out." };
export default function RootLayout({children}:{children:React.ReactNode}) {
  return <html lang="uz"><body>{children}</body></html>;
}
