(function () {
  window.AR_LIBRARY = {
    version: 1,
    maxActiveTargets: 10,
    targetFile: "./assets/targets.mind",
    targets: [
      {
        id: "vicky",
        name: "Vicky",
        enabled: true,
        targetIndex: 0,
        imagePath: "./assets/target-image.png",
        overlayPath: "./assets/overlay-video.mp4",
        overlayType: "video",
        overlay: {
          width: 1.006,
          height: 1.455,
          position: "0 0 0.01",
          rotation: "0 0 0"
        },
        video: {
          autoplay: true,
          loop: true,
          muted: true,
          playsInline: true
        },
        updatedAt: "2026-07-04T00:00:00Z"
      }
    ]
  };
})();
