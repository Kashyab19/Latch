import type { ReactNode } from "react";

type IconProps = {
  size?: number;
  className?: string;
};

function Svg({
  size = 16,
  className,
  children,
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconMark({ size = 18, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <path d="M8 12h8" />
      <path d="M12 8v8" />
    </Svg>
  );
}

export function IconUser({ size = 16, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5.5 19a6.5 6.5 0 0 1 13 0" />
    </Svg>
  );
}

export function IconBot({ size = 16, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="5" y="7" width="14" height="11" rx="3" />
      <path d="M12 7V4" />
      <circle cx="9.5" cy="12.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="12.5" r="1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconTool({ size = 16, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M14.5 5.5a3.5 3.5 0 0 0-4.95 4.95L4 16v4h4l5.55-5.55A3.5 3.5 0 0 0 14.5 5.5Z" />
      <path d="m12.5 7.5 4 4" />
    </Svg>
  );
}

export function IconSend({ size = 16, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M5 12h13" />
      <path d="m12 5 7 7-7 7" />
    </Svg>
  );
}

export function IconCheck({ size = 16, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M5 12.5 9.5 17 19 7" />
    </Svg>
  );
}

export function IconX({ size = 16, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M7 7l10 10" />
      <path d="M17 7 7 17" />
    </Svg>
  );
}

export function IconSpark({ size = 16, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M12 4v3" />
      <path d="M12 17v3" />
      <path d="M4 12h3" />
      <path d="M17 12h3" />
      <circle cx="12" cy="12" r="3.5" />
    </Svg>
  );
}

export function IconLock({ size = 16, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </Svg>
  );
}

export function IconEye({ size = 16, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.5" />
    </Svg>
  );
}

export function IconArrow({ size = 14, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M5 12h12" />
      <path d="m13 6 6 6-6 6" />
    </Svg>
  );
}

export function IconPause({ size = 14, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <rect x="7" y="6" width="3.5" height="12" rx="1" fill="currentColor" stroke="none" />
      <rect x="13.5" y="6" width="3.5" height="12" rx="1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconFlowDown({ size = 12, className }: IconProps) {
  return (
    <Svg size={size} className={className}>
      <path d="M12 5v11" />
      <path d="m8 12 4 4 4-4" />
    </Svg>
  );
}
