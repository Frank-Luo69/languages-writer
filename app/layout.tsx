import "./globals.css";
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
      {/* 引入全局样式，保持简约优雅 */}
      <body style={{ margin: 0, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial" }}>
        {children}
      </body>
    </html>
  );
}
