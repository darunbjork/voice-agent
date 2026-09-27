import type { CSSProperties, ReactNode } from "react";

export type GlassCardProps = {
  children: ReactNode;
  style?: CSSProperties;
  padding?: string;
};

export function GlassCard({ children, style, padding = "1.5rem" }: GlassCardProps) {
  return (
    <div
      style={{
        background: "var(--glass-bg)",
        backdropFilter: "var(--blur)",
        WebkitBackdropFilter: "var(--blur)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)",
        boxShadow: "var(--shadow-glass)",
        padding,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
