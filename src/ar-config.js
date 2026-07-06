(function () {
  window.AR_VIEWER_CONFIG = {
    tracking: {
      smoothing: {
        enabled: true,
        filterMinCF: 0.001,
        filterBeta: 30,
        warmupTolerance: 5,
        missTolerance: 8
      }
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
