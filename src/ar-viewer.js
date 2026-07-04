(function () {
  const config = window.AR_VIEWER_CONFIG;
  const scene = document.querySelector("a-scene");
  const startButton = document.querySelector("#startButton");
  const statusBox = document.querySelector("#status");
  const target = document.querySelector("#imageTarget");
  const video = document.querySelector("#arVideo");
  const overlay = target.querySelector("a-video");

  let hasStarted = false;

  scene.setAttribute(
    "mindar-image",
    `imageTargetSrc: ${config.target.src}; autoStart: false; uiScanning: yes; uiLoading: yes; uiError: yes;`
  );
  target.setAttribute("mindar-image-target", `targetIndex: ${config.target.index}`);

  video.src = config.video.src;
  video.loop = config.video.loop;
  video.muted = config.video.muted;
  video.playsInline = config.video.playsInline;
  video.toggleAttribute("loop", config.video.loop);
  video.toggleAttribute("muted", config.video.muted);
  video.toggleAttribute("playsinline", config.video.playsInline);
  video.toggleAttribute("webkit-playsinline", config.video.playsInline);

  overlay.setAttribute("width", config.overlay.width);
  overlay.setAttribute("height", config.overlay.height);
  overlay.setAttribute("position", config.overlay.position);
  overlay.setAttribute("rotation", config.overlay.rotation);

  statusBox.textContent = config.ui.initialText;
  startButton.textContent = config.ui.startButtonText;

  startButton.addEventListener("click", async () => {
    try {
      // iOS/Safari often requires a user gesture before media playback.
      await video.play();
      video.pause();
      video.currentTime = 0;

      const mindarSystem = scene.systems["mindar-image-system"];
      await mindarSystem.start();

      hasStarted = true;
      startButton.classList.add("hidden");
      statusBox.textContent = config.ui.scanningText;
    } catch (error) {
      console.error(error);
      statusBox.textContent = config.ui.errorText;
    }
  });

  target.addEventListener("targetFound", async () => {
    statusBox.textContent = config.ui.foundText;
    if (!hasStarted) return;
    if (config.video.autoplay) {
      try {
        await video.play();
      } catch (error) {
        console.warn("Video play was blocked", error);
      }
    }
  });

  target.addEventListener("targetLost", () => {
    statusBox.textContent = config.ui.lostText;
    video.pause();
  });
})();
