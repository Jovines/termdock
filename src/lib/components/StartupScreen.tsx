interface StartupScreenProps {
  className?: string;
  status?: string;
}

/**
 * Keep the web boot surface visually continuous with the iOS launch image.
 * The status is intentionally delayed in CSS so a normal cold start does not
 * replace the launch mark with a second, short-lived loading screen.
 */
export function StartupScreen({ className = '', status = 'Loading Termdock' }: StartupScreenProps) {
  return (
    <div className={`termdock-boot ${className}`.trim()} role="status" aria-live="polite">
      <img className="termdock-boot-logo" src="/boot-logo.png" alt="" aria-hidden="true" />
      <div className="termdock-boot-status">
        <div className="termdock-boot-spinner" aria-hidden="true" />
        <span>{status}</span>
      </div>
    </div>
  );
}
