export const metadata = {
  title: "Bilingual Writer — MVP",
  description: "A minimal bilingual writer with inline translation",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      {/* 这里只是用了一些类名，不依赖 Tailwind 也能正常构建 */}
      <body style={{ margin: 0, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial" }}>
        {children}
      </body>
    </html>
  );
}
