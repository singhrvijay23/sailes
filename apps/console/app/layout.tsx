import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SAILES Console',
  description: 'Set up and manage your SAILES AI sales associate',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
