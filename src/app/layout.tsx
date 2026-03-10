import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Atlas Treasury",
  description: "Treasury domain service for AtlasPayments",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
