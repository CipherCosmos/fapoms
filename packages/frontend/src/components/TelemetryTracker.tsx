import React, { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { track, trackPageView, flushTelemetry, describeClickTarget } from '../services/telemetry';

/**
 * Records the signed-in person's UI activity — page views and the controls they use — as privacy-
 * safe telemetry. Renders nothing; it is a listener mounted once inside the authenticated shell.
 *
 * Page views follow the router. Clicks are captured with a single delegated listener that records
 * only a control's descriptor (never a field's contents — see `describeClickTarget`). The queue is
 * flushed when the tab is hidden so a session's last actions are not lost on navigation away.
 */
export const TelemetryTracker: React.FC = () => {
  const location = useLocation();

  useEffect(() => {
    trackPageView(location.pathname);
  }, [location.pathname]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const label = describeClickTarget(e.target as Element | null);
      if (label) track({ eventType: 'ACTION', path: window.location.pathname, label });
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void flushTelemetry();
    };
    // Capture phase so the descriptor is read before a handler can navigate the element away.
    document.addEventListener('click', onClick, true);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('visibilitychange', onVisibility);
      void flushTelemetry();
    };
  }, []);

  return null;
};

export default TelemetryTracker;
