import { createBLGCollector } from './collector.js';

/** HTMLVideoElement adapter; iframe players need their official playback API, never a guessed position. */
export function instrumentMasterclass({ endpoint, pageVersion, video, videoId, videoVersion, bilanButton }) {
  const collector = createBLGCollector({ endpoint, tunnel: 'masterclass', pageVersion });
  const playbackId = crypto.randomUUID();
  const videoContext = { video_id: videoId, video_version: videoVersion, playback_id: playbackId };
  let registered = false, started = false, last = null, intervals = [];
  void collector.emit('landing_arrival');
  function flush() {
    if (!registered || !intervals.length || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const batch = intervals; intervals = [];
    void collector.emit('video_watch', { ...videoContext, duration: video.duration, intervals: batch });
  }
  function sample() {
    const now = performance.now(), position = video.currentTime;
    const active = registered && !video.paused && !video.ended && !video.seeking && !document.hidden;
    if (active && last && Number.isFinite(video.duration)) {
      const elapsed = (now - last.at) / 1000, delta = position - last.position;
      // A jump, hidden tab, long gap, playback-rate change or seek starts another interval.
      if (elapsed <= 2 && delta > 0 && delta <= elapsed * video.playbackRate + 0.35 && position <= video.duration) {
        intervals.push({ start: last.position, end: position });
        if (intervals.length >= 20) flush();
      }
    }
    last = active ? { position, at: now } : null;
  }
  const onPlay = () => { if (!registered) { video.pause(); return; } if (!started) { started = true; void collector.emit('video_started', videoContext); } last = null; };
  const discontinuity = () => { last = null; flush(); };
  const onBilan = () => { if (registered) void collector.emit('bilan_clicked'); };
  const onVisibility = () => { if (document.hidden) discontinuity(); };
  video.addEventListener('play', onPlay);
  for (const event of ['seeking', 'seeked', 'pause', 'ended', 'ratechange', 'waiting']) video.addEventListener(event, discontinuity);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', discontinuity);
  bilanButton?.addEventListener('click', onBilan);
  const timer = setInterval(sample, 500);
  return {
    collector,
    async submitOptin(saveExistingLead, formData, revealExistingVideo) {
      void collector.emit('masterclass_optin_submitted');
      const result = await saveExistingLead(formData, collector.context());
      if (!result || result.saved !== true) throw new Error('Registration not saved');
      registered = true; revealExistingVideo(result); return result;
    },
    dispose() {
      flush(); clearInterval(timer); video.removeEventListener('play', onPlay);
      for (const event of ['seeking', 'seeked', 'pause', 'ended', 'ratechange', 'waiting']) video.removeEventListener(event, discontinuity);
      document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('pagehide', discontinuity); bilanButton?.removeEventListener('click', onBilan);
    },
  };
}
