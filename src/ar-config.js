(function () {
  window.AR_VIEWER_CONFIG = {
    target: {
      src: "./assets/targets.mind",
      index: 0,
      aspectRatio: 1447 / 2048
    },
    video: {
      src: "./assets/overlay-video.mp4",
      autoplay: true,
      loop: true,
      muted: true,
      playsInline: true
    },
    overlay: {
      width: 1.006,
      height: 1.455,
      position: "0 0 0.01",
      rotation: "0 0 15.9"
    },
    ui: {
      initialText: "กดเริ่ม แล้วส่องกล้องไปที่รูปที่ปริ้นไว้ ✨",
      startButtonText: "เริ่ม AR",
      scanningText: "ส่องรูปเป้าหมายให้เต็มจอหน่อยนึงนะ",
      foundText: "เจอรูปแล้ว! วิดีโอกำลังเล่น ✨",
      lostText: "รูปหลุดจากกล้องแล้ว ลองขยับมือถือช้า ๆ",
      errorText: "เริ่มไม่ได้: เช็กว่าเปิดผ่าน HTTPS/localhost และอนุญาตกล้องแล้ว"
    }
  };
})();
