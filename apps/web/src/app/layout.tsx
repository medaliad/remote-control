import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Remote Control",
  description: "Control another machine remotely over WebSocket",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
