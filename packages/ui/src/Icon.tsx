import React from 'react';

/**
 * Small decorative line icons (M7.1). Always paired with visible or accessible text: the icon
 * itself is hidden from assistive technology and never carries meaning on its own.
 */
const PATHS = {
  console: 'M4 5h16v11H4z M8 20h8 M12 16v4 M8 9h5 M8 12h8',
  admin: 'M4 21V9l8-5 8 5v12 M9 21v-6h6v6 M4 21h16',
  collapse: 'M15 6l-6 6 6 6',
  expand: 'M9 6l6 6-6 6',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  alert: 'M12 4l9 16H3z M12 10v4 M12 17.5v.01',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 11v6 M12 7.5v.01',
} as const;

export type IconName = keyof typeof PATHS;

export interface IconProps {
  name: IconName;
  className?: string;
}

export function Icon({ name, className = 'nav-icon' }: IconProps): React.ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
