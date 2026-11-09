// Hidden sound page of the clock (#130). Plays one sound as the query string says, then closes its own window: after
// the last repeat, at the longest time, or when neither the sound nor its fallback can be played. The widget's main
// code closes the window to stop it sooner. No preload, no Node: the page only plays a local file.
(() => {
  const plan = window.SoundPlan.readPlan(location.search);
  const audio = new Audio();
  audio.volume = plan.volume;
  let played = 0;
  let attempt = 0;
  let usedFallback = false;
  let closed = false;

  function finish() {
    if (closed) return;
    closed = true;
    audio.pause();
    window.close();
  }

  function start(src) {
    const mine = ++attempt;
    const failed = () => {
      if (mine !== attempt) return; // already handled for this source
      attempt++;
      // A missing, broken or unsupported file plays the clock's own sound instead.
      if (!usedFallback && plan.fallback && src !== plan.fallback) {
        usedFallback = true;
        start(plan.fallback);
      } else finish();
    };
    audio.onerror = failed;
    audio.src = src;
    audio.play().catch(failed);
  }

  audio.addEventListener('ended', () => {
    played++;
    if (!window.SoundPlan.again(played, plan.repeat, Date.now(), plan.until)) return finish();
    audio.currentTime = 0;
    audio.play().catch(finish);
  });
  // Wall-clock check, so a sleep in the middle does not stretch the longest time.
  audio.addEventListener('timeupdate', () => {
    if (Date.now() >= plan.until) finish();
  });
  setTimeout(finish, Math.max(0, plan.until - Date.now()));

  if (plan.src && Date.now() < plan.until) start(plan.src);
  else finish();
})();
