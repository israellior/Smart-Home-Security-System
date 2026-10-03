/**
 * The line icons the live view and the activity list share. One stroke
 * weight and one 24-unit grid, so a bell next to a play button reads as
 * one set rather than two borrowed ones. All decorative: every place that
 * uses one says the same thing in text beside it.
 */
function Icon({ size = 20, children, strokeWidth = 1.7 }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function BellIcon(props) {
  return (
    <Icon {...props}>
      <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16Z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </Icon>
  );
}

// Someone walking, for motion: the sensor fires on a person, not on
// "motion" in the abstract, and that is what the row is telling you.
export function MotionIcon(props) {
  return (
    <Icon {...props}>
      <circle cx="13" cy="4.5" r="1.8" />
      <path d="M9 21l2.2-5.2L13.5 18v3M11.2 15.8l1.3-6.3-3.3 1.6L8 14M12.5 9.5l2.2 2.5 3 .8" />
    </Icon>
  );
}

export function PlayIcon(props) {
  return (
    <Icon {...props} strokeWidth={0}>
      <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" fill="currentColor" />
    </Icon>
  );
}

export function CloseIcon(props) {
  return (
    <Icon {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Icon>
  );
}

export function CameraIcon(props) {
  return (
    <Icon {...props}>
      <rect x="3" y="6.5" width="13" height="11" rx="2.5" />
      <path d="M16 10.5l5-3v9l-5-3" />
    </Icon>
  );
}

export function CameraOffIcon(props) {
  return (
    <Icon {...props}>
      <path d="M8 6.5h5.5A2.5 2.5 0 0 1 16 9v4.5M16 16.2a2.5 2.5 0 0 1-2.5 1.3h-8A2.5 2.5 0 0 1 3 15V9a2.5 2.5 0 0 1 2-2.45" />
      <path d="M16 10.5l5-3v9l-3-1.8M3 3l18 18" />
    </Icon>
  );
}

export function WifiOffIcon(props) {
  return (
    <Icon {...props}>
      <path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 5.6-.9M5 12.8a10 10 0 0 1 4-2.4M19 12.8a10 10 0 0 0-3.3-2.2M2 9.3a15 15 0 0 1 3.6-2.4M22 9.3A15 15 0 0 0 11 5.1" />
      <circle cx="12" cy="20" r="0.6" fill="currentColor" />
    </Icon>
  );
}

export function AlertIcon(props) {
  return (
    <Icon {...props}>
      <path d="M12 3.5 2.5 20h19L12 3.5Z" />
      <path d="M12 10v4.5" />
      <circle cx="12" cy="17.3" r="0.6" fill="currentColor" />
    </Icon>
  );
}
